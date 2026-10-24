import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './support/fake-net.js';
import {
    fakeCloud,
    fakeHub,
    recordingClient,
    settle,
    setup
} from './support/harness.js';

const FEED = 'https://blog.example/atom.xml';
const HUB = 'https://hub.example/';

const sign =
    (algorithm: string) =>
    (secret: string, body: string): string =>
        `${algorithm}=${createHmac(algorithm, secret).update(body).digest('hex')}`;

function hubFeed(env: Record<string, string> = {}) {
    const s = setup(env);
    s.net.feed(FEED, fixture('atom-hub.xml'));
    return s;
}

async function subscribed(env: Record<string, string> = {}) {
    const s = hubFeed(env);
    const hub = fakeHub(s, HUB);
    const client = recordingClient();
    s.registry.add(client, [FEED]);
    await settle();
    const request = hub.subscribes()[0];
    const res = await hub.verify(request);
    expect(await res.text()).toBe('hub-challenge');
    return { s, hub, client, request };
}

describe('WebSub subscription', () => {
    it('sends a subscribe request and waits for verification', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        const client = recordingClient();
        s.registry.add(client, [FEED]);
        await settle();

        const [request] = hub.requests();
        const form = Object.fromEntries(request?.form ?? []);
        expect(form).toMatchObject({
            'hub.mode': 'subscribe',
            'hub.topic': 'https://blog.example/atom.xml',
            'hub.lease_seconds': '86400'
        });
        expect(form['hub.callback']).toMatch(
            /^https:\/\/sub\.example\/websub\/[0-9a-f-]{36}$/
        );
        expect(form['hub.secret']).toMatch(/^[0-9a-f]{48}$/);
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'pending',
            via: 'websub'
        });
    });

    it('echoes the challenge and reports subscribed', async () => {
        const { client } = await subscribed();
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'subscribed',
            via: 'websub'
        });
    });

    it('subscribes once for two clients', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        s.registry.add(recordingClient(), [FEED]);
        s.registry.add(recordingClient(), ['https://blog.example/atom.xml#2']);
        await settle();
        expect(hub.requests()).toHaveLength(1);
    });

    it('rejects verification with the wrong topic, mode, or id', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        s.registry.add(recordingClient(), [FEED]);
        await settle();
        const request = hub.subscribes()[0];
        expect(
            (
                await hub.verify(request, {
                    'hub.topic': 'https://evil.example/'
                })
            ).status
        ).toBe(404);
        expect(
            (await hub.verify(request, { 'hub.mode': 'unsubscribe' })).status
        ).toBe(404);
        const res = await s.app.request(
            `/websub/nope?hub.mode=subscribe&hub.topic=${encodeURIComponent(FEED)}&hub.challenge=x`
        );
        expect(res.status).toBe(404);
    });

    it('moves the feed to error when the hub denies it', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        const client = recordingClient();
        s.registry.add(client, [FEED]);
        await settle();
        const res = await hub.verify(hub.subscribes()[0], {
            'hub.mode': 'denied',
            'hub.reason': 'topic not allowed'
        });
        expect(res.status).toBe(200);
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'error',
            via: 'websub',
            detail: 'WebSub hub denied the subscription: topic not allowed'
        });
    });

    it('reports an error when the hub refuses the request', async () => {
        const s = hubFeed();
        fakeHub(s, HUB, 400);
        const client = recordingClient();
        s.registry.add(client, [FEED]);
        await settle();
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'error',
            via: 'websub',
            detail: 'WebSub subscribe failed: hub returned HTTP 400'
        });
    });

    it('falls back to WebSub when rssCloud registration fails', async () => {
        const s = setup();
        const feed = 'https://blog.example/feed.xml';
        s.net.feed(feed, fixture('rss-cloud-and-hub.xml'));
        fakeCloud(s, 'http://rpc.rsscloud.example:5337/pleaseNotify', {
            refuse: 'Nope.'
        });
        const hub = fakeHub(s, HUB);
        const client = recordingClient();
        s.registry.add(client, [feed]);
        await settle();
        await hub.verify(hub.subscribes()[0]);
        expect(client.messages).toEqual([
            { type: 'status', url: feed, state: 'pending' },
            { type: 'status', url: feed, state: 'pending', via: 'rsscloud' },
            {
                type: 'status',
                url: feed,
                state: 'pending',
                via: 'websub',
                detail: 'rssCloud registration failed: Nope.; trying WebSub'
            },
            { type: 'status', url: feed, state: 'subscribed', via: 'websub' }
        ]);
    });

    it('prefers rssCloud when it succeeds', async () => {
        const s = setup();
        const feed = 'https://blog.example/feed.xml';
        s.net.feed(feed, fixture('rss-cloud-and-hub.xml'));
        fakeCloud(s, 'http://rpc.rsscloud.example:5337/pleaseNotify');
        const hub = fakeHub(s, HUB);
        const client = recordingClient();
        s.registry.add(client, [feed]);
        await settle();
        expect(hub.requests()).toHaveLength(0);
        expect(client.messages.at(-1)).toMatchObject({
            state: 'subscribed',
            via: 'rsscloud'
        });
    });
});

describe('WebSub delivery', () => {
    it.each(['sha1', 'sha256', 'sha384', 'sha512'])(
        'forwards a delivery signed with %s',
        async algorithm => {
            const { hub, client, request } = await subscribed();
            const res = await hub.deliver(request, '<feed/>', sign(algorithm));
            expect(res.status).toBe(204);
            expect(client.messages.at(-1)).toEqual({
                type: 'update',
                url: FEED
            });
        }
    );

    it('acknowledges but ignores a bad or missing signature', async () => {
        const { hub, client, request } = await subscribed();
        const before = client.messages.length;
        const forged = await hub.deliver(request, '<feed/>', () =>
            sign('sha256')('wrong-secret', '<feed/>')
        );
        const unsigned = await hub.deliver(request, '<feed/>', () => undefined);
        const tampered = await hub.deliver(
            request,
            '<feed>changed</feed>',
            secret => sign('sha256')(secret, '<feed/>')
        );
        expect([forged.status, unsigned.status, tampered.status]).toEqual([
            204, 204, 204
        ]);
        expect(client.messages).toHaveLength(before);
    });

    it('answers 410 for an unknown subscription id', async () => {
        const s = setup();
        const res = await s.app.request('/websub/unknown', {
            method: 'POST',
            body: 'x'
        });
        expect(res.status).toBe(410);
    });
});

describe('WebSub teardown', () => {
    it('unsubscribes when the last client leaves', async () => {
        const { s, hub, client, request } = await subscribed();
        s.registry.removeClient(client);
        await settle();

        const [unsubscribe] = hub.unsubscribes();
        expect(unsubscribe?.form.get('hub.topic')).toBe(FEED);
        expect(unsubscribe?.form.get('hub.callback')).toBe(
            request?.form.get('hub.callback')
        );
        const verify = await hub.verify(unsubscribe);
        expect(await verify.text()).toBe('hub-challenge');
        const delivery = await hub.deliver(request, '<feed/>', sign('sha256'));
        expect(delivery.status).toBe(410);
    });

    it('keeps the subscription while another client remains', async () => {
        const { s, hub, client } = await subscribed();
        const other = recordingClient();
        s.registry.add(other, [FEED]);
        s.registry.removeClient(client);
        await settle();
        expect(hub.unsubscribes()).toHaveLength(0);
    });

    it('unsubscribes and refuses late verification when the client leaves mid-subscribe', async () => {
        const s = hubFeed();
        let release!: () => void;
        const gate = new Promise<void>(r => (release = r));
        const hub = fakeHub(s, HUB);
        s.net.on(HUB, async request => {
            if (request.form.get('hub.mode') === 'subscribe') await gate;
            return new Response(null, { status: 202 });
        });
        const client = recordingClient();
        s.registry.add(client, [FEED]);
        await settle();
        const subscribe = hub.subscribes()[0];
        expect(subscribe).toBeDefined();

        s.registry.removeClient(client);
        await settle();
        const sent = client.messages.length;
        expect(hub.unsubscribes()).toHaveLength(1);

        release();
        await settle();
        expect((await hub.verify(subscribe)).status).toBe(404);
        expect(await (await hub.verify(hub.unsubscribes()[0])).text()).toBe(
            'hub-challenge'
        );
        expect(client.messages).toHaveLength(sent);
    });
});

describe('WebSub renewal', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('resubscribes at 90% of the lease the hub granted', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        s.registry.add(recordingClient(), [FEED]);
        await settle();
        await hub.verify(hub.subscribes()[0], { 'hub.lease_seconds': '1000' });

        await vi.advanceTimersByTimeAsync(899_999);
        expect(hub.subscribes()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(hub.subscribes()).toHaveLength(2);
        expect(hub.subscribes()[1]?.form.get('hub.callback')).toBe(
            hub.subscribes()[0]?.form.get('hub.callback')
        );

        await hub.verify(hub.subscribes()[1], { 'hub.lease_seconds': '2000' });
        await vi.advanceTimersByTimeAsync(1_799_999);
        expect(hub.subscribes()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(hub.subscribes()).toHaveLength(3);
    });

    it('stops renewing after the last client leaves', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        const client = recordingClient();
        s.registry.add(client, [FEED]);
        await settle();
        await hub.verify(hub.subscribes()[0], { 'hub.lease_seconds': '1000' });
        s.registry.removeClient(client);
        await vi.advanceTimersByTimeAsync(10_000_000);
        await settle();
        expect(hub.subscribes()).toHaveLength(1);
    });
});
