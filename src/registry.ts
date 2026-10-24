import { randomBytes, randomUUID } from 'node:crypto';
import {
    callbackUrl,
    MAX_TIMER_MS,
    rsscloudCallback,
    type Config
} from './config.js';
import { discover, type Discovery } from './discover.js';
import type { Fetcher } from './net.js';
import { pleaseNotify, type NotifyResult } from './rsscloud.js';
import { hubRequest, type HubResult } from './websub.js';

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

type WebSubTarget = { hub: URL; topic: string; id: string; secret: string };

export type FeedState =
    | { kind: 'discovering' }
    | { kind: 'subscribing'; via: 'rsscloud'; target: RssCloudTarget }
    | {
          kind: 'subscribing';
          via: 'websub';
          target: WebSubTarget;
          detail?: string;
      }
    | {
          kind: 'active';
          via: 'rsscloud';
          target: RssCloudTarget;
          renewTimer: Timer;
      }
    | {
          kind: 'active';
          via: 'websub';
          target: WebSubTarget;
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
    const websubFeeds = new Map<string, FeedKey>();
    const websubUnsubscribing = new Map<string, WebSubTarget>();

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

    function webSubFeed(id: string) {
        const key = websubFeeds.get(id);
        const feed = key === undefined ? undefined : feeds.get(key);
        const state = feed?.state;
        if (
            !feed ||
            (state?.kind !== 'subscribing' && state?.kind !== 'active') ||
            state.via !== 'websub' ||
            state.target.id !== id
        ) {
            return undefined;
        }
        return { feed, state };
    }

    function drop(feed: FeedSub) {
        const { state } = feed;
        cancelRenewal(state);
        if (
            (state.kind === 'subscribing' || state.kind === 'active') &&
            state.via === 'websub'
        ) {
            const { target } = state;
            websubFeeds.delete(target.id);
            websubUnsubscribing.set(target.id, target);
            void requestHub(target, 'unsubscribe').then(result => {
                if (!result.ok) websubUnsubscribing.delete(target.id);
            });
        }
        feeds.delete(feed.key);
        for (const alias of feed.aliases) {
            const keys = aliasIndex.get(alias);
            keys?.delete(feed.key);
            if (keys?.size === 0) aliasIndex.delete(alias);
        }
    }

    function setState(feed: FeedSub, state: FeedState) {
        const previous = feed.state;
        cancelRenewal(previous);
        feed.state = state;
        if (sameStatus(previous, state)) return;
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

        let rsscloudFailure: string | undefined;
        if (discovery.rsscloud) {
            rsscloudFailure = await subscribeRssCloud(feed, {
                endpoint: discovery.rsscloud.endpoint,
                topic: discovery.finalUrl
            });
            if (rsscloudFailure === undefined || !isLive(feed)) return;
        }
        if (discovery.websub) {
            await subscribeWebSub(feed, discovery.websub, rsscloudFailure);
            return;
        }
        setState(
            feed,
            rsscloudFailure === undefined
                ? {
                      kind: 'unsupported',
                      detail: 'feed advertises neither rssCloud nor WebSub'
                  }
                : { kind: 'failed', via: 'rsscloud', reason: rsscloudFailure }
        );
    }

    async function subscribeRssCloud(
        feed: FeedSub,
        target: RssCloudTarget
    ): Promise<string | undefined> {
        // The cloud may call our challenge route before pleaseNotify
        // returns, so the feed must already be in a subscribing state.
        setState(feed, { kind: 'subscribing', via: 'rsscloud', target });
        const result = await registerRssCloud(target);
        if (!isLive(feed)) return undefined;
        if (!result.success) {
            return `rssCloud registration failed: ${result.msg}`;
        }
        setState(feed, {
            kind: 'active',
            via: 'rsscloud',
            target,
            renewTimer: scheduleRssCloudRenewal(feed, target)
        });
        return undefined;
    }

    async function subscribeWebSub(
        feed: FeedSub,
        found: { hub: URL; topic: string },
        rsscloudFailure: string | undefined
    ) {
        const target: WebSubTarget = {
            ...found,
            id: randomUUID(),
            secret: randomBytes(24).toString('hex')
        };
        addAlias(feed, target.topic);
        websubFeeds.set(target.id, feed.key);
        setState(feed, {
            kind: 'subscribing',
            via: 'websub',
            target,
            ...(rsscloudFailure && {
                detail: `${rsscloudFailure}; trying WebSub`
            })
        });
        const result = await requestHub(target, 'subscribe');
        // A teardown during the request already sent the unsubscribe.
        if (result.ok || !webSubFeed(target.id)) return;
        websubFeeds.delete(target.id);
        setState(feed, {
            kind: 'failed',
            via: 'websub',
            reason: [
                rsscloudFailure,
                `WebSub subscribe failed: ${result.detail}`
            ]
                .filter(Boolean)
                .join('; ')
        });
    }

    async function requestHub(
        target: WebSubTarget,
        mode: 'subscribe' | 'unsubscribe'
    ): Promise<HubResult> {
        const common = {
            topic: target.topic,
            callback: callbackUrl(deps.config, `/websub/${target.id}`)
        };
        try {
            return await hubRequest(
                deps.fetcher,
                target.hub,
                mode === 'subscribe'
                    ? {
                          mode,
                          ...common,
                          secret: target.secret,
                          leaseSeconds: deps.config.websubLeaseSeconds
                      }
                    : { mode, ...common }
            );
        } catch (err) {
            return { ok: false, detail: errorText(err) };
        }
    }

    function scheduleWebSubRenewal(
        feed: FeedSub,
        target: WebSubTarget,
        leaseSeconds: number
    ): Timer {
        const renewSeconds = Math.max(60, Math.floor(leaseSeconds * 0.9));
        const graceSeconds = Math.max(60, leaseSeconds - renewSeconds);
        const fail = (reason: string) => {
            websubFeeds.delete(target.id);
            setState(feed, { kind: 'failed', via: 'websub', reason });
        };
        return schedule(async () => {
            const before = feed.state;
            const result = await requestHub(target, 'subscribe');
            if (!webSubFeed(target.id)) return;
            if (!result.ok) {
                fail(`WebSub renewal failed: ${result.detail}`);
                return;
            }
            // A verification that already arrived armed the next renewal.
            if (feed.state !== before) return;
            setState(feed, {
                kind: 'active',
                via: 'websub',
                target,
                renewTimer: schedule(
                    () =>
                        fail(
                            'WebSub hub did not verify the renewal before the lease ended'
                        ),
                    graceSeconds * 1000
                )
            });
        }, renewSeconds * 1000);
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
        return schedule(async () => {
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

        verifyWebSub(
            id: string,
            intent: {
                mode: 'subscribe' | 'unsubscribe';
                topic: string;
                leaseSeconds?: number;
            }
        ): boolean {
            if (intent.mode === 'unsubscribe') {
                const target = websubUnsubscribing.get(id);
                if (!target || !sameUrl(target.topic, intent.topic)) {
                    return false;
                }
                websubUnsubscribing.delete(id);
                return true;
            }
            const found = webSubFeed(id);
            if (!found || !sameUrl(found.state.target.topic, intent.topic)) {
                return false;
            }
            const { feed, state } = found;
            setState(feed, {
                kind: 'active',
                via: 'websub',
                target: state.target,
                renewTimer: scheduleWebSubRenewal(
                    feed,
                    state.target,
                    intent.leaseSeconds ?? deps.config.websubLeaseSeconds
                )
            });
            return true;
        },

        denyWebSub(id: string, reason: string) {
            websubUnsubscribing.delete(id);
            const found = webSubFeed(id);
            if (!found) return;
            websubFeeds.delete(id);
            setState(found.feed, {
                kind: 'failed',
                via: 'websub',
                reason: `WebSub hub denied the subscription: ${reason}`
            });
        },

        webSubSubscription(
            id: string
        ): { secret: string; topic: string } | undefined {
            const target = webSubFeed(id)?.state.target;
            return target && { secret: target.secret, topic: target.topic };
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
            return {
                type: 'status',
                url,
                state: 'pending',
                via: state.via,
                ...('detail' in state &&
                    state.detail && { detail: state.detail })
            };
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

function cancelRenewal(state: FeedState) {
    if (state.kind === 'active') clearTimeout(state.renewTimer);
}

function sameStatus(a: FeedState, b: FeedState): boolean {
    return (
        JSON.stringify(statusMessage('', a)) ===
        JSON.stringify(statusMessage('', b))
    );
}

function schedule(task: () => void, delayMs: number): Timer {
    return setTimeout(task, Math.min(delayMs, MAX_TIMER_MS));
}

function sameUrl(a: string, b: string): boolean {
    return (normalizeUrl(a) ?? a) === (normalizeUrl(b) ?? b);
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
