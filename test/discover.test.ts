import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover.js';
import { createFetcher } from '../src/net.js';
import { createFakeNet, fixture, type FakeNet } from './support/fake-net.js';

const FEED = 'https://blog.example/feed.xml';

const fetcherFor = (net: FakeNet) =>
    createFetcher({
        fetch: net.fetch,
        lookup: async () => ['93.184.215.14'],
        timeoutMs: 1000,
        allowPrivateHosts: false
    });

async function discoverFixture(name: string, headers?: Record<string, string>) {
    const net = createFakeNet();
    net.feed(FEED, fixture(name), headers);
    return discover(fetcherFor(net), FEED);
}

describe('discover', () => {
    it('builds an http endpoint from <cloud> on a non-443 port', async () => {
        const d = await discoverFixture('rss-cloud.xml');
        expect(d.rssCloud?.endpoint.href).toBe(
            'http://rpc.rsscloud.example:5337/pleaseNotify'
        );
        expect(d.webSub).toBeUndefined();
    });

    it('uses https for <cloud> on port 443 and adds a missing slash', async () => {
        const d = await discoverFixture('rss-cloud-443.xml');
        expect(d.rssCloud?.endpoint.href).toBe(
            'https://rpc.rsscloud.example/pleaseNotify'
        );
    });

    it('ignores an xml-rpc <cloud>', async () => {
        const d = await discoverFixture('rss-cloud-xmlrpc.xml');
        expect(d.rssCloud).toBeUndefined();
    });

    it('reads <source:cloud> under the http namespace without a trailing slash', async () => {
        const d = await discoverFixture('source-cloud-http.xml');
        expect(d.rssCloud?.endpoint.href).toBe(
            'http://rpc.rsscloud.example/pleaseNotify'
        );
    });

    it('resolves the source namespace by URI, not by prefix', async () => {
        const d = await discoverFixture('source-cloud-odd-prefix.xml');
        expect(d.rssCloud?.endpoint.href).toBe(
            'https://rpc.rsscloud.example/pleaseNotify'
        );
    });

    it('prefers <source:cloud> when both cloud elements are present', async () => {
        const d = await discoverFixture('both-clouds.xml');
        expect(d.rssCloud?.endpoint.href).toBe(
            'https://new.rsscloud.example/pleaseNotify'
        );
    });

    it('finds an Atom hub and self link', async () => {
        const d = await discoverFixture('atom-hub.xml');
        expect(d.webSub?.hub.href).toBe('https://hub.example/');
        expect(d.webSub?.topic).toBe('https://blog.example/atom.xml');
        expect(d.rssCloud).toBeUndefined();
    });

    it('finds an atom:link hub in RSS and resolves a relative self', async () => {
        const d = await discoverFixture('rss-atom-hub.xml');
        expect(d.webSub?.hub.href).toBe('https://hub.example/');
        expect(d.webSub?.topic).toBe('https://blog.example/canonical.xml');
    });

    it('reads hub and self from the Link header', async () => {
        const d = await discoverFixture('none.xml', {
            link: '<https://hub.example/h>; rel="hub", <https://blog.example/self.xml>; rel=self'
        });
        expect(d.webSub).toEqual({
            hub: new URL('https://hub.example/h'),
            topic: 'https://blog.example/self.xml'
        });
    });

    it('falls back to the final URL as topic when there is no self link', async () => {
        const d = await discoverFixture('none.xml', {
            link: '<https://hub.example/>; rel="hub"'
        });
        expect(d.webSub?.topic).toBe(FEED);
    });

    it('finds both protocols in one feed', async () => {
        const d = await discoverFixture('rss-cloud-and-hub.xml');
        expect(d.rssCloud).toBeDefined();
        expect(d.webSub?.hub.href).toBe('https://hub.example/');
    });

    it('reports nothing for a plain feed', async () => {
        const d = await discoverFixture('none.xml');
        expect(d).toEqual({ finalUrl: FEED });
    });

    it('reports nothing for a non-XML body', async () => {
        const net = createFakeNet();
        net.feed(FEED, '<html><body>not a feed');
        const d = await discover(fetcherFor(net), FEED);
        expect(d).toEqual({ finalUrl: FEED });
    });

    it('follows redirects and reports the final URL', async () => {
        const net = createFakeNet();
        net.on(
            'http://old.example/rss',
            () =>
                new Response(null, {
                    status: 301,
                    headers: { location: FEED }
                })
        );
        net.feed(FEED, fixture('rss-cloud.xml'));
        const d = await discover(fetcherFor(net), 'http://old.example/rss');
        expect(d.finalUrl).toBe(FEED);
        expect(d.rssCloud).toBeDefined();
    });

    it('throws when the feed is not 2xx', async () => {
        const net = createFakeNet();
        await expect(discover(fetcherFor(net), FEED)).rejects.toThrow(
            /HTTP 404/
        );
    });
});
