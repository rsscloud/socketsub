import type { Config } from './config.js';
import { discover, type Discovery } from './discover.js';
import { createLimiter } from './limiter.js';
import type { Client, PushProtocol, StatusMessage } from './messages.js';
import { errorText, type Fetcher } from './net.js';
import type { RssCloudCallbacks } from './rsscloud/routes.js';
import {
    createRssCloudSubscriber,
    isRssCloudState,
    type RssCloudState
} from './rsscloud/subscriber.js';
import { normalizeUrl } from './url.js';
import type { WebSubCallbacks } from './websub/routes.js';
import {
    createWebSubSubscriber,
    isWebSubState,
    type WebSubState
} from './websub/subscriber.js';

export type FeedKey = string & { __brand: 'FeedKey' };

export type FeedState =
    | { kind: 'discovering' }
    | RssCloudState
    | WebSubState
    | { kind: 'unsupported'; detail: string }
    | { kind: 'failed'; reason: string; via?: PushProtocol };

export type FeedHandle = {
    readonly state: FeedState;
    transition(state: FeedState): void;
    isLive(): boolean;
    addAlias(url: string): void;
    sendUpdate(): void;
};

type Admission = { ok: true; key: FeedKey } | { ok: false; detail: string };

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
    const rssCloudSubscriber = createRssCloudSubscriber(deps);
    const webSubSubscriber = createWebSubSubscriber(deps);

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

    function rssCloudFeeds(url: string): FeedSub[] {
        const alias = normalizeUrl(url);
        const keys = alias === undefined ? undefined : aliasIndex.get(alias);
        return [...(keys ?? [])].flatMap(key => {
            const feed = feeds.get(key);
            return feed && isRssCloudState(feed.state) ? [feed] : [];
        });
    }

    function sendUpdate(feed: FeedSub) {
        for (const [client, original] of feed.clients) {
            client.send({ type: 'update', url: original });
        }
    }

    function handleFor(feed: FeedSub): FeedHandle {
        return {
            get state() {
                return feed.state;
            },
            transition: state => transition(feed, state),
            isLive: () => isLive(feed),
            addAlias: url => addAlias(feed, url),
            sendUpdate: () => sendUpdate(feed)
        };
    }

    function drop(feed: FeedSub) {
        const { state } = feed;
        cancelTimer(state);
        if (isWebSubState(state)) webSubSubscriber.unsubscribe(state.target);
        feeds.delete(feed.key);
        for (const alias of feed.aliases) {
            const keys = aliasIndex.get(alias);
            keys?.delete(feed.key);
            if (keys?.size === 0) aliasIndex.delete(alias);
        }
    }

    function transition(feed: FeedSub, state: FeedState) {
        const previous = feed.state;
        cancelTimer(previous);
        feed.state = state;
        if (sameStatus(previous, state)) return;
        for (const [client, url] of feed.clients) {
            client.send(statusMessage(url, state));
        }
    }

    function admit(followed: Set<FeedKey>, url: string): Admission {
        const { maxFeedsPerClient, maxFeeds } = deps.config;
        const key = toFeedKey(url);
        if (key === undefined) {
            return { ok: false, detail: 'not a valid http(s) URL' };
        }
        if (!followed.has(key) && followed.size >= maxFeedsPerClient) {
            return {
                ok: false,
                detail: `this connection already follows the maximum of ${maxFeedsPerClient} feeds`
            };
        }
        if (!feeds.has(key) && feeds.size >= maxFeeds) {
            return {
                ok: false,
                detail: `the server already follows the maximum of ${maxFeeds} feeds`
            };
        }
        return { ok: true, key };
    }

    function follow(client: Client, url: string, key: FeedKey) {
        const existing = feeds.get(key);
        if (existing) {
            existing.clients.set(client, url);
            client.send(statusMessage(url, existing.state));
            return;
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

    async function start(feed: FeedSub) {
        const discovery = await discoverLive(feed);
        if (!discovery) return;
        const handle = handleFor(feed);

        let rssCloudFailure: string | undefined;
        if (discovery.rssCloud) {
            const outcome = await rssCloudSubscriber.subscribe(handle, {
                endpoint: discovery.rssCloud.endpoint,
                topic: discovery.finalUrl
            });
            if (outcome.kind !== 'failed') return;
            rssCloudFailure = outcome.reason;
        }
        if (discovery.webSub) {
            await webSubSubscriber.subscribe(
                handle,
                discovery.webSub,
                rssCloudFailure
            );
            return;
        }
        handle.transition(
            rssCloudFailure === undefined
                ? {
                      kind: 'unsupported',
                      detail: 'feed advertises neither rssCloud nor WebSub'
                  }
                : { kind: 'failed', via: 'rsscloud', reason: rssCloudFailure }
        );
    }

    async function discoverLive(feed: FeedSub): Promise<Discovery | undefined> {
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
            return undefined;
        }
        if (!discovery || !isLive(feed)) return undefined;
        addAlias(feed, discovery.finalUrl);
        return discovery;
    }

    const rssCloud: RssCloudCallbacks = {
        acceptsChallenge: url => rssCloudFeeds(url).length > 0,
        notify(url) {
            for (const feed of rssCloudFeeds(url)) sendUpdate(feed);
        }
    };

    const webSub: WebSubCallbacks = webSubSubscriber.callbacks;

    return {
        add(client: Client, urls: readonly string[]) {
            let followed = clientFeeds.get(client);
            if (!followed) clientFeeds.set(client, (followed = new Set()));
            for (const url of urls) {
                const admission = admit(followed, url);
                if (!admission.ok) {
                    client.send({
                        type: 'status',
                        url,
                        state: 'error',
                        detail: admission.detail
                    });
                    continue;
                }
                followed.add(admission.key);
                follow(client, url, admission.key);
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

        rssCloud,
        webSub
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

function cancelTimer(state: FeedState) {
    if ('timer' in state) clearTimeout(state.timer);
}

function sameStatus(a: FeedState, b: FeedState): boolean {
    return (
        JSON.stringify(statusMessage('', a)) ===
        JSON.stringify(statusMessage('', b))
    );
}
