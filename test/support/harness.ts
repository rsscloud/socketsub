import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Client, ServerMessage } from '../../src/registry.js';
import { createFakeNet } from './fake-net.js';

export function testConfig(env: Record<string, string> = {}) {
    return loadConfig({ PUBLIC_URL: 'https://sub.example', ...env });
}

export function setup(env: Record<string, string> = {}) {
    const net = createFakeNet();
    const config = testConfig(env);
    const created = createApp({ config, fetch: net.fetch });
    return { net, config, ...created };
}

export type RecordingClient = Client & { messages: ServerMessage[] };

export function recordingClient(): RecordingClient {
    const messages: ServerMessage[] = [];
    return { messages, send: message => void messages.push(message) };
}

export async function settle(rounds = 20) {
    for (let i = 0; i < rounds; i++) await setImmediate();
}

export async function listen(app: ReturnType<typeof setup>) {
    const server = serve({ fetch: app.app.fetch, port: 0 }) as Server;
    app.injectWebSocket(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `ws://127.0.0.1:${port}/ws`,
        close: () =>
            new Promise<void>(resolve => {
                server.close(() => resolve());
                server.closeAllConnections();
            })
    };
}

export class WsClient {
    readonly messages: ServerMessage[] = [];
    private waiters: (() => void)[] = [];
    private constructor(readonly socket: WebSocket) {
        socket.addEventListener('message', event => {
            this.messages.push(JSON.parse(String(event.data)) as ServerMessage);
            for (const wake of this.waiters.splice(0)) wake();
        });
    }

    static async connect(url: string): Promise<WsClient> {
        const socket = new WebSocket(url);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        return new WsClient(socket);
    }

    send(value: unknown) {
        this.socket.send(
            typeof value === 'string' ? value : JSON.stringify(value)
        );
    }

    async waitFor(
        predicate: (messages: ServerMessage[]) => boolean,
        timeoutMs = 2000
    ): Promise<ServerMessage[]> {
        const deadline = Date.now() + timeoutMs;
        while (!predicate(this.messages)) {
            if (Date.now() > deadline) {
                throw new Error(
                    `timed out; got ${JSON.stringify(this.messages)}`
                );
            }
            await new Promise<void>(resolve => {
                this.waiters.push(resolve);
                globalThis.setTimeout(resolve, 50);
            });
        }
        return this.messages;
    }

    async close() {
        if (this.socket.readyState === WebSocket.CLOSED) return;
        const closed = new Promise(r =>
            this.socket.addEventListener('close', r, { once: true })
        );
        this.socket.close();
        await closed;
    }
}

export type Setup = ReturnType<typeof setup>;

type CloudOptions = {
    format?: 'json' | 'xml';
    refuse?: string;
};

export function fakeCloud(
    env: Setup,
    endpoint: string,
    opts: CloudOptions = {}
) {
    const challenges: { status: number; body: string }[] = [];
    env.net.on(endpoint, async request => {
        let success = false;
        let msg = opts.refuse ?? '';
        if (opts.refuse === undefined) {
            const query = new URLSearchParams({
                url: request.form.get('url1') ?? '',
                challenge: 'c-123'
            });
            const res = await env.app.request(
                `${request.form.get('path')}?${query}`
            );
            const body = await res.text();
            challenges.push({ status: res.status, body });
            success = res.status === 200 && body === 'c-123';
            msg = success
                ? 'Thanks for the registration.'
                : 'The subscription was cancelled because the call failed when we tested the handler.';
        }
        if (opts.format === 'xml') {
            return new Response(
                `<?xml version="1.0"?>\n<notifyResult success="${success}" msg="${msg}"/>`,
                { headers: { 'content-type': 'text/xml' } }
            );
        }
        return Response.json({ success, msg });
    });
    return { requests: () => env.net.to(endpoint), challenges };
}

export function fakeHub(env: Setup, hubUrl: string, status = 202) {
    env.net.on(hubUrl, () => new Response(null, { status }));
    const requests = () => env.net.to(hubUrl);
    return {
        requests,
        subscribes: () =>
            requests().filter(r => r.form.get('hub.mode') === 'subscribe'),
        unsubscribes: () =>
            requests().filter(r => r.form.get('hub.mode') === 'unsubscribe'),
        async verify(
            request: { form: URLSearchParams } | undefined,
            overrides: Record<string, string> = {}
        ) {
            if (!request) throw new Error('no hub request to verify');
            const callback = new URL(request.form.get('hub.callback') ?? '');
            const query = new URLSearchParams({
                'hub.mode': request.form.get('hub.mode') ?? '',
                'hub.topic': request.form.get('hub.topic') ?? '',
                'hub.challenge': 'hub-challenge',
                'hub.lease_seconds':
                    request.form.get('hub.lease_seconds') ?? '86400',
                ...overrides
            });
            return env.app.request(`${callback.pathname}?${query}`);
        },
        deliver(
            request: { form: URLSearchParams } | undefined,
            body: string,
            signature: (secret: string, body: string) => string | undefined
        ) {
            if (!request) throw new Error('no hub request to deliver to');
            const callback = new URL(request.form.get('hub.callback') ?? '');
            const header = signature(
                request.form.get('hub.secret') ?? '',
                body
            );
            return env.app.request(callback.pathname, {
                method: 'POST',
                headers: header ? { 'x-hub-signature': header } : {},
                body
            });
        }
    };
}
