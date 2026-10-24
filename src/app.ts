import { readFileSync } from 'node:fs';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { webSocketUrl, type Config } from './config.js';
import { createFetcher, type Lookup } from './net.js';
import { createRegistry } from './registry.js';
import { rssCloudRoutes } from './rsscloud/routes.js';
import { webSubRoutes } from './websub/routes.js';
import { wsHandler } from './ws.js';

const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

export type AppDeps = {
    config: Config;
    fetch: typeof fetch;
    lookup: Lookup;
};

function readPage(name: string): string {
    return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

const homeTemplate = readPage('index.html');
const docsTemplate = readPage('docs.html');

function renderPage(template: string, config: Config): string {
    const values: Record<string, string> = {
        wsUrl: webSocketUrl(config),
        maxFeedsPerMessage: String(config.maxFeedsPerMessage),
        maxFeedsPerClient: String(config.maxFeedsPerClient),
        maxFeeds: String(config.maxFeeds)
    };
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
        key in values ? escapeHtml(values[key] ?? '') : match
    );
}

function escapeHtml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

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

    const homePage = renderPage(homeTemplate, config);
    const docsPage = renderPage(docsTemplate, config);

    app.get('/', c => c.html(homePage));
    app.get('/docs', c => c.html(docsPage));
    app.get('/health', c => c.json({ ok: true }));
    app.route('/rsscloud', rssCloudRoutes(registry.rssCloud));
    app.route('/websub', webSubRoutes(registry.webSub));
    app.get(
        '/ws',
        wsHandler(upgradeWebSocket, registry, config.maxFeedsPerMessage)
    );

    return { app, injectWebSocket, registry };
}
