import { MAX_TIMER_MS } from './timer.js';
import { isHttpUrl } from './url.js';

export type RssCloudCallback = {
    domain: string;
    port: number;
    path: string;
    protocol: 'http-post' | 'https-post';
};

export type Config = {
    port: number;
    publicUrl: URL;
    rssCloudRenewMs: number;
    webSubLeaseSeconds: number;
    maxFeedsPerMessage: number;
    maxFeedsPerClient: number;
    maxFeeds: number;
    fetchTimeoutMs: number;
    discoveryConcurrency: number;
    allowPrivateHosts: boolean;
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
    return {
        port: positiveInt(env, 'PORT', 3000, 65535),
        publicUrl: publicUrl(env.PUBLIC_URL),
        rssCloudRenewMs:
            positiveInt(
                env,
                'RSSCLOUD_RENEW_HOURS',
                24,
                Math.floor(MAX_TIMER_MS / 3600_000)
            ) * 3600_000,
        webSubLeaseSeconds: positiveInt(env, 'WEBSUB_LEASE_SECONDS', 86400),
        maxFeedsPerMessage: positiveInt(env, 'MAX_FEEDS_PER_MESSAGE', 500),
        maxFeedsPerClient: positiveInt(env, 'MAX_FEEDS_PER_CLIENT', 1000),
        maxFeeds: positiveInt(env, 'MAX_FEEDS', 10000),
        fetchTimeoutMs: positiveInt(
            env,
            'FETCH_TIMEOUT_MS',
            10000,
            MAX_TIMER_MS
        ),
        discoveryConcurrency: positiveInt(env, 'DISCOVERY_CONCURRENCY', 8),
        allowPrivateHosts: bool(env, 'ALLOW_PRIVATE_HOSTS', false)
    };
}

export function callbackUrl(config: Config, path: string): string {
    const base = config.publicUrl.href.replace(/\/+$/, '');
    return `${base}${path}`;
}

export function rssCloudCallback(config: Config): RssCloudCallback {
    const url = config.publicUrl;
    const https = url.protocol === 'https:';
    return {
        domain: url.hostname,
        port: url.port ? Number(url.port) : https ? 443 : 80,
        path: new URL(callbackUrl(config, '/rsscloud/notify')).pathname,
        protocol: https ? 'https-post' : 'http-post'
    };
}

function publicUrl(raw: string | undefined): URL {
    if (!raw) throw new Error('PUBLIC_URL is required');
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`PUBLIC_URL is not a valid URL: ${raw}`);
    }
    if (!isHttpUrl(url)) {
        throw new Error(`PUBLIC_URL must be http or https: ${raw}`);
    }
    if (url.search || url.hash) {
        throw new Error(`PUBLIC_URL must not have a query or fragment: ${raw}`);
    }
    return url;
}

function positiveInt(
    env: Env,
    name: string,
    fallback: number,
    max = Number.MAX_SAFE_INTEGER
): number {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got: ${raw}`);
    }
    if (value > max) {
        throw new Error(`${name} must be at most ${max}, got: ${raw}`);
    }
    return value;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
    const raw = env[name]?.toLowerCase();
    if (raw === undefined || raw === '') return fallback;
    if (['1', 'true', 'yes'].includes(raw)) return true;
    if (['0', 'false', 'no'].includes(raw)) return false;
    throw new Error(`${name} must be true or false, got: ${raw}`);
}
