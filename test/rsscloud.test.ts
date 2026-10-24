import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './support/fake-net.js';
import {
    fakeCloud,
    recordingClient,
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
        s.registry.add(client, [FEED]);
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
        s.registry.add(recordingClient(), [FEED]);
        await settle();
        expect(cloud.requests()[0]?.form.get('protocol')).toBe('http-post');
        expect(cloud.requests()[0]?.form.get('port')).toBe('3999');
        expect(cloud.requests()[0]?.form.get('domain')).toBe('localhost');
    });

    it('reads an XML notifyResult', async () => {
        const s = cloudFeed();
        fakeCloud(s, CLOUD, { format: 'xml' });
        const client = recordingClient();
        s.registry.add(client, [FEED]);
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
        s.registry.add(client, [FEED]);
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
        s.registry.add(recordingClient(), [FEED]);
        s.registry.add(recordingClient(), [FEED]);
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
        s.registry.add(recordingClient(), [FEED]);
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
        s.registry.add(a, [FEED]);
        s.registry.add(b, ['https://blog.example/feed.xml#mine']);
        s.registry.add(bystander, ['https://other.example/rss']);
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
            s.registry.add(client, [FEED]);
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
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('re-registers every RSSCLOUD_RENEW_HOURS while clients remain', async () => {
        const s = cloudFeed({ RSSCLOUD_RENEW_HOURS: '2' });
        const cloud = fakeCloud(s, CLOUD);
        const client = recordingClient();
        s.registry.add(client, [FEED]);
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
        s.registry.add(client, [FEED]);
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
        let release!: () => void;
        const gate = new Promise<void>(r => (release = r));
        let calls = 0;
        s.net.on(CLOUD, async () => {
            calls++;
            await gate;
            return Response.json({ success: true, msg: 'ok' });
        });
        const client = recordingClient();
        s.registry.add(client, [FEED]);
        await settle();
        expect(calls).toBe(1);
        s.registry.removeClient(client);
        release();
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
