const BASE_COOLDOWN_MS = 60_000;
const COOLDOWN_FACTOR = 2;
const MAX_COOLDOWN_MS = 3600_000;
const JITTER = 0.2;
const MAX_RETRY_AFTER_MS = 6 * 3600_000;
const MAX_TRACKED_ORIGINS = 10_000;
// Requests waiting on one origin retry at random points across this window
// after its cooldown, instead of all at the instant it ends.
const RETRY_SPREAD_MS = 60_000;
// The last renewal attempt runs this long before the subscription lapses.
const LAST_ATTEMPT_MARGIN_MS = 5 * 60_000;
// Below this, a deferred last attempt has no time left to wait for a slot.
const MIN_LAST_ATTEMPT_WINDOW_MS = 1000;

import type { RequestFailure } from './net.js';

export type Clock = { now(): number; random(): number };

export type Exchange =
    | { kind: 'answered'; status: number; retryAfter: string | null }
    | { kind: 'unreachable' }
    | { kind: 'not-sent' };

export type Admission =
    | { admitted: true; finish(exchange: Exchange): void }
    | { admitted: false; until: number };

export type Retry = { at: number; lastChance: boolean };

export type Backoff = {
    begin(origin: string, lastChance: boolean): Admission;
    cooldownEnd(origin: string): number | undefined;
    retryAt(
        origin: string,
        deadline: number,
        failure: RequestFailure,
        lastChance: boolean
    ): Retry | undefined;
};

// `mark` is the last request ticket issued when the streak last failed:
// an outcome from a ticket at or below it started before that failure, so
// it says nothing new about the origin.
type Streak =
    | {
          kind: 'cooling';
          failures: number;
          until: number;
          mark: number;
          probe?: number;
      }
    // Answering again, but a new failure resumes from the remembered
    // count rather than the shortest cooldown.
    | { kind: 'recovered'; failures: number; mark: number; since: number };

export function createBackoff(clock: Clock): Backoff {
    const streaks = new Map<string, Streak>();
    let tickets = 0;

    // A streak nobody retried for an hour past its cooldown is stale.
    function isStale(streak: Streak, now: number): boolean {
        if (streak.kind === 'recovered') {
            return now >= streak.since + MAX_COOLDOWN_MS;
        }
        return (
            streak.probe === undefined && now >= streak.until + MAX_COOLDOWN_MS
        );
    }

    // Map order is update order, so the first entry is the one updated
    // longest ago; stale entries are otherwise dropped only when read.
    function track(origin: string, streak: Streak) {
        streaks.delete(origin);
        streaks.set(origin, streak);
        if (streaks.size > MAX_TRACKED_ORIGINS) {
            streaks.delete(streaks.keys().next().value!);
        }
    }

    function current(origin: string, now: number): Streak | undefined {
        const streak = streaks.get(origin);
        if (streak && isStale(streak, now)) {
            streaks.delete(origin);
            return undefined;
        }
        return streak;
    }

    function cooldownEnd(origin: string): number | undefined {
        const now = clock.now();
        const streak = current(origin, now);
        if (streak?.kind !== 'cooling') return undefined;
        if (streak.until > now) return streak.until;
        // One request probes a recovering origin; the rest wait for it.
        return streak.probe !== undefined ? now + BASE_COOLDOWN_MS : undefined;
    }

    function recover(origin: string, streak: Streak) {
        const failures = Math.floor(streak.failures / COOLDOWN_FACTOR);
        if (failures === 0) {
            streaks.delete(origin);
            return;
        }
        track(origin, {
            kind: 'recovered',
            failures,
            mark: streak.mark,
            since: clock.now()
        });
    }

    function fail(origin: string, failures: number, retryAfter: number) {
        const now = clock.now();
        const computed =
            Math.min(
                MAX_COOLDOWN_MS,
                BASE_COOLDOWN_MS * COOLDOWN_FACTOR ** (failures - 1)
            ) *
            (1 + JITTER * (2 * clock.random() - 1));
        const delay = Math.min(
            MAX_RETRY_AFTER_MS,
            Math.max(computed, retryAfter)
        );
        track(origin, {
            kind: 'cooling',
            failures,
            until: now + delay,
            mark: tickets
        });
    }

    function finish(origin: string, ticket: number, exchange: Exchange) {
        const streak = current(origin, clock.now());
        if (streak?.kind === 'cooling' && streak.probe === ticket) {
            delete streak.probe;
        }
        if (exchange.kind === 'not-sent') return;
        if (streak && ticket <= streak.mark) return;
        if (exchange.kind === 'answered' && !isServerTrouble(exchange.status)) {
            if (streak) recover(origin, streak);
            return;
        }
        fail(
            origin,
            (streak?.failures ?? 0) + 1,
            exchange.kind === 'answered'
                ? retryAfterMs(exchange, clock.now())
                : 0
        );
    }

    return {
        cooldownEnd,

        // When to retry a request that must succeed before `deadline`:
        // after the cooldown, or the shortest one if there is none, and
        // once more just before the deadline if the cooldown runs past it.
        retryAt(origin, deadline, failure, lastChance) {
            if (failure === 'refused') return undefined;
            if (lastChance && failure !== 'deferred') return undefined;
            const now = clock.now();
            const final = deadline - LAST_ATTEMPT_MARGIN_MS;
            const end = cooldownEnd(origin) ?? now + BASE_COOLDOWN_MS;
            const at = end + clock.random() * RETRY_SPREAD_MS;
            if (at < final) return { at, lastChance: false };
            if (now < final) return { at: final, lastChance: true };
            const left = deadline - now;
            if (left < MIN_LAST_ATTEMPT_WINDOW_MS) return undefined;
            return { at: now + clock.random() * left, lastChance: true };
        },

        begin(origin, lastChance) {
            const end = cooldownEnd(origin);
            const streak = current(origin, clock.now());
            // A last attempt may probe an origin still cooling down, but
            // never alongside another probe.
            const mayProbe =
                lastChance &&
                streak?.kind === 'cooling' &&
                streak.probe === undefined;
            if (end !== undefined && !mayProbe) {
                return { admitted: false, until: end };
            }
            const ticket = ++tickets;
            if (streak?.kind === 'cooling') streak.probe = ticket;
            return {
                admitted: true,
                finish: exchange => finish(origin, ticket, exchange)
            };
        }
    };
}

export function isServerTrouble(status: number): boolean {
    return status >= 500 || status === 429;
}

function retryAfterMs(
    exchange: { status: number; retryAfter: string | null },
    now: number
): number {
    const header = exchange.retryAfter?.trim();
    if (!header || (exchange.status !== 429 && exchange.status !== 503)) {
        return 0;
    }
    const ms = /^\d+$/.test(header)
        ? Number(header) * 1000
        : Date.parse(header) - now;
    return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}
