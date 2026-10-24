import { describe, expect, it } from 'vitest';
import { createBackoff } from '../src/backoff.js';
import { createFetcher, isPrivateAddress, type Lookup } from '../src/net.js';
import { createFakeNet, fixture } from './support/fake-net.js';
import { recordingClient, settle, setup } from './support/harness.js';

const publicDns: Lookup = async () => ['93.184.215.14'];

function fetcher(
    net = createFakeNet(),
    opts: {
        lookup?: Lookup;
        allowPrivateHosts?: boolean;
        timeoutMs?: number;
    } = {}
) {
    return createFetcher({
        fetch: net.fetch,
        lookup: opts.lookup ?? publicDns,
        timeoutMs: opts.timeoutMs ?? 1000,
        allowPrivateHosts: opts.allowPrivateHosts ?? false,
        backoff: createBackoff({ now: Date.now, random: Math.random })
    });
}

describe('isPrivateAddress', () => {
    it.each([
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.1',
        '169.254.169.254',
        '100.64.0.1',
        '0.0.0.0',
        '::',
        '::1',
        'fe80::1',
        'fd12:3456::1',
        'fec0::1',
        '64:ff9b::7f00:1',
        '2002:7f00:1::1',
        '::ffff:127.0.0.1',
        '::ffff:10.0.0.1'
    ])('blocks %s', address => {
        expect(isPrivateAddress(address)).toBe(true);
    });

    it.each(['93.184.215.14', '8.8.8.8', '172.32.0.1', '2606:4700::1111'])(
        'allows %s',
        address => {
            expect(isPrivateAddress(address)).toBe(false);
        }
    );
});

describe('guarded fetcher', () => {
    it('refuses a hostname that resolves to a private address', async () => {
        const net = createFakeNet();
        net.feed('https://intranet.example/feed', 'x');
        const get = fetcher(net, {
            lookup: async () => ['93.184.215.14', '10.0.0.5']
        });
        await expect(get('https://intranet.example/feed')).rejects.toThrow(
            /private/
        );
        expect(net.requests).toHaveLength(0);
    });

    it.each([
        'http://127.0.0.1/feed',
        'http://[::1]/feed',
        'http://[::ffff:a00:1]/'
    ])('refuses the literal address %s', async url => {
        await expect(fetcher()(url)).rejects.toThrow(/private/);
    });

    it('allows private hosts when ALLOW_PRIVATE_HOSTS is set', async () => {
        const net = createFakeNet();
        net.feed('http://127.0.0.1/feed', 'ok');
        const res = await fetcher(net, { allowPrivateHosts: true })(
            'http://127.0.0.1/feed'
        );
        expect(res.body).toBe('ok');
    });

    it('checks every redirect hop', async () => {
        const net = createFakeNet();
        net.on(
            'https://public.example/feed',
            () =>
                new Response(null, {
                    status: 302,
                    headers: { location: 'http://169.254.169.254/latest' }
                })
        );
        await expect(
            fetcher(net)('https://public.example/feed')
        ).rejects.toThrow(/private/);
        expect(net.requests).toHaveLength(1);
    });

    it('refuses non-http schemes', async () => {
        await expect(fetcher()('file:///etc/passwd')).rejects.toThrow(/file:/);
    });

    it('refuses bodies over 5 MB, declared or streamed', async () => {
        const net = createFakeNet();
        const big = 'x'.repeat(5 * 1024 * 1024 + 1);
        net.on('https://big.example/declared', () => new Response(big));
        net.on(
            'https://big.example/streamed',
            () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            const chunk = new Uint8Array(1024 * 1024);
                            for (let i = 0; i < 6; i++)
                                controller.enqueue(chunk);
                            controller.close();
                        }
                    })
                )
        );
        await expect(
            fetcher(net)('https://big.example/declared')
        ).rejects.toThrow(/5 MB/);
        await expect(
            fetcher(net)('https://big.example/streamed')
        ).rejects.toThrow(/5 MB/);
    });

    it('times out slow responses', async () => {
        const slow: typeof fetch = (_input, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                    reject(init.signal?.reason)
                );
            });
        const get = createFetcher({
            fetch: slow,
            lookup: publicDns,
            timeoutMs: 20,
            allowPrivateHosts: false,
            backoff: createBackoff({ now: Date.now, random: Math.random })
        });
        await expect(get('https://slow.example/')).rejects.toMatchObject({
            name: 'TimeoutError'
        });
    });

    it('reports a refused feed to the client as an error', async () => {
        const s = setup();
        s.net.feed('http://127.0.0.1/feed', fixture('rss-cloud.xml'));
        const client = recordingClient();
        s.registry.subscribe(client, ['http://127.0.0.1/feed']);
        await settle();
        expect(client.messages.at(-1)).toEqual({
            type: 'status',
            url: 'http://127.0.0.1/feed',
            state: 'error',
            detail: 'refusing private or unresolvable host 127.0.0.1'
        });
        expect(s.net.requests).toHaveLength(0);
    });
});
