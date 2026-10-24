import { rssCloudCallback, type Config } from '../config.js';
import type { Fetcher } from '../net.js';
import type { FeedHandle, FeedState } from '../registry.js';
import { schedule, type Timer } from '../timer.js';
import { pleaseNotify } from './client.js';

export type RssCloudTarget = { endpoint: URL; topic: string };

export type RssCloudState =
    | { kind: 'subscribing'; via: 'rsscloud'; target: RssCloudTarget }
    | {
          kind: 'active';
          via: 'rsscloud';
          target: RssCloudTarget;
          timer: Timer;
      };

export type RssCloudOutcome =
    | { kind: 'subscribed' }
    | { kind: 'dropped' }
    | { kind: 'failed'; reason: string };

export function isRssCloudState(state: FeedState): state is RssCloudState {
    return (
        (state.kind === 'subscribing' || state.kind === 'active') &&
        state.via === 'rsscloud'
    );
}

export function createRssCloudSubscriber(deps: {
    config: Config;
    fetcher: Fetcher;
}) {
    const callback = rssCloudCallback(deps.config);

    function register(target: RssCloudTarget) {
        return pleaseNotify(
            deps.fetcher,
            target.endpoint,
            callback,
            target.topic
        );
    }

    function activate(feed: FeedHandle, target: RssCloudTarget) {
        feed.transition({
            kind: 'active',
            via: 'rsscloud',
            target,
            timer: schedule(
                () => void renew(feed, target),
                deps.config.rssCloudRenewMs
            )
        });
    }

    async function renew(feed: FeedHandle, target: RssCloudTarget) {
        const result = await register(target);
        if (!feed.isLive()) return;
        if (result.ok) {
            activate(feed, target);
            return;
        }
        feed.fail(
            `rssCloud renewal failed: ${result.reason}`,
            'rsscloud',
            target.endpoint
        );
    }

    return {
        async subscribe(
            feed: FeedHandle,
            target: RssCloudTarget
        ): Promise<RssCloudOutcome> {
            // The cloud may call our challenge route before pleaseNotify
            // returns, so the feed must already be in a subscribing state.
            feed.transition({ kind: 'subscribing', via: 'rsscloud', target });
            const result = await register(target);
            if (!feed.isLive()) return { kind: 'dropped' };
            if (!result.ok) {
                return {
                    kind: 'failed',
                    reason: `rssCloud registration failed: ${result.reason}`
                };
            }
            activate(feed, target);
            return { kind: 'subscribed' };
        }
    };
}
