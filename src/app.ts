import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { Config } from './config.js';
import { createFetcher, type Lookup } from './net.js';
import { createRegistry } from './registry.js';
import { rsscloudRoutes } from './rsscloud.js';
import { websubRoutes } from './websub.js';
import { wsHandler } from './ws.js';

export type AppDeps = {
    config: Config;
    fetch: typeof fetch;
    lookup: Lookup;
};

export function createApp(deps: AppDeps) {
    const { config } = deps;
    const app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    const fetcher = createFetcher({
        fetch: deps.fetch,
        lookup: deps.lookup,
        timeoutMs: config.fetchTimeoutMs,
        allowPrivateHosts: config.allowPrivateHosts
    });
    const registry = createRegistry({ config, fetcher });

    app.get('/health', c => c.json({ ok: true }));
    app.route('/rsscloud', rsscloudRoutes(registry));
    app.route('/websub', websubRoutes(registry));
    app.get(
        '/ws',
        wsHandler(upgradeWebSocket, registry, config.maxFeedsPerMessage)
    );

    return { app, injectWebSocket, registry };
}
