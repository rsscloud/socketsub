import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from './support/fake-net.js';
import type { ServerMessage } from '../src/registry.js';
import { fakeCloud, listen, setup, WsClient } from './support/harness.js';

const FEED = 'https://blog.example/feed.xml';
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function start(env: Record<string, string> = {}) {
    const app = setup(env);
    const server = await listen(app);
    cleanup.push(server.close);
    const connect = async () => {
        const client = await WsClient.connect(server.url);
        cleanup.push(() => client.close());
        return client;
    };
    return { ...app, connect };
}

describe('websocket protocol', () => {
    it('streams status messages for each feed in the array', async () => {
        const { net, connect } = await start();
        net.feed(FEED, fixture('none.xml'));
        const client = await connect();
        client.send([FEED]);
        const messages = await client.waitFor(m => m.length >= 2);
        expect(messages).toEqual([
            { type: 'status', url: FEED, state: 'pending' },
            {
                type: 'status',
                url: FEED,
                state: 'unsupported',
                detail: 'feed advertises neither rssCloud nor WebSub'
            }
        ]);
    });

    it.each([
        ['invalid JSON', '{nope', 'message is not valid JSON'],
        [
            'an object',
            { url: FEED },
            'message must be a JSON array of URL strings'
        ],
        [
            'a non-string entry',
            [FEED, 42],
            'message must be a JSON array of URL strings'
        ]
    ])('rejects %s with an error message', async (_label, payload, message) => {
        const { connect } = await start();
        const client = await connect();
        client.send(payload);
        expect(await client.waitFor(m => m.length >= 1)).toEqual([
            { type: 'error', message }
        ]);
    });

    it('enforces MAX_FEEDS_PER_MESSAGE', async () => {
        const { net, connect } = await start({ MAX_FEEDS_PER_MESSAGE: '2' });
        const client = await connect();
        client.send([
            'https://a.example/',
            'https://b.example/',
            'https://c.example/'
        ]);
        expect(await client.waitFor(m => m.length >= 1)).toEqual([
            { type: 'error', message: 'too many feeds in one message (3 > 2)' }
        ]);
        expect(net.requests).toHaveLength(0);
    });

    it('delivers updates to each socket with its own URL string', async () => {
        const env = await start();
        env.net.feed(FEED, fixture('rss-cloud.xml'));
        fakeCloud(env, 'http://rpc.rsscloud.example:5337/pleaseNotify');
        const a = await env.connect();
        const b = await env.connect();
        a.send([FEED]);
        b.send(['https://blog.example/feed.xml#b']);
        const subscribed = (m: ServerMessage[]) =>
            m.some(x => x.type === 'status' && x.state === 'subscribed');
        await a.waitFor(subscribed);
        await b.waitFor(subscribed);
        await env.app.request('/rsscloud/notify', {
            method: 'POST',
            body: new URLSearchParams({ url: FEED })
        });
        await a.waitFor(m => m.some(x => x.type === 'update'));
        await b.waitFor(m => m.some(x => x.type === 'update'));
        expect(a.messages.at(-1)).toEqual({ type: 'update', url: FEED });
        expect(b.messages.at(-1)).toEqual({
            type: 'update',
            url: 'https://blog.example/feed.xml#b'
        });
        expect(env.net.to(FEED)).toHaveLength(1);
    });

    it('drops the feed when the last socket closes', async () => {
        const { net, connect } = await start();
        net.feed(FEED, fixture('none.xml'));
        const first = await connect();
        first.send([FEED]);
        await first.waitFor(m => m.length >= 2);
        await first.close();

        const second = await connect();
        second.send([FEED]);
        await second.waitFor(m => m.length >= 2);
        expect(net.to(FEED)).toHaveLength(2);
    });
});
