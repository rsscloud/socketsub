const BASE_COOLDOWN_MS = 60_000;
const COOLDOWN_FACTOR = 2;
const MAX_COOLDOWN_MS = 3600_000;
const JITTER = 0.2;
const MAX_RETRY_AFTER_MS = 6 * 3600_000;
// Requests waiting on one origin retry at random points across this window
// after its cooldown, instead of all at the instant it ends.
const RETRY_SPREAD_MS = 60_000;

export type Clock = { now(): number; random(): number };

export type Exchange =
    | { kind: 'answered'; status: number; retryAfter: string | null }
    | { kind: 'unreachable' }
    | { kind: 'not-sent' };

export type Admission =
    | { admitted: true; finish(exchange: Exchange): void }
    | { admitted: false; until: number };

export type Backoff = {
    begin(origin: string): Admission;
    cooldownEnd(origin: string): number | undefined;
    retryAt(origin: string, deadline: number): number | undefined;
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
        streaks.set(origin, {
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
        streaks.set(origin, {
            kind: 'cooling',
            failures,
            until: now + delay,
            mark: tickets
        });
        for (const [key, streak] of streaks) {
            if (isStale(streak, now)) streaks.delete(key);
        }
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

        // When to retry after a transient failure: never sooner than the
        // shortest cooldown, even if the origin is not cooling down.
        retryAt(origin, deadline) {
            const end = cooldownEnd(origin) ?? clock.now() + BASE_COOLDOWN_MS;
            const at = end + clock.random() * RETRY_SPREAD_MS;
            return at < deadline ? at : undefined;
        },

        begin(origin) {
            const end = cooldownEnd(origin);
            if (end !== undefined) return { admitted: false, until: end };
            const ticket = ++tickets;
            const streak = streaks.get(origin);
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
