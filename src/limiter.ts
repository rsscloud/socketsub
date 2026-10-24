export function createLimiter(max: number) {
    let active = 0;
    const waiting: (() => void)[] = [];
    return async <T>(task: () => Promise<T>): Promise<T> => {
        if (active >= max) await new Promise<void>(r => waiting.push(r));
        else active++;
        try {
            return await task();
        } finally {
            const next = waiting.shift();
            if (next) next();
            else active--;
        }
    };
}
