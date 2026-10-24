import { describe, expect, it } from 'vitest';
import { CoolingDownError, createBackoff } from '../src/backoff.js';
import { createFetcher } from '../src/net.js';
import { createFakeNet, gate } from './support/fake-net.js';

const ORIGIN = 'https://cloud.example';
const URL_A = `${ORIGIN}/a`;
const URL_B = `${ORIGIN}/b`;
const MINUTE = 60_000;

function rig(random = () => 0.5) {
    const clock = { time: 1_000_000, now: () => clock.time, random };
    const net = createFakeNet();
    const backoff = createBackoff(clock);
    const get = createFetcher({
        fetch: net.fetch,
        lookup: async () => ['93.184.215.14'],
        timeoutMs: 1000,
        allowPrivateHosts: false,
        backoff
    });
    const respond = (status: number, headers: Record<string, string> = {}) =>
        net.on(URL_A, () => new Response(null, { status, headers }));
    const cooldown = () =>
        (backoff.cooldownEnd(ORIGIN) ?? clock.time) - clock.time;
    const waitOut = () =>
        (clock.time = backoff.cooldownEnd(ORIGIN) ?? clock.time);
    return { clock, net, backoff, get, respond, cooldown, waitOut };
}

describe('origin backoff', () => {
    it('refuses requests to a failing origin without sending them', async () => {
        const r = rig();
        r.respond(503);
        r.net.feed('https://other.example/feed', 'ok');
        await r.get(URL_A);
        await expect(r.get(URL_B)).rejects.toBeInstanceOf(CoolingDownError);
        await expect(r.get(URL_B)).rejects.toThrow(
            /^https:\/\/cloud\.example failed recently; not contacting it before /
        );
        expect(r.net.requests).toHaveLength(1);
        expect((await r.get('https://other.example/feed')).body).toBe('ok');
    });

    it('doubles the cooldown per consecutive failure up to one hour', async () => {
        const r = rig();
        r.respond(500);
        const cooldowns: number[] = [];
        for (let i = 0; i < 8; i++) {
            await r.get(URL_A);
            cooldowns.push(r.cooldown() / MINUTE);
            r.waitOut();
        }
        expect(cooldowns).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    });

    it.each([
        [0, 0.8],
        [1, 1.2]
    ])('jitters the cooldown by 20%% (random %d)', async (random, factor) => {
        const r = rig(() => random);
        r.respond(502);
        await r.get(URL_A);
        expect(r.cooldown()).toBe(MINUTE * factor);
    });

    it('counts network errors and timeouts as failures', async () => {
        const r = rig();
        r.net.on(URL_A, () => Promise.reject(new TypeError('fetch failed')));
        await expect(r.get(URL_A)).rejects.toThrow('fetch failed');
        expect(r.cooldown()).toBe(MINUTE);
    });

    it('counts a body that stalls past the timeout as unreachable', async () => {
        const clock = { now: Date.now, random: () => 0.5 };
        const backoff = createBackoff(clock);
        const stalled: typeof fetch = async (_input, init) =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('<rss>'));
                        init?.signal?.addEventListener('abort', () =>
                            controller.error(init.signal?.reason)
                        );
                    }
                })
            );
        const get = createFetcher({
            fetch: stalled,
            lookup: async () => ['93.184.215.14'],
            timeoutMs: 20,
            allowPrivateHosts: false,
            backoff
        });
        await expect(get(URL_A)).rejects.toMatchObject({
            name: 'TimeoutError'
        });
        expect(backoff.cooldownEnd(ORIGIN)).toBeGreaterThan(Date.now());
    });

    it('counts a 429 as a failure', async () => {
        const r = rig();
        r.respond(429);
        await r.get(URL_A);
        expect(r.cooldown()).toBe(MINUTE);
    });

    it('does not cool an origin that answers with a 4xx', async () => {
        const r = rig();
        r.respond(404);
        await r.get(URL_A);
        await r.get(URL_A);
        expect(r.backoff.cooldownEnd(ORIGIN)).toBeUndefined();
        expect(r.net.requests).toHaveLength(2);
    });

    it('starts over after the origin answers', async () => {
        const r = rig();
        r.respond(503);
        await r.get(URL_A);
        r.waitOut();
        await r.get(URL_A);
        r.waitOut();
        r.respond(200);
        await r.get(URL_A);
        r.respond(503);
        await r.get(URL_A);
        expect(r.cooldown()).toBe(MINUTE);
    });

    it('honors Retry-After seconds when longer than the cooldown', async () => {
        const r = rig();
        r.respond(503, { 'retry-after': '600' });
        await r.get(URL_A);
        expect(r.cooldown()).toBe(10 * MINUTE);
    });

    it('honors a Retry-After HTTP date on a 429', async () => {
        const r = rig();
        const at = new Date(r.clock.time + 30 * MINUTE).toUTCString();
        r.respond(429, { 'retry-after': at });
        await r.get(URL_A);
        expect(Math.round(r.cooldown() / 1000)).toBe(30 * 60);
    });

    it('keeps the computed cooldown when Retry-After is shorter', async () => {
        const r = rig();
        r.respond(503, { 'retry-after': '5' });
        await r.get(URL_A);
        expect(r.cooldown()).toBe(MINUTE);
    });

    it('caps Retry-After at six hours', async () => {
        const r = rig();
        r.respond(503, { 'retry-after': String(7 * 24 * 3600) });
        await r.get(URL_A);
        expect(r.cooldown()).toBe(360 * MINUTE);
    });

    it('ignores Retry-After on other statuses', async () => {
        const r = rig();
        r.respond(500, { 'retry-after': '600' });
        await r.get(URL_A);
        expect(r.cooldown()).toBe(MINUTE);
    });

    it('counts requests already in flight when the origin fails as one failure', async () => {
        const r = rig();
        r.respond(503);
        await Promise.all([r.get(URL_A), r.get(URL_A), r.get(URL_A)]);
        expect(r.net.requests).toHaveLength(3);
        expect(r.cooldown()).toBe(MINUTE);
    });

    it('lets one request probe a recovering origin at a time', async () => {
        const r = rig();
        r.respond(503);
        await r.get(URL_A);
        r.waitOut();
        const held = gate();
        r.net.on(URL_A, async () => {
            await held.wait();
            return new Response('ok');
        });
        const probe = r.get(URL_A);
        await expect(r.get(URL_B)).rejects.toBeInstanceOf(CoolingDownError);
        expect(r.cooldown()).toBe(MINUTE);
        held.release();
        await probe;
        expect(r.backoff.cooldownEnd(ORIGIN)).toBeUndefined();
        r.net.feed(URL_B, 'ok');
        expect((await r.get(URL_B)).body).toBe('ok');
    });

    it('ignores a success from a request that started before the origin failed', async () => {
        const r = rig();
        const stray = gate();
        r.net.on(URL_B, async () => {
            await stray.wait();
            return new Response('ok');
        });
        const late = r.get(URL_B);
        r.respond(503);
        await r.get(URL_A);
        r.waitOut();
        const probing = gate();
        r.net.on(URL_A, async () => {
            await probing.wait();
            return new Response(null, { status: 503 });
        });
        const probe = r.get(URL_A);
        stray.release();
        await late;
        await expect(r.get(URL_B)).rejects.toBeInstanceOf(CoolingDownError);
        probing.release();
        await probe;
        expect(r.cooldown()).toBe(2 * MINUTE);
    });

    it('forgets a streak an hour after its cooldown ends', async () => {
        const r = rig();
        r.respond(503);
        await r.get(URL_A);
        r.waitOut();
        await r.get(URL_A);
        r.waitOut();
        r.clock.time += 60 * MINUTE;
        await r.get(URL_A);
        expect(r.cooldown()).toBe(MINUTE);
    });
});
