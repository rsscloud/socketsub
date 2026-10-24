type Lane = { active: number; waiting: (() => void)[] };

export function createKeyedLimiter(max: number) {
    const lanes = new Map<string, Lane>();
    return async <T>(key: string, task: () => Promise<T>): Promise<T> => {
        let lane = lanes.get(key);
        if (!lane) lanes.set(key, (lane = { active: 0, waiting: [] }));
        if (lane.active >= max) {
            await new Promise<void>(resolve => lane.waiting.push(resolve));
        } else {
            lane.active++;
        }
        try {
            return await task();
        } finally {
            const next = lane.waiting.shift();
            if (next) next();
            else if (--lane.active === 0) lanes.delete(key);
        }
    };
}

export function createLimiter(max: number) {
    const limit = createKeyedLimiter(max);
    return <T>(task: () => Promise<T>): Promise<T> => limit('', task);
}
