import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { systemLookup } from './net.js';

const config = loadConfig(process.env);
const { app, injectWebSocket } = createApp({
    config,
    fetch: globalThis.fetch,
    lookup: systemLookup,
    now: Date.now,
    random: Math.random
});

const server = serve({ fetch: app.fetch, port: config.port }, info => {
    console.log(
        `socketsub listening on :${info.port} (public ${config.publicUrl.href})`
    );
});
injectWebSocket(server);
