import { describe, expect, it } from 'vitest';
import { callbackUrl, loadConfig, rsscloudCallback } from '../src/config.js';

describe('loadConfig', () => {
    it('applies documented defaults', () => {
        const config = loadConfig({ PUBLIC_URL: 'https://sub.example' });
        expect(config).toMatchObject({
            port: 3000,
            rsscloudRenewMs: 24 * 3600_000,
            websubLeaseSeconds: 86400,
            maxFeedsPerMessage: 500,
            fetchTimeoutMs: 10000,
            discoveryConcurrency: 8,
            allowPrivateHosts: false
        });
    });

    it('requires PUBLIC_URL', () => {
        expect(() => loadConfig({})).toThrow(/PUBLIC_URL/);
    });

    it('rejects non-http PUBLIC_URL and bad numbers', () => {
        expect(() => loadConfig({ PUBLIC_URL: 'ftp://x.example' })).toThrow();
        expect(() =>
            loadConfig({ PUBLIC_URL: 'https://x.example', PORT: 'abc' })
        ).toThrow(/PORT/);
        expect(() =>
            loadConfig({
                PUBLIC_URL: 'https://x.example',
                ALLOW_PRIVATE_HOSTS: 'maybe'
            })
        ).toThrow(/ALLOW_PRIVATE_HOSTS/);
    });

    it('parses overrides', () => {
        const config = loadConfig({
            PUBLIC_URL: 'http://localhost:3999',
            PORT: '3999',
            RSSCLOUD_RENEW_HOURS: '2',
            ALLOW_PRIVATE_HOSTS: 'true'
        });
        expect(config.port).toBe(3999);
        expect(config.rsscloudRenewMs).toBe(2 * 3600_000);
        expect(config.allowPrivateHosts).toBe(true);
    });
});

describe('rsscloudCallback', () => {
    it('uses https-post and port 443 for an https PUBLIC_URL', () => {
        const config = loadConfig({ PUBLIC_URL: 'https://abc.example' });
        expect(rsscloudCallback(config)).toEqual({
            domain: 'abc.example',
            port: 443,
            path: '/rsscloud/notify',
            protocol: 'https-post'
        });
    });

    it('uses http-post and port 80 for an http PUBLIC_URL', () => {
        const config = loadConfig({ PUBLIC_URL: 'http://abc.example' });
        expect(rsscloudCallback(config)).toMatchObject({
            port: 80,
            protocol: 'http-post'
        });
    });

    it('keeps an explicit port and a path prefix', () => {
        const config = loadConfig({
            PUBLIC_URL: 'https://abc.example:8443/socketsub/'
        });
        expect(rsscloudCallback(config)).toEqual({
            domain: 'abc.example',
            port: 8443,
            path: '/socketsub/rsscloud/notify',
            protocol: 'https-post'
        });
        expect(callbackUrl(config, '/websub/x')).toBe(
            'https://abc.example:8443/socketsub/websub/x'
        );
    });
});
