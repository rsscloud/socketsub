import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { Config } from './config.js';
import { createFetcher } from './net.js';
import { createRegistry } from './registry.js';
import { wsHandler } from './ws.js';

export type AppDeps = {
    config: Config;
    fetch: typeof fetch;
};

export function createApp(deps: AppDeps) {
    const { config } = deps;
    const app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    const fetcher = createFetcher({
        fetch: deps.fetch,
        timeoutMs: config.fetchTimeoutMs
    });
    const registry = createRegistry({ config, fetcher });

    app.get('/health', c => c.json({ ok: true }));
    app.get(
        '/ws',
        wsHandler(upgradeWebSocket, registry, config.maxFeedsPerMessage)
    );

    return { app, injectWebSocket, registry };
}
