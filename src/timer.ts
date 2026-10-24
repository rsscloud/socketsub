// Node fires any longer setTimeout after 1 ms.
export const MAX_TIMER_MS = 2 ** 31 - 1;

export type Timer = ReturnType<typeof setTimeout>;

export function schedule(task: () => void, delayMs: number): Timer {
    return setTimeout(task, Math.min(delayMs, MAX_TIMER_MS));
}
