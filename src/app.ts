import { readFileSync } from 'node:fs';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { Config } from './config.js';
import { createFetcher, type Lookup } from './net.js';
import { createRegistry } from './registry.js';
import { rssCloudRoutes } from './rsscloud.js';
import { webSubRoutes } from './websub.js';
import { wsHandler } from './ws.js';

const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

export type AppDeps = {
    config: Config;
    fetch: typeof fetch;
    lookup: Lookup;
};

const testClientPage = readFileSync(
    new URL('../public/index.html', import.meta.url),
    'utf8'
);

export function createApp(deps: AppDeps) {
    const { config } = deps;
    const app = new Hono();
    const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({
        app
    });
    // @hono/node-ws takes no ws options, but ws reads maxPayload from
    // wss.options on each upgrade. Larger messages close with 1009.
    wss.options.maxPayload = MAX_WS_MESSAGE_BYTES;
    const fetcher = createFetcher({
        fetch: deps.fetch,
        lookup: deps.lookup,
        timeoutMs: config.fetchTimeoutMs,
        allowPrivateHosts: config.allowPrivateHosts
    });
    const registry = createRegistry({ config, fetcher });

    app.get('/', c => c.html(testClientPage));
    app.get('/health', c => c.json({ ok: true }));
    app.route('/rsscloud', rssCloudRoutes(registry));
    app.route('/websub', webSubRoutes(registry));
    app.get(
        '/ws',
        wsHandler(upgradeWebSocket, registry, config.maxFeedsPerMessage)
    );

    return { app, injectWebSocket, registry };
}
