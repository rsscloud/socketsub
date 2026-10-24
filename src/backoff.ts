const BASE_COOLDOWN_MS = 60_000;
const COOLDOWN_FACTOR = 2;
const MAX_COOLDOWN_MS = 3600_000;
const JITTER = 0.2;
const MAX_RETRY_AFTER_MS = 6 * 3600_000;

export type Clock = { now(): number; random(): number };

export type Exchange =
    | { kind: 'answered'; status: number; retryAfter: string | null }
    | { kind: 'unreachable' }
    | { kind: 'not-sent' };

export type Attempt = { finish(exchange: Exchange): void };

export type RetryPlan =
    { kind: 'retry'; at: number } | { kind: 'refused' } | { kind: 'too-late' };

export type Backoff = {
    begin(origin: string): Attempt;
    cooldownEnd(origin: string): number | undefined;
    retryBefore(origin: string, deadline: number): RetryPlan;
};

export class CoolingDownError extends Error {
    constructor(origin: string, until: number) {
        super(
            `${origin} failed recently; not contacting it before ${new Date(until).toISOString()}`
        );
        this.name = 'CoolingDownError';
    }
}

type Streak = { failures: number; until: number; probing: boolean };

export function createBackoff(clock: Clock): Backoff {
    const streaks = new Map<string, Streak>();

    // A streak nobody retried for an hour past its cooldown is stale.
    function isStale(streak: Streak, now: number): boolean {
        return !streak.probing && now >= streak.until + MAX_COOLDOWN_MS;
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
        if (!streak) return undefined;
        if (streak.until > now) return streak.until;
        // One request probes a recovering origin; the rest wait for it.
        return streak.probing ? now + BASE_COOLDOWN_MS : undefined;
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
        streaks.set(origin, { failures, until: now + delay, probing: false });
        for (const [key, streak] of streaks) {
            if (isStale(streak, now)) streaks.delete(key);
        }
    }

    return {
        cooldownEnd,

        // Read right after a request failed: only a transient failure leaves
        // its origin cooling down, so no cooldown means a refusal.
        retryBefore(origin, deadline) {
            const end = cooldownEnd(origin);
            if (end === undefined) return { kind: 'refused' };
            return end < deadline
                ? { kind: 'retry', at: end }
                : { kind: 'too-late' };
        },

        begin(origin) {
            const end = cooldownEnd(origin);
            if (end !== undefined) throw new CoolingDownError(origin, end);
            const streak = streaks.get(origin);
            if (streak) streak.probing = true;
            return {
                finish(exchange) {
                    if (exchange.kind === 'not-sent') {
                        if (streak) streak.probing = false;
                        return;
                    }
                    if (
                        exchange.kind === 'answered' &&
                        !isServerTrouble(exchange.status)
                    ) {
                        streaks.delete(origin);
                        return;
                    }
                    const latest = streaks.get(origin);
                    // Requests already in flight when the origin started
                    // failing count as one failure, not one each.
                    if (latest && latest !== streak) return;
                    fail(
                        origin,
                        (latest?.failures ?? 0) + 1,
                        exchange.kind === 'answered'
                            ? retryAfterMs(exchange, clock.now())
                            : 0
                    );
                }
            };
        }
    };
}

function isServerTrouble(status: number): boolean {
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
