import { Hono } from 'hono';
import type { Config } from './config.js';

export type AppDeps = {
    config: Config;
    fetch: typeof fetch;
};

export function createApp(_deps: AppDeps) {
    const app = new Hono();
    app.get('/health', c => c.json({ ok: true }));
    return { app };
}
