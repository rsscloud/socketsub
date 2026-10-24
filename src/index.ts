import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const { app, injectWebSocket } = createApp({ config, fetch: globalThis.fetch });

const server = serve({ fetch: app.fetch, port: config.port }, info => {
    console.log(
        `socketsub listening on :${info.port} (public ${config.publicUrl.href})`
    );
});
injectWebSocket(server);
