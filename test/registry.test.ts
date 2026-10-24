import { describe, expect, it } from 'vitest';
import { fixture } from './support/fake-net.js';
import { recordingClient, settle, setup } from './support/harness.js';

const FEED = 'https://blog.example/feed.xml';

describe('registry', () => {
    it('reports pending, then unsupported for a feed with no push protocol', async () => {
        const { net, registry } = setup();
        net.feed(FEED, fixture('none.xml'));
        const client = recordingClient();
        registry.add(client, [FEED]);
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
        const { net, registry } = setup();
        net.feed(FEED, fixture('none.xml'));
        const a = recordingClient();
        const b = recordingClient();
        registry.add(a, [FEED]);
        registry.add(b, ['HTTPS://BLOG.EXAMPLE/feed.xml#top']);
        await settle();
        expect(net.to(FEED)).toHaveLength(1);

        registry.notify(FEED);
        expect(a.messages.at(-1)).toEqual({ type: 'update', url: FEED });
        expect(b.messages.at(-1)).toEqual({
            type: 'update',
            url: 'HTTPS://BLOG.EXAMPLE/feed.xml#top'
        });
    });

    it('gives a late client the current status immediately', async () => {
        const { net, registry } = setup();
        net.feed(FEED, fixture('none.xml'));
        registry.add(recordingClient(), [FEED]);
        await settle();
        const late = recordingClient();
        registry.add(late, [FEED]);
        expect(late.messages).toEqual([
            expect.objectContaining({ url: FEED, state: 'unsupported' })
        ]);
    });

    it('adds arrays to the client set instead of replacing it', async () => {
        const { net, registry } = setup();
        const other = 'https://other.example/rss';
        net.feed(FEED, fixture('none.xml'));
        net.feed(other, fixture('none.xml'));
        const client = recordingClient();
        registry.add(client, [FEED]);
        registry.add(client, [other]);
        await settle();
        client.messages.length = 0;
        registry.notify(FEED);
        registry.notify(other);
        expect(client.messages).toEqual([
            { type: 'update', url: FEED },
            { type: 'update', url: other }
        ]);
    });

    it('routes notifications for the redirect target to the original string', async () => {
        const { net, registry } = setup();
        net.on(
            'http://old.example/rss',
            () =>
                new Response(null, { status: 301, headers: { location: FEED } })
        );
        net.feed(FEED, fixture('none.xml'));
        const client = recordingClient();
        registry.add(client, ['http://old.example/rss']);
        await settle();
        registry.notify(FEED);
        expect(client.messages.at(-1)).toEqual({
            type: 'update',
            url: 'http://old.example/rss'
        });
    });

    it('reports invalid URLs per feed and still handles the rest', async () => {
        const { net, registry } = setup();
        net.feed(FEED, fixture('none.xml'));
        const client = recordingClient();
        registry.add(client, ['not a url', 'ftp://x.example/feed', FEED]);
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
        registry.add(client, [FEED]);
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
        let release!: () => void;
        const gate = new Promise<void>(r => (release = r));
        net.on(FEED, async () => {
            await gate;
            return new Response(fixture('none.xml'));
        });
        const client = recordingClient();
        registry.add(client, [FEED]);
        await settle();
        registry.removeClient(client);
        release();
        await settle();
        expect(client.messages).toEqual([
            { type: 'status', url: FEED, state: 'pending' }
        ]);
        expect(registry.notify(FEED)).toBe(false);
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
                await settle(2);
                inFlight--;
                return new Response(fixture('none.xml'));
            });
        }
        const client = recordingClient();
        registry.add(client, urls);
        await settle(60);
        expect(peak).toBe(2);
        expect(
            client.messages.filter(
                m => m.type === 'status' && m.state === 'unsupported'
            )
        ).toHaveLength(6);
    });
});
