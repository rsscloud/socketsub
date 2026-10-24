import { randomBytes, randomUUID } from 'node:crypto';
import {
    callbackUrl,
    MAX_TIMER_MS,
    rssCloudCallback,
    type Config
} from './config.js';
import { discover, type Discovery } from './discover.js';
import { createLimiter } from './limiter.js';
import type { Client, PushProtocol, StatusMessage } from './messages.js';
import { errorText, type Fetcher } from './net.js';
import { pleaseNotify } from './rsscloud.js';
import { normalizeUrl, sameUrl } from './url.js';
import { subscribeAtHub, unsubscribeAtHub } from './websub.js';

export type FeedKey = string & { __brand: 'FeedKey' };

type Timer = ReturnType<typeof setTimeout>;

const UNSUBSCRIBE_VERIFY_WINDOW_MS = 10 * 60_000;
const RENEW_AT_LEASE_FRACTION = 0.9;
const MIN_RENEW_SECONDS = 60;
const SECRET_BYTES = 24;

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
    | { kind: 'failed'; reason: string; via?: PushProtocol };

type RssCloudOutcome =
    | { kind: 'subscribed' }
    | { kind: 'dropped' }
    | { kind: 'failed'; reason: string };

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

export function createRegistry(deps: RegistryDeps) {
    const feeds = new Map<FeedKey, FeedSub>();
    const clientFeeds = new Map<Client, Set<FeedKey>>();
    const aliasIndex = new Map<string, Set<FeedKey>>();
    const limit = createLimiter(deps.config.discoveryConcurrency);
    const callback = rssCloudCallback(deps.config);
    const feedKeyByWebSubId = new Map<string, FeedKey>();
    const webSubUnsubscribing = new Map<string, WebSubTarget>();

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
        const key = feedKeyByWebSubId.get(id);
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

    function rssCloudFeeds(url: string): FeedSub[] {
        const alias = normalizeUrl(url);
        const keys = alias === undefined ? undefined : aliasIndex.get(alias);
        return [...(keys ?? [])].flatMap(key => {
            const feed = feeds.get(key);
            const state = feed?.state;
            return feed &&
                (state?.kind === 'subscribing' || state?.kind === 'active') &&
                state.via === 'rsscloud'
                ? [feed]
                : [];
        });
    }

    function sendUpdate(feed: FeedSub) {
        for (const [client, original] of feed.clients) {
            client.send({ type: 'update', url: original });
        }
    }

    function drop(feed: FeedSub) {
        const { state } = feed;
        cancelRenewal(state);
        if (
            (state.kind === 'subscribing' || state.kind === 'active') &&
            state.via === 'websub'
        ) {
            const { target } = state;
            feedKeyByWebSubId.delete(target.id);
            webSubUnsubscribing.set(target.id, target);
            setTimeout(
                () => webSubUnsubscribing.delete(target.id),
                UNSUBSCRIBE_VERIFY_WINDOW_MS
            ).unref();
            void unsubscribeAtHub(deps.fetcher, hubSubscription(target)).then(
                result => {
                    if (!result.ok) webSubUnsubscribing.delete(target.id);
                }
            );
        }
        feeds.delete(feed.key);
        for (const alias of feed.aliases) {
            const keys = aliasIndex.get(alias);
            keys?.delete(feed.key);
            if (keys?.size === 0) aliasIndex.delete(alias);
        }
    }

    function transition(feed: FeedSub, state: FeedState) {
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
                transition(feed, { kind: 'failed', reason: errorText(err) });
            }
            return;
        }
        if (!discovery || !isLive(feed)) return;
        addAlias(feed, discovery.finalUrl);

        let rssCloudFailure: string | undefined;
        if (discovery.rssCloud) {
            const outcome = await subscribeRssCloud(feed, {
                endpoint: discovery.rssCloud.endpoint,
                topic: discovery.finalUrl
            });
            if (outcome.kind !== 'failed') return;
            rssCloudFailure = outcome.reason;
        }
        if (discovery.webSub) {
            await subscribeWebSub(feed, discovery.webSub, rssCloudFailure);
            return;
        }
        transition(
            feed,
            rssCloudFailure === undefined
                ? {
                      kind: 'unsupported',
                      detail: 'feed advertises neither rssCloud nor WebSub'
                  }
                : { kind: 'failed', via: 'rsscloud', reason: rssCloudFailure }
        );
    }

    async function subscribeRssCloud(
        feed: FeedSub,
        target: RssCloudTarget
    ): Promise<RssCloudOutcome> {
        // The cloud may call our challenge route before pleaseNotify
        // returns, so the feed must already be in a subscribing state.
        transition(feed, { kind: 'subscribing', via: 'rsscloud', target });
        const result = await pleaseNotify(
            deps.fetcher,
            target.endpoint,
            callback,
            target.topic
        );
        if (!isLive(feed)) return { kind: 'dropped' };
        if (!result.ok) {
            return {
                kind: 'failed',
                reason: `rssCloud registration failed: ${result.reason}`
            };
        }
        transition(feed, {
            kind: 'active',
            via: 'rsscloud',
            target,
            renewTimer: scheduleRssCloudRenewal(feed, target)
        });
        return { kind: 'subscribed' };
    }

    async function subscribeWebSub(
        feed: FeedSub,
        found: { hub: URL; topic: string },
        rssCloudFailure: string | undefined
    ) {
        const target: WebSubTarget = {
            ...found,
            id: randomUUID(),
            secret: randomBytes(SECRET_BYTES).toString('hex')
        };
        addAlias(feed, target.topic);
        feedKeyByWebSubId.set(target.id, feed.key);
        transition(feed, {
            kind: 'subscribing',
            via: 'websub',
            target,
            ...(rssCloudFailure && {
                detail: `${rssCloudFailure}; trying WebSub`
            })
        });
        const result = await subscribeToHub(target);
        // A teardown during the request already sent the unsubscribe.
        if (result.ok || !webSubFeed(target.id)) return;
        feedKeyByWebSubId.delete(target.id);
        transition(feed, {
            kind: 'failed',
            via: 'websub',
            reason: [
                rssCloudFailure,
                `WebSub subscribe failed: ${result.reason}`
            ]
                .filter(Boolean)
                .join('; ')
        });
    }

    function hubSubscription(target: WebSubTarget) {
        return {
            hub: target.hub,
            topic: target.topic,
            callback: callbackUrl(deps.config, `/websub/${target.id}`)
        };
    }

    function subscribeToHub(target: WebSubTarget) {
        return subscribeAtHub(
            deps.fetcher,
            hubSubscription(target),
            target.secret,
            deps.config.webSubLeaseSeconds
        );
    }

    function scheduleWebSubRenewal(
        feed: FeedSub,
        target: WebSubTarget,
        leaseSeconds: number
    ): Timer {
        const renewSeconds = Math.max(
            MIN_RENEW_SECONDS,
            Math.floor(leaseSeconds * RENEW_AT_LEASE_FRACTION)
        );
        const graceSeconds = Math.max(
            MIN_RENEW_SECONDS,
            leaseSeconds - renewSeconds
        );
        const fail = (reason: string) => {
            feedKeyByWebSubId.delete(target.id);
            transition(feed, { kind: 'failed', via: 'websub', reason });
        };
        return schedule(async () => {
            const before = feed.state;
            const result = await subscribeToHub(target);
            if (!webSubFeed(target.id)) return;
            if (!result.ok) {
                fail(`WebSub renewal failed: ${result.reason}`);
                return;
            }
            // A verification that already arrived armed the next renewal.
            if (feed.state !== before) return;
            transition(feed, {
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

    function scheduleRssCloudRenewal(
        feed: FeedSub,
        target: RssCloudTarget
    ): Timer {
        return schedule(async () => {
            const result = await pleaseNotify(
                deps.fetcher,
                target.endpoint,
                callback,
                target.topic
            );
            if (!isLive(feed)) return;
            if (result.ok) {
                transition(feed, {
                    kind: 'active',
                    via: 'rsscloud',
                    target,
                    renewTimer: scheduleRssCloudRenewal(feed, target)
                });
                return;
            }
            transition(feed, {
                kind: 'failed',
                via: 'rsscloud',
                reason: `rssCloud renewal failed: ${result.reason}`
            });
        }, deps.config.rssCloudRenewMs);
    }

    return {
        add(client: Client, urls: readonly string[]) {
            const { maxFeedsPerClient, maxFeeds } = deps.config;
            let followed = clientFeeds.get(client);
            if (!followed) clientFeeds.set(client, (followed = new Set()));
            const reject = (url: string, detail: string) =>
                client.send({ type: 'status', url, state: 'error', detail });
            for (const url of urls) {
                const key = toFeedKey(url);
                if (key === undefined) {
                    reject(url, 'not a valid http(s) URL');
                    continue;
                }
                const existing = feeds.get(key);
                if (!followed.has(key) && followed.size >= maxFeedsPerClient) {
                    reject(
                        url,
                        `this connection already follows the maximum of ${maxFeedsPerClient} feeds`
                    );
                    continue;
                }
                if (!existing && feeds.size >= maxFeeds) {
                    reject(
                        url,
                        `the server already follows the maximum of ${maxFeeds} feeds`
                    );
                    continue;
                }
                followed.add(key);
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
            for (const key of clientFeeds.get(client) ?? []) {
                const feed = feeds.get(key);
                if (feed?.clients.delete(client) && feed.clients.size === 0) {
                    drop(feed);
                }
            }
            clientFeeds.delete(client);
        },

        acceptsRssCloudChallenge(url: string): boolean {
            return rssCloudFeeds(url).length > 0;
        },

        notifyRssCloud(url: string) {
            for (const feed of rssCloudFeeds(url)) sendUpdate(feed);
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
                const target = webSubUnsubscribing.get(id);
                if (!target || !sameUrl(target.topic, intent.topic)) {
                    return false;
                }
                webSubUnsubscribing.delete(id);
                return true;
            }
            const found = webSubFeed(id);
            if (!found || !sameUrl(found.state.target.topic, intent.topic)) {
                return false;
            }
            const { feed, state } = found;
            transition(feed, {
                kind: 'active',
                via: 'websub',
                target: state.target,
                renewTimer: scheduleWebSubRenewal(
                    feed,
                    state.target,
                    intent.leaseSeconds ?? deps.config.webSubLeaseSeconds
                )
            });
            return true;
        },

        denyWebSub(id: string, reason: string) {
            webSubUnsubscribing.delete(id);
            const found = webSubFeed(id);
            if (!found) return;
            feedKeyByWebSubId.delete(id);
            transition(found.feed, {
                kind: 'failed',
                via: 'websub',
                reason: `WebSub hub denied the subscription: ${reason}`
            });
        },

        webSubSecret(id: string): string | undefined {
            return webSubFeed(id)?.state.target.secret;
        },

        notifyWebSub(id: string) {
            const found = webSubFeed(id);
            if (found) sendUpdate(found.feed);
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
