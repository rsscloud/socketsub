import { rsscloudCallback, type Config } from './config.js';
import { discover, type Discovery } from './discover.js';
import type { Fetcher } from './net.js';
import { pleaseNotify, type NotifyResult } from './rsscloud.js';

export type Via = 'rsscloud' | 'websub';

export type ServerMessage =
    | {
          type: 'status';
          url: string;
          state: 'pending' | 'subscribed' | 'unsupported' | 'error';
          via?: Via;
          detail?: string;
      }
    | { type: 'update'; url: string }
    | { type: 'error'; message: string };

type StatusMessage = Extract<ServerMessage, { type: 'status' }>;

export type Client = { send(message: ServerMessage): void };

export type FeedKey = string & { __brand: 'FeedKey' };

type Timer = ReturnType<typeof setTimeout>;

type RssCloudTarget = { endpoint: URL; topic: string };

export type FeedState =
    | { kind: 'discovering' }
    | { kind: 'subscribing'; via: 'rsscloud'; target: RssCloudTarget }
    | {
          kind: 'active';
          via: 'rsscloud';
          target: RssCloudTarget;
          renewTimer: Timer;
      }
    | { kind: 'unsupported'; detail: string }
    | { kind: 'failed'; reason: string; via?: Via };

type FeedSub = {
    key: FeedKey;
    state: FeedState;
    clients: Map<Client, string>;
    aliases: Set<string>;
};

export type RegistryDeps = {
    config: Config;
    fetcher: Fetcher;
};

export function toFeedKey(raw: string): FeedKey | undefined {
    const href = normalizeUrl(raw);
    return href === undefined ? undefined : (href as FeedKey);
}

function normalizeUrl(raw: string): string | undefined {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return undefined;
    }
    url.hash = '';
    return url.href;
}

export function createRegistry(deps: RegistryDeps) {
    const feeds = new Map<FeedKey, FeedSub>();
    const aliasIndex = new Map<string, Set<FeedKey>>();
    const limit = createLimiter(deps.config.discoveryConcurrency);
    const callback = rsscloudCallback(deps.config);

    function isLive(feed: FeedSub): boolean {
        return feeds.get(feed.key) === feed;
    }

    function addAlias(feed: FeedSub, url: string) {
        const alias = normalizeUrl(url);
        if (alias === undefined) return;
        feed.aliases.add(alias);
        let keys = aliasIndex.get(alias);
        if (!keys) aliasIndex.set(alias, (keys = new Set()));
        keys.add(feed.key);
    }

    function drop(feed: FeedSub) {
        if (feed.state.kind === 'active') clearTimeout(feed.state.renewTimer);
        feeds.delete(feed.key);
        for (const alias of feed.aliases) {
            const keys = aliasIndex.get(alias);
            keys?.delete(feed.key);
            if (keys?.size === 0) aliasIndex.delete(alias);
        }
    }

    function setState(feed: FeedSub, state: FeedState) {
        feed.state = state;
        for (const [client, url] of feed.clients) {
            client.send(statusMessage(url, state));
        }
    }

    async function start(feed: FeedSub) {
        let discovery: Discovery | undefined;
        try {
            discovery = await limit(() =>
                isLive(feed)
                    ? discover(deps.fetcher, feed.key)
                    : Promise.resolve(undefined)
            );
        } catch (err) {
            if (isLive(feed)) {
                setState(feed, { kind: 'failed', reason: errorText(err) });
            }
            return;
        }
        if (!discovery || !isLive(feed)) return;
        addAlias(feed, discovery.finalUrl);

        if (discovery.rsscloud) {
            const target = {
                endpoint: discovery.rsscloud.endpoint,
                topic: discovery.finalUrl
            };
            // The cloud may call our challenge route before pleaseNotify
            // returns, so the feed must already be in a subscribing state.
            setState(feed, { kind: 'subscribing', via: 'rsscloud', target });
            const result = await registerRssCloud(target);
            if (!isLive(feed)) return;
            if (result.success) {
                setState(feed, {
                    kind: 'active',
                    via: 'rsscloud',
                    target,
                    renewTimer: scheduleRssCloudRenewal(feed, target)
                });
                return;
            }
            setState(feed, {
                kind: 'failed',
                via: 'rsscloud',
                reason: `rssCloud registration failed: ${result.msg}`
            });
            return;
        }

        setState(feed, {
            kind: 'unsupported',
            detail: 'feed advertises neither rssCloud nor WebSub'
        });
    }

    async function registerRssCloud(
        target: RssCloudTarget
    ): Promise<NotifyResult> {
        try {
            return await pleaseNotify(
                deps.fetcher,
                target.endpoint,
                callback,
                target.topic
            );
        } catch (err) {
            return { success: false, msg: errorText(err) };
        }
    }

    function scheduleRssCloudRenewal(
        feed: FeedSub,
        target: RssCloudTarget
    ): Timer {
        return setTimeout(async () => {
            const result = await registerRssCloud(target);
            if (!isLive(feed)) return;
            if (result.success) {
                feed.state = {
                    kind: 'active',
                    via: 'rsscloud',
                    target,
                    renewTimer: scheduleRssCloudRenewal(feed, target)
                };
                return;
            }
            setState(feed, {
                kind: 'failed',
                via: 'rsscloud',
                reason: `rssCloud renewal failed: ${result.msg}`
            });
        }, deps.config.rsscloudRenewMs);
    }

    return {
        add(client: Client, urls: readonly string[]) {
            for (const url of urls) {
                const key = toFeedKey(url);
                if (key === undefined) {
                    client.send({
                        type: 'status',
                        url,
                        state: 'error',
                        detail: 'not a valid http(s) URL'
                    });
                    continue;
                }
                const existing = feeds.get(key);
                if (existing) {
                    existing.clients.set(client, url);
                    client.send(statusMessage(url, existing.state));
                    continue;
                }
                const feed: FeedSub = {
                    key,
                    state: { kind: 'discovering' },
                    clients: new Map([[client, url]]),
                    aliases: new Set()
                };
                feeds.set(key, feed);
                addAlias(feed, key);
                client.send(statusMessage(url, feed.state));
                void start(feed);
            }
        },

        removeClient(client: Client) {
            for (const feed of [...feeds.values()]) {
                if (feed.clients.delete(client) && feed.clients.size === 0) {
                    drop(feed);
                }
            }
        },

        acceptsRssCloudChallenge(url: string): boolean {
            const alias = normalizeUrl(url);
            const keys =
                alias === undefined ? undefined : aliasIndex.get(alias);
            return [...(keys ?? [])].some(key => {
                const state = feeds.get(key)?.state;
                return (
                    (state?.kind === 'subscribing' ||
                        state?.kind === 'active') &&
                    state.via === 'rsscloud'
                );
            });
        },

        notify(url: string): boolean {
            const alias = normalizeUrl(url);
            const keys =
                alias === undefined ? undefined : aliasIndex.get(alias);
            if (!keys) return false;
            for (const key of keys) {
                const feed = feeds.get(key);
                if (!feed) continue;
                for (const [client, original] of feed.clients) {
                    client.send({ type: 'update', url: original });
                }
            }
            return true;
        }
    };
}

export type Registry = ReturnType<typeof createRegistry>;

function statusMessage(url: string, state: FeedState): StatusMessage {
    switch (state.kind) {
        case 'discovering':
            return { type: 'status', url, state: 'pending' };
        case 'subscribing':
            return { type: 'status', url, state: 'pending', via: state.via };
        case 'active':
            return { type: 'status', url, state: 'subscribed', via: state.via };
        case 'unsupported':
            return {
                type: 'status',
                url,
                state: 'unsupported',
                detail: state.detail
            };
        case 'failed':
            return {
                type: 'status',
                url,
                state: 'error',
                ...(state.via && { via: state.via }),
                detail: state.reason
            };
    }
}

function errorText(err: unknown): string {
    if (err instanceof Error) {
        return err.name === 'TimeoutError' ? 'request timed out' : err.message;
    }
    return String(err);
}

function createLimiter(max: number) {
    let active = 0;
    const waiting: (() => void)[] = [];
    return async <T>(task: () => Promise<T>): Promise<T> => {
        if (active >= max) await new Promise<void>(r => waiting.push(r));
        else active++;
        try {
            return await task();
        } finally {
            const next = waiting.shift();
            if (next) next();
            else active--;
        }
    };
}
