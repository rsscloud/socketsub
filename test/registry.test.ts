import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { fixture, gate } from './support/fake-net.js';
import {
    fakeCloud,
    recordingClient,
    type RecordingClient,
    settle,
    setup
} from './support/harness.js';

const FEED = 'https://blog.example/feed.xml';

function cloudSetup() {
    const s = setup();
    fakeCloud(s, 'http://rpc.rsscloud.example:5337/pleaseNotify');
    return s;
}

describe('registry', () => {
    it('reports pending, then unsupported for a feed with no push protocol', async () => {
        const { net, registry } = setup();
        net.feed(FEED, fixture('none.xml'));
        const client = recordingClient();
        registry.subscribe(client, [FEED]);
        await settle();
        expect(client.messages).toEqual([
            { type: 'status', url: FEED, state: 'pending' },
            {
                type: 'status',
                url: FEED,
                state: 'unsupported',
                detail: 'feed advertises neither rssCloud nor WebSub'
            }
        ]);
    });

    it('fetches a feed once for two clients and answers each with its own string', async () => {
        const { net, registry } = cloudSetup();
        net.feed(FEED, fixture('rss-cloud.xml'));
        const a = recordingClient();
        const b = recordingClient();
        registry.subscribe(a, [FEED]);
        registry.subscribe(b, ['HTTPS://BLOG.EXAMPLE/feed.xml#top']);
        await settle();
        expect(net.to(FEED)).toHaveLength(1);

        registry.rssCloud.notify(FEED);
        expect(a.messages.at(-1)).toEqual({ type: 'update', url: FEED });
        expect(b.messages.at(-1)).toEqual({
            type: 'update',
            url: 'HTTPS://BLOG.EXAMPLE/feed.xml#top'
        });
    });

    it('gives a late client the current status immediately', async () => {
        const { net, registry } = setup();
        net.feed(FEED, fixture('none.xml'));
        registry.subscribe(recordingClient(), [FEED]);
        await settle();
        const late = recordingClient();
        registry.subscribe(late, [FEED]);
        expect(late.messages).toEqual([
            expect.objectContaining({ url: FEED, state: 'unsupported' })
        ]);
    });

    it('adds arrays to the client set instead of replacing it', async () => {
        const { net, registry } = cloudSetup();
        const other = 'https://other.example/rss';
        net.feed(FEED, fixture('rss-cloud.xml'));
        net.feed(other, fixture('rss-cloud.xml'));
        const client = recordingClient();
        registry.subscribe(client, [FEED]);
        registry.subscribe(client, [other]);
        await settle();
        client.messages.length = 0;
        registry.rssCloud.notify(FEED);
        registry.rssCloud.notify(other);
        expect(client.messages).toEqual([
            { type: 'update', url: FEED },
            { type: 'update', url: other }
        ]);
    });

    it('routes notifications for the redirect target to the original string', async () => {
        const { net, registry } = cloudSetup();
        net.on(
            'http://old.example/rss',
            () =>
                new Response(null, { status: 301, headers: { location: FEED } })
        );
        net.feed(FEED, fixture('rss-cloud.xml'));
        const client = recordingClient();
        registry.subscribe(client, ['http://old.example/rss']);
        await settle();
        registry.rssCloud.notify(FEED);
        expect(client.messages.at(-1)).toEqual({
            type: 'update',
            url: 'http://old.example/rss'
        });
    });

    it('reports invalid URLs per feed and still handles the rest', async () => {
        const { net, registry } = setup();
        net.feed(FEED, fixture('none.xml'));
        const client = recordingClient();
        registry.subscribe(client, ['not a url', 'ftp://x.example/feed', FEED]);
        expect(client.messages.slice(0, 2)).toEqual([
            {
                type: 'status',
                url: 'not a url',
                state: 'error',
                detail: 'not a valid http(s) URL'
            },
            {
                type: 'status',
                url: 'ftp://x.example/feed',
                state: 'error',
                detail: 'not a valid http(s) URL'
            }
        ]);
        await settle();
        expect(client.messages.at(-1)).toMatchObject({
            url: FEED,
            state: 'unsupported'
        });
    });

    it('reports an error when the feed cannot be fetched', async () => {
        const { registry } = setup();
        const client = recordingClient();
        registry.subscribe(client, [FEED]);
        await settle();
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'error',
            detail: 'feed returned HTTP 404'
        });
    });

    it('stops sending to a client after it leaves, even mid-discovery', async () => {
        const { net, registry } = setup();
        const held = gate();
        net.on(FEED, async () => {
            await held.wait();
            return new Response(fixture('none.xml'));
        });
        const client = recordingClient();
        registry.subscribe(client, [FEED]);
        await settle();
        registry.removeClient(client);
        held.release();
        await settle();
        expect(client.messages).toEqual([
            { type: 'status', url: FEED, state: 'pending' }
        ]);
    });

    it('caps the feeds one client can follow at MAX_FEEDS_PER_CLIENT', async () => {
        const { net, registry } = setup({ MAX_FEEDS_PER_CLIENT: '2' });
        const [a, b, c] = ['a', 'b', 'c'].map(n => `https://${n}.example/rss`);
        for (const url of [a, b, c]) net.feed(url!, fixture('none.xml'));
        const client = recordingClient();
        registry.subscribe(client, [a!, c!, b!, a!]);
        await settle();
        expect(client.messages).toContainEqual({
            type: 'status',
            url: b,
            state: 'error',
            detail: 'this connection already follows the maximum of 2 feeds'
        });
        expect(net.to(b!)).toHaveLength(0);
        expect(net.to(a!)).toHaveLength(1);
        expect(net.to(c!)).toHaveLength(1);
        expect(
            client.messages.filter(
                m => m.type === 'status' && m.state === 'error'
            )
        ).toHaveLength(1);
    });

    it('frees a per-client slot when the client unsubscribes', async () => {
        const { net, registry } = setup({ MAX_FEEDS_PER_CLIENT: '1' });
        const [a, b] = ['a', 'b'].map(n => `https://${n}.example/rss`);
        for (const url of [a, b]) net.feed(url!, fixture('none.xml'));
        const client = recordingClient();
        registry.subscribe(client, [a!]);
        await settle();
        registry.unsubscribe(client, [a!]);
        registry.subscribe(client, [b!]);
        await settle();
        expect(net.to(b!)).toHaveLength(1);
        expect(
            client.messages.filter(
                m => m.type === 'status' && m.state === 'error'
            )
        ).toHaveLength(0);
    });

    it('caps the feeds the server follows at MAX_FEEDS', async () => {
        const { net, registry } = setup({ MAX_FEEDS: '1' });
        const other = 'https://other.example/rss';
        net.feed(FEED, fixture('none.xml'));
        net.feed(other, fixture('none.xml'));
        registry.subscribe(recordingClient(), [FEED]);
        await settle();
        const late = recordingClient();
        registry.subscribe(late, [other, FEED]);
        await settle();
        expect(late.messages).toEqual([
            {
                type: 'status',
                url: other,
                state: 'error',
                detail: 'the server already follows the maximum of 1 feeds'
            },
            expect.objectContaining({ url: FEED, state: 'unsupported' })
        ]);
        expect(net.to(other)).toHaveLength(0);
    });

    it('frees a client slot when the client leaves', async () => {
        const { net, registry } = setup({ MAX_FEEDS: '1' });
        const other = 'https://other.example/rss';
        net.feed(FEED, fixture('none.xml'));
        net.feed(other, fixture('none.xml'));
        const first = recordingClient();
        registry.subscribe(first, [FEED]);
        await settle();
        registry.removeClient(first);
        const second = recordingClient();
        registry.subscribe(second, [other]);
        await settle();
        expect(second.messages.at(-1)).toMatchObject({
            url: other,
            state: 'unsupported'
        });
    });

    it('limits concurrent discovery', async () => {
        const { net, registry } = setup({ DISCOVERY_CONCURRENCY: '2' });
        let inFlight = 0;
        let peak = 0;
        const urls = Array.from(
            { length: 6 },
            (_, i) => `https://f${i}.example/rss`
        );
        for (const url of urls) {
            net.on(url, async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await setImmediate();
                await setImmediate();
                inFlight--;
                return new Response(fixture('none.xml'));
            });
        }
        const client = recordingClient();
        registry.subscribe(client, urls);
        await settle();
        expect(peak).toBe(2);
        expect(
            client.messages.filter(
                m => m.type === 'status' && m.state === 'unsupported'
            )
        ).toHaveLength(6);
    });
});

describe('retrying a dead feed on a new subscribe', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const states = (client: RecordingClient) =>
        client.messages.map(m => (m.type === 'status' ? m.state : m.type));

    it('restarts a failed feed once its retry time passes, once for concurrent subscribers', async () => {
        const { net, registry } = setup();
        net.on(FEED, () => new Response(null, { status: 503 }));
        const first = recordingClient();
        registry.subscribe(first, [FEED]);
        await settle();
        expect(first.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'error',
            detail: 'feed returned HTTP 503'
        });

        await vi.advanceTimersByTimeAsync(59_999);
        const early = recordingClient();
        registry.subscribe(early, [FEED]);
        await settle();
        expect(net.to(FEED)).toHaveLength(1);
        expect(early.messages).toEqual([first.messages.at(-1)]);

        await vi.advanceTimersByTimeAsync(1);
        net.feed(FEED, fixture('none.xml'));
        const a = recordingClient();
        const b = recordingClient();
        registry.subscribe(a, [FEED]);
        registry.subscribe(b, [FEED]);
        await settle();
        expect(net.to(FEED)).toHaveLength(2);
        expect(states(first)).toEqual([
            'pending',
            'error',
            'pending',
            'unsupported'
        ]);
        expect(states(early)).toEqual(['error', 'pending', 'unsupported']);
        expect(states(a)).toEqual(['pending', 'unsupported']);
        expect(states(b)).toEqual(['pending', 'unsupported']);
    });

    it('waits out the origin cooldown before restarting a failed feed', async () => {
        const { net, registry } = setup();
        net.on(
            FEED,
            () =>
                new Response(null, {
                    status: 503,
                    headers: { 'retry-after': '600' }
                })
        );
        registry.subscribe(recordingClient(), [FEED]);
        await settle();
        await vi.advanceTimersByTimeAsync(599_999);
        registry.subscribe(recordingClient(), [FEED]);
        await settle();
        expect(net.to(FEED)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        registry.subscribe(recordingClient(), [FEED]);
        await settle();
        expect(net.to(FEED)).toHaveLength(2);
    });

    it('reports a feed on a cooling host as an error without fetching it', async () => {
        const { net, registry } = setup();
        const sibling = 'https://blog.example/other.xml';
        net.on(FEED, () => new Response(null, { status: 503 }));
        net.feed(sibling, fixture('none.xml'));
        registry.subscribe(recordingClient(), [FEED]);
        await settle();
        const client = recordingClient();
        registry.subscribe(client, [sibling]);
        await settle();
        expect(net.to(sibling)).toHaveLength(0);
        expect(client.messages.at(-1)).toMatchObject({
            url: sibling,
            state: 'error',
            detail: expect.stringMatching(
                /^https:\/\/blog\.example failed recently; not contacting it before /
            )
        });
    });

    it('does not cool a host that answered 404', async () => {
        const { net, registry } = setup();
        const sibling = 'https://blog.example/other.xml';
        net.feed(sibling, fixture('none.xml'));
        registry.subscribe(recordingClient(), [FEED]);
        await settle();
        const client = recordingClient();
        registry.subscribe(client, [sibling]);
        await settle();
        expect(client.messages.at(-1)).toMatchObject({ state: 'unsupported' });
    });

    it('re-discovers an unsupported feed only after an hour', async () => {
        const s = setup();
        const { net, registry } = s;
        net.feed(FEED, fixture('none.xml'));
        registry.subscribe(recordingClient(), [FEED]);
        await settle();

        await vi.advanceTimersByTimeAsync(3600_000 - 1);
        const early = recordingClient();
        registry.subscribe(early, [FEED]);
        await settle();
        expect(net.to(FEED)).toHaveLength(1);
        expect(states(early)).toEqual(['unsupported']);

        await vi.advanceTimersByTimeAsync(1);
        net.feed(FEED, fixture('rss-cloud.xml'));
        fakeCloud(s, 'http://rpc.rsscloud.example:5337/pleaseNotify');
        const late = recordingClient();
        registry.subscribe(late, [FEED]);
        await settle();
        expect(net.to(FEED)).toHaveLength(2);
        expect(late.messages.at(-1)).toMatchObject({
            state: 'subscribed',
            via: 'rsscloud'
        });
    });
});
