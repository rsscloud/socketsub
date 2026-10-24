import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture, gate } from './support/fake-net.js';
import {
    failingUpstream,
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
    s.registry.subscribe(client, [FEED]);
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
        s.registry.subscribe(client, [FEED]);
        await settle();

        const [request] = hub.requests();
        const form = Object.fromEntries(request?.form ?? []);
        expect(form).toMatchObject({
            'hub.mode': 'subscribe',
            'hub.topic': 'https://blog.example/atom.xml',
            'hub.lease_seconds': '86400',
            'hub.verify': 'async'
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
        s.registry.subscribe(recordingClient(), [FEED]);
        s.registry.subscribe(recordingClient(), [
            'https://blog.example/atom.xml#2'
        ]);
        await settle();
        expect(hub.requests()).toHaveLength(1);
    });

    it('rejects verification with the wrong topic, mode, or id', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        s.registry.subscribe(recordingClient(), [FEED]);
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
        s.registry.subscribe(client, [FEED]);
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
        s.registry.subscribe(client, [FEED]);
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
        s.registry.subscribe(client, [feed]);
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
        s.registry.subscribe(client, [feed]);
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

    it('delivers only to the subscription it was addressed to', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        const alias = 'http://old.example/atom';
        s.net.on(
            alias,
            () =>
                new Response(null, { status: 301, headers: { location: FEED } })
        );
        const direct = recordingClient();
        const redirected = recordingClient();
        s.registry.subscribe(direct, [FEED]);
        s.registry.subscribe(redirected, [alias]);
        await settle();
        const [first, second] = hub.subscribes();
        await hub.verify(first);
        await hub.verify(second);

        await hub.deliver(first, '<feed/>', sign('sha256'));
        const updates = [direct, redirected].map(
            c => c.messages.filter(m => m.type === 'update').length
        );
        expect(updates).toEqual([1, 0]);
    });

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

    it('refuses a delivery body over 10 MiB', async () => {
        const { hub, client, request } = await subscribed();
        const before = client.messages.length;
        const body = 'x'.repeat(10 * 1024 * 1024 + 1);
        const res = await hub.deliver(request, body, sign('sha256'));
        expect(res.status).toBe(413);
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
    it('unsubscribes when the last client unsubscribes from the feed', async () => {
        const { s, hub, client, request } = await subscribed();
        s.registry.unsubscribe(client, [FEED]);
        await settle();

        const [unsubscribe] = hub.unsubscribes();
        expect(unsubscribe?.form.get('hub.callback')).toBe(
            request?.form.get('hub.callback')
        );
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'unsubscribed'
        });
    });

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
        s.registry.subscribe(other, [FEED]);
        s.registry.removeClient(client);
        await settle();
        expect(hub.unsubscribes()).toHaveLength(0);
    });

    it('unsubscribes and refuses late verification when the client leaves mid-subscribe', async () => {
        const s = hubFeed();
        const held = gate();
        const hub = fakeHub(s, HUB);
        s.net.on(HUB, async request => {
            if (request.form.get('hub.mode') === 'subscribe') await held.wait();
            return new Response(null, { status: 202 });
        });
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        const subscribe = hub.subscribes()[0];
        expect(subscribe).toBeDefined();

        s.registry.removeClient(client);
        await settle();
        const sent = client.messages.length;
        expect(hub.unsubscribes()).toHaveLength(1);

        held.release();
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
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    async function verifiedWithLease(leaseSeconds: string) {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        s.registry.subscribe(recordingClient(), [FEED]);
        await settle();
        await hub.verify(hub.subscribes()[0], {
            'hub.lease_seconds': leaseSeconds
        });
        return hub;
    }

    it('resubscribes at 90% of the lease the hub granted', async () => {
        const hub = await verifiedWithLease('1000');

        await vi.advanceTimersByTimeAsync(899_999);
        expect(hub.subscribes()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(hub.subscribes()).toHaveLength(2);
        expect(hub.subscribes()[1]?.form.get('hub.callback')).toBe(
            hub.subscribes()[0]?.form.get('hub.callback')
        );
    });

    it('schedules the next renewal from the lease the renewal verification granted', async () => {
        const hub = await verifiedWithLease('1000');
        await vi.advanceTimersByTimeAsync(900_000);
        await settle();
        expect(hub.subscribes()).toHaveLength(2);

        await hub.verify(hub.subscribes()[1], { 'hub.lease_seconds': '2000' });
        await vi.advanceTimersByTimeAsync(1_799_999);
        expect(hub.subscribes()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(hub.subscribes()).toHaveLength(3);
    });

    it('fails at the end of the lease when the hub never verifies a renewal', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        const request = hub.subscribes()[0];
        await hub.verify(request, { 'hub.lease_seconds': '1000' });

        await vi.advanceTimersByTimeAsync(900_000);
        await settle();
        expect(hub.subscribes()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(99_999);
        expect(client.messages.at(-1)).toMatchObject({ state: 'subscribed' });
        await vi.advanceTimersByTimeAsync(1);
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'error',
            via: 'websub',
            detail: 'WebSub hub did not verify the renewal before the lease ended'
        });
        const delivery = await hub.deliver(request, '<feed/>', sign('sha256'));
        expect(delivery.status).toBe(410);
    });

    it('stays subscribed when the hub verifies a renewal before the request returns', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        s.net.on(HUB, async request => {
            if (hub.subscribes().length > 1) {
                await hub.verify(request, { 'hub.lease_seconds': '1000' });
            }
            return new Response(null, { status: 202 });
        });
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        await hub.verify(hub.subscribes()[0], { 'hub.lease_seconds': '1000' });

        await vi.advanceTimersByTimeAsync(900_000);
        await settle();
        await vi.advanceTimersByTimeAsync(899_999);
        await settle();
        expect(hub.subscribes()).toHaveLength(2);
        expect(client.messages.at(-1)).toMatchObject({ state: 'subscribed' });
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(hub.subscribes()).toHaveLength(3);
    });

    it('waits the longest timer delay when the hub grants a huge lease', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        s.registry.subscribe(recordingClient(), [FEED]);
        await settle();
        await hub.verify(hub.subscribes()[0], {
            'hub.lease_seconds': '4000000000'
        });

        await vi.advanceTimersByTimeAsync(2 ** 31 - 2);
        await settle();
        expect(hub.subscribes()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(hub.subscribes()).toHaveLength(2);
    });

    it('never renews when the hub verifies and then fails the subscribe request', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        s.net.on(HUB, async request => {
            await hub.verify(request, { 'hub.lease_seconds': '1000' });
            return new Response(null, { status: 500 });
        });
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        expect(client.messages.at(-1)).toMatchObject({ state: 'error' });

        await vi.advanceTimersByTimeAsync(10_000_000);
        await settle();
        expect(hub.subscribes()).toHaveLength(1);
    });

    it('forgets an unverified unsubscribe after 10 minutes', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        await hub.verify(hub.subscribes()[0]);
        s.registry.removeClient(client);
        await settle();
        const unsubscribe = hub.unsubscribes()[0];

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect((await hub.verify(unsubscribe)).status).toBe(404);
    });

    it('stops renewing after the last client leaves', async () => {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        await hub.verify(hub.subscribes()[0], { 'hub.lease_seconds': '1000' });
        s.registry.removeClient(client);
        await vi.advanceTimersByTimeAsync(10_000_000);
        await settle();
        expect(hub.subscribes()).toHaveLength(1);
    });
});

describe('WebSub renewal retries', () => {
    const MINUTE = 60_000;
    const LEASE = '36000';
    const RENEW_AT = 32_400_000;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    async function advance(ms: number) {
        await vi.advanceTimersByTimeAsync(ms);
        await settle();
    }

    async function verified() {
        const s = hubFeed();
        const hub = fakeHub(s, HUB);
        const client = recordingClient();
        s.registry.subscribe(client, [FEED]);
        await settle();
        const request = hub.subscribes()[0];
        await hub.verify(request, { 'hub.lease_seconds': LEASE });
        return { s, client, request, start: Date.now() };
    }

    it('stays subscribed and retries a failed renewal with growing backoff', async () => {
        const { s, client, start } = await verified();
        const times = failingUpstream(s, HUB);
        await advance(RENEW_AT + 4 * MINUTE);
        expect(times.map(t => (t - start - RENEW_AT) / MINUTE)).toEqual([
            0, 1.5, 4
        ]);
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'subscribed',
            via: 'websub'
        });
        const sent = client.messages.length;

        const hub = fakeHub(s, HUB);
        await advance(4.5 * MINUTE);
        expect(hub.subscribes()).toHaveLength(5);
        await hub.verify(hub.subscribes()[4], { 'hub.lease_seconds': LEASE });
        await advance(RENEW_AT - 1);
        expect(hub.subscribes()).toHaveLength(5);
        await advance(1);
        expect(hub.subscribes()).toHaveLength(6);
        expect(client.messages).toHaveLength(sent);
    });

    it.each([
        ['unsubscribes', 'unsubscribe'],
        ['disconnects', 'close']
    ] as const)(
        'cancels the scheduled retry when the last client %s during backoff',
        async (_label, leave) => {
            const { s, client } = await verified();
            const times = failingUpstream(s, HUB);
            await advance(RENEW_AT);
            expect(times).toHaveLength(1);

            if (leave === 'unsubscribe') {
                s.registry.unsubscribe(client, [FEED]);
            } else {
                s.registry.removeClient(client);
            }
            await advance(Number(LEASE) * 1000);
            expect(times).toHaveLength(1);
        }
    );

    it('fails before the lease ends when renewals keep failing', async () => {
        const { s, client, request, start } = await verified();
        const times = failingUpstream(s, HUB);
        await advance(36_000_000);
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: FEED,
            state: 'error',
            via: 'websub',
            detail: 'WebSub renewal failed: hub returned HTTP 503; the lease ends before the hub can be retried'
        });
        await advance(36_000_000);
        expect(times.map(t => (t - start - RENEW_AT) / MINUTE)).toEqual([
            0, 1.5, 4, 8.5, 17, 33.5, 55
        ]);
        const hub = fakeHub(s, HUB);
        const delivery = await hub.deliver(request, '<feed/>', sign('sha256'));
        expect(delivery.status).toBe(410);
    });

    it('fails a refused renewal right away', async () => {
        const { s, client, start } = await verified();
        const times = failingUpstream(s, HUB, 400);
        await advance(RENEW_AT);
        expect(times.map(t => t - start)).toEqual([RENEW_AT]);
        expect(client.messages.at(-1)).toMatchObject({
            state: 'error',
            detail: 'WebSub renewal failed: hub returned HTTP 400'
        });
    });
});
