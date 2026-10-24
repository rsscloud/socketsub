import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture, gate } from './support/fake-net.js';
import {
    failingUpstream,
    fakeCloud,
    recordingClient,
    seededRandom,
    settle,
    setup
} from './support/harness.js';

const FEED = 'https://blog.example/feed.xml';
const CLOUD = 'http://rpc.rsscloud.example:5337/pleaseNotify';

function cloudFeed(env: Record<string, string> = {}) {
    const s = setup(env);
    s.net.feed(FEED, fixture('rss-cloud.xml'));
    return s;
}

describe('rssCloud registration', () => {
    it('registers with the challenge flow and reports subscribed', async () => {
        const s = cloudFeed();
        const cloud = fakeCloud(s, CLOUD);
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();

        const [request] = cloud.requests();
        expect(request?.method).toBe('POST');
        expect(request?.headers.get('accept')).toBe('application/json');
        expect(Object.fromEntries(request?.form ?? [])).toEqual({
            domain: 'sub.example',
            port: '443',
            path: '/rsscloud/notify',
            protocol: 'https-post',
            url1: FEED
        });
        expect(cloud.challenges).toEqual([{ status: 200, body: 'c-123' }]);
        expect(client.messages).toEqual([
            { type: 'status', url: FEED, state: 'pending' },
            { type: 'status', url: FEED, state: 'pending', via: 'rsscloud' },
            { type: 'status', url: FEED, state: 'subscribed', via: 'rsscloud' }
        ]);
    });

    it('asks for http-post on the PUBLIC_URL port when PUBLIC_URL is http', async () => {
        const s = cloudFeed({ PUBLIC_URL: 'http://localhost:3999' });
        const cloud = fakeCloud(s, CLOUD);
        s.registry.subscribe(recordingClient(), [FEED]);
        await settle();
        expect(cloud.requests()[0]?.form.get('protocol')).toBe('http-post');
        expect(cloud.requests()[0]?.form.get('port')).toBe('3999');
        expect(cloud.requests()[0]?.form.get('domain')).toBe('localhost');
    });

    it('reads an XML notifyResult', async () => {
        const s = cloudFeed();
        fakeCloud(s, CLOUD, { format: 'xml' });
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        expect(client.messages.at(-1)).toMatchObject({ state: 'subscribed' });
    });

    it('reports the cloud message when registration is refused', async () => {
        const s = cloudFeed();
        fakeCloud(s, CLOUD, {
            format: 'xml',
            refuse: 'Feed is not reachable.'
        });
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'error',
            via: 'rsscloud',
            detail: 'rssCloud registration failed: Feed is not reachable.'
        });
    });

    it('registers once for two clients on the same feed', async () => {
        const s = cloudFeed();
        const cloud = fakeCloud(s, CLOUD);
        s.registry.subscribe(recordingClient(), [FEED]);
        s.registry.subscribe(recordingClient(), [FEED]);
        await settle();
        expect(cloud.requests()).toHaveLength(1);
    });
});

describe('rssCloud callback routes', () => {
    it('rejects a challenge for a feed it never asked for', async () => {
        const s = cloudFeed();
        const res = await s.app.request(
            '/rsscloud/notify?url=https://unknown.example/rss&challenge=x'
        );
        expect(res.status).toBe(404);
    });

    it('rejects a challenge for a feed that is not using rssCloud', async () => {
        const s = setup();
        s.net.feed(FEED, fixture('none.xml'));
        s.registry.subscribe(recordingClient(), [FEED]);
        await settle();
        const res = await s.app.request(
            `/rsscloud/notify?url=${encodeURIComponent(FEED)}&challenge=x`
        );
        expect(res.status).toBe(404);
    });

    it('routes a notify POST to every client of the feed', async () => {
        const s = cloudFeed();
        fakeCloud(s, CLOUD);
        const a = recordingClient();
        const b = recordingClient();
        const bystander = recordingClient();
        s.net.feed('https://other.example/rss', fixture('none.xml'));
        s.registry.subscribe(a, [FEED]);
        s.registry.subscribe(b, ['https://blog.example/feed.xml#mine']);
        s.registry.subscribe(bystander, ['https://other.example/rss']);
        await settle();

        const res = await s.app.request('/rsscloud/notify', {
            method: 'POST',
            body: new URLSearchParams({ url: FEED })
        });
        expect(res.status).toBe(200);
        expect(a.messages.at(-1)).toEqual({ type: 'update', url: FEED });
        expect(b.messages.at(-1)).toEqual({
            type: 'update',
            url: 'https://blog.example/feed.xml#mine'
        });
        expect(bystander.messages.some(m => m.type === 'update')).toBe(false);
    });

    it.each([
        ['WebSub', 'atom-hub.xml'],
        ['no push protocol', 'none.xml']
    ])(
        'ignores a notify POST for a feed using %s',
        async (_label, feedFixture) => {
            const s = setup();
            s.net.feed(FEED, fixture(feedFixture));
            s.net.on(
                'https://hub.example/',
                () => new Response(null, { status: 202 })
            );
            const client = recordingClient();
            s.registry.subscribe(client, [FEED]);
            await settle();

            await s.app.request('/rsscloud/notify', {
                method: 'POST',
                body: new URLSearchParams({ url: FEED })
            });
            expect(client.messages.some(m => m.type === 'update')).toBe(false);
        }
    );

    it('refuses a notify POST body over 1 MiB', async () => {
        const s = setup();
        const res = await s.app.request('/rsscloud/notify', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: `url=${'a'.repeat(1024 * 1024)}`
        });
        expect(res.status).toBe(413);
    });

    it('accepts a notify POST for an unknown URL', async () => {
        const s = setup();
        const res = await s.app.request('/rsscloud/notify', {
            method: 'POST',
            body: new URLSearchParams({ url: 'https://unknown.example/' })
        });
        expect(res.status).toBe(200);
    });
});

describe('rssCloud renewal', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('re-registers every RSSCLOUD_RENEW_HOURS while clients remain', async () => {
        const s = cloudFeed({ RSSCLOUD_RENEW_HOURS: '2' });
        const cloud = fakeCloud(s, CLOUD);
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        expect(cloud.requests()).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(2 * 3600_000 - 1);
        expect(cloud.requests()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(cloud.requests()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(2 * 3600_000);
        await settle();
        expect(cloud.requests()).toHaveLength(3);
        expect(client.messages.at(-1)).toMatchObject({ state: 'subscribed' });
    });

    it('stops renewing when the last client leaves', async () => {
        const s = cloudFeed({ RSSCLOUD_RENEW_HOURS: '1' });
        const cloud = fakeCloud(s, CLOUD);
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        s.registry.removeClient(client);
        await vi.advanceTimersByTimeAsync(5 * 3600_000);
        await settle();
        expect(cloud.requests()).toHaveLength(1);
        const res = await s.app.request(
            `/rsscloud/notify?url=${encodeURIComponent(FEED)}&challenge=x`
        );
        expect(res.status).toBe(404);
    });

    it('never starts renewing when the client leaves during pleaseNotify', async () => {
        const s = cloudFeed({ RSSCLOUD_RENEW_HOURS: '1' });
        const held = gate();
        let calls = 0;
        s.net.on(CLOUD, async () => {
            calls++;
            await held.wait();
            return Response.json({ success: true, msg: 'ok' });
        });
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        expect(calls).toBe(1);
        s.registry.removeClient(client);
        held.release();
        await settle();
        await vi.advanceTimersByTimeAsync(5 * 3600_000);
        await settle();
        expect(calls).toBe(1);
        expect(client.messages.at(-1)).toMatchObject({
            state: 'pending',
            via: 'rsscloud'
        });
    });
});

describe('rssCloud renewal retries', () => {
    const HOUR = 3600_000;
    const MINUTE = 60_000;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    async function registered(feeds = [FEED]) {
        const s = setup();
        for (const feed of feeds) s.net.feed(feed, fixture('rss-cloud.xml'));
        fakeCloud(s, CLOUD);
        const clients = feeds.map(() => recordingClient());
        feeds.forEach((feed, i) => s.registry.subscribe(clients[i]!, [feed]));
        await settle();
        return { s, clients, start: Date.now() };
    }

    async function advance(ms: number) {
        await vi.advanceTimersByTimeAsync(ms);
        await settle();
    }

    const subscribed = {
        type: 'status',
        url: FEED,
        state: 'subscribed',
        via: 'rsscloud'
    };

    it('stays subscribed and retries a failed renewal with growing backoff', async () => {
        const { s, clients, start } = await registered();
        const times = failingUpstream(s, CLOUD);
        await advance(24 * HOUR + 4 * MINUTE);
        expect(times.map(t => (t - start - 24 * HOUR) / MINUTE)).toEqual([
            0, 1.5, 4
        ]);
        expect(clients[0]!.messages.at(-1)).toEqual(subscribed);
        expect(clients[0]!.messages).toHaveLength(3);

        const cloud = fakeCloud(s, CLOUD);
        await advance(4.5 * MINUTE);
        expect(cloud.challenges).toEqual([{ status: 200, body: 'c-123' }]);
        await advance(24 * HOUR - 1);
        expect(cloud.challenges).toHaveLength(1);
        await advance(1);
        expect(cloud.challenges).toHaveLength(2);
        expect(clients[0]!.messages).toHaveLength(3);
    });

    it.each([
        ['unsubscribes', 'unsubscribe'],
        ['disconnects', 'close']
    ] as const)(
        'cancels the scheduled retry when the last client %s during backoff',
        async (_label, leave) => {
            const { s, clients } = await registered();
            const times = failingUpstream(s, CLOUD);
            await advance(24 * HOUR);
            expect(times).toHaveLength(1);

            if (leave === 'unsubscribe') {
                s.registry.unsubscribe(clients[0]!, [FEED]);
            } else {
                s.registry.removeClient(clients[0]!);
            }
            await advance(26 * HOUR);
            expect(times).toHaveLength(1);
        }
    );

    it('does not reschedule a retry whose request was in flight when the last client left', async () => {
        const { s, clients } = await registered();
        const times: number[] = [];
        const held = gate();
        s.net.on(CLOUD, async () => {
            times.push(Date.now());
            if (times.length === 2) await held.wait();
            return new Response(null, { status: 503 });
        });
        await advance(24 * HOUR + 1.5 * MINUTE);
        expect(times).toHaveLength(2);

        s.registry.removeClient(clients[0]!);
        held.release();
        await advance(26 * HOUR);
        expect(times).toHaveLength(2);
    });

    it('fails before the registration expires when renewals keep failing', async () => {
        const { s, clients, start } = await registered();
        const times = failingUpstream(s, CLOUD);
        await advance(25 * HOUR);
        expect(clients[0]!.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'error',
            via: 'rsscloud',
            detail: 'rssCloud renewal failed: unexpected response (HTTP 503); the registration expires before the cloud can be retried'
        });
        await advance(24 * HOUR);
        expect(times.map(t => (t - start - 24 * HOUR) / MINUTE)).toEqual([
            0, 1.5, 4, 8.5, 17, 33.5
        ]);
    });

    it('spaces requests to a failing cloud by one shared cooldown across feeds', async () => {
        const other = 'https://other.example/feed.xml';
        const { s, clients, start } = await registered([FEED, other]);
        const times = failingUpstream(s, CLOUD);
        await advance(24 * HOUR + 10 * MINUTE);
        expect(times.map(t => (t - start - 24 * HOUR) / MINUTE)).toEqual([
            0, 1.5, 4, 8.5
        ]);

        const cloud = fakeCloud(s, CLOUD);
        await advance(10 * MINUTE);
        expect(cloud.challenges).toHaveLength(2);
        for (const client of clients) {
            expect(client.messages.at(-1)).toMatchObject({
                state: 'subscribed'
            });
        }
    });

    it('waits as long as the cloud asks with Retry-After', async () => {
        const { s, clients, start } = await registered();
        const times = failingUpstream(s, CLOUD, 503, { 'retry-after': '1800' });
        await advance(26 * HOUR);
        expect(times.map(t => (t - start - 24 * HOUR) / MINUTE)).toEqual([
            0, 30.5
        ]);
        expect(clients[0]!.messages.at(-1)).toMatchObject({
            state: 'error',
            detail: expect.stringContaining(
                'expires before the cloud can be retried'
            )
        });
    });

    it('fails on a refused renewal without cooling the cloud for other feeds', async () => {
        const { s, clients } = await registered();
        fakeCloud(s, CLOUD, { refuse: 'Feed is not reachable.' });
        await advance(24 * HOUR);
        expect(clients[0]!.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'error',
            via: 'rsscloud',
            detail: 'rssCloud renewal failed: Feed is not reachable.'
        });
        const before = s.net.to(CLOUD).length;
        await advance(HOUR);
        expect(s.net.to(CLOUD)).toHaveLength(before);

        const other = 'https://other.example/feed.xml';
        s.net.feed(other, fixture('rss-cloud.xml'));
        fakeCloud(s, CLOUD);
        const late = recordingClient();
        s.registry.subscribe(late, [other]);
        await settle();
        expect(late.messages.at(-1)).toMatchObject({ state: 'subscribed' });
    });
});

describe('many feeds on one recovering cloud', () => {
    const HOUR = 3600_000;
    const MINUTE = 60_000;
    const FEEDS = 50;
    const OUTAGE_MS = 5 * MINUTE;
    const BUSY_ABOVE = 2;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('renews every feed after an outage without flooding the cloud', async () => {
        const s = setup({}, seededRandom(7));
        const urls = Array.from(
            { length: FEEDS },
            (_, i) => `https://blog${i}.example/feed.xml`
        );
        for (const url of urls) s.net.feed(url, fixture('rss-cloud.xml'));
        fakeCloud(s, CLOUD);
        const clients = urls.map(url => {
            const client = recordingClient();
            s.registry.subscribe(client, [url]);
            return client;
        });
        await settle();
        const start = Date.now();

        const recoversAt = start + 24 * HOUR + OUTAGE_MS;
        let inFlight = 0;
        let peak = 0;
        let requests = 0;
        const pause = (ms: number) =>
            new Promise(resolve => setTimeout(resolve, ms));
        s.net.on(CLOUD, async () => {
            const at = Date.now();
            requests++;
            peak = Math.max(peak, ++inFlight);
            await pause(200);
            const busy = inFlight > BUSY_ABOVE;
            await pause(200);
            inFlight--;
            if (at < recoversAt || busy) {
                return new Response(null, { status: 503 });
            }
            return Response.json({ success: true, msg: 'ok' });
        });

        await vi.advanceTimersByTimeAsync(26 * HOUR);
        await settle();

        expect(peak).toBeLessThanOrEqual(4);
        // One success per feed, plus failures that each cool the cloud: the
        // first wave and each overload fail at most four in-flight requests.
        expect(requests).toBeLessThanOrEqual(FEEDS + 20);
        for (const client of clients) {
            expect(client.messages.at(-1)).toMatchObject({
                state: 'subscribed'
            });
        }
    });
});
