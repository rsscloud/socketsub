import { rssCloudCallback } from '../config.js';
import type { FeedHandle, FeedState, RegistryDeps } from '../registry.js';
import { schedule, type Timer } from '../timer.js';
import { pleaseNotify } from './client.js';

// Clouds drop registrations not renewed within 25 hours.
const REGISTRATION_TTL_MS = 25 * 3600_000;

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

export function createRssCloudSubscriber(deps: RegistryDeps) {
    const callback = rssCloudCallback(deps.config);

    function register(target: RssCloudTarget, lastChance = false) {
        return pleaseNotify(
            deps.fetcher,
            target.endpoint,
            callback,
            target.topic,
            lastChance
        );
    }

    function activate(feed: FeedHandle, target: RssCloudTarget) {
        scheduleRenewal(
            feed,
            target,
            deps.now() + REGISTRATION_TTL_MS,
            deps.config.rssCloudRenewMs,
            false
        );
    }

    function scheduleRenewal(
        feed: FeedHandle,
        target: RssCloudTarget,
        expiresAt: number,
        delayMs: number,
        lastChance: boolean
    ) {
        feed.transition({
            kind: 'active',
            via: 'rsscloud',
            target,
            timer: schedule(
                () => void renew(feed, target, expiresAt, lastChance),
                delayMs
            )
        });
    }

    async function renew(
        feed: FeedHandle,
        target: RssCloudTarget,
        expiresAt: number,
        lastChance: boolean
    ) {
        const result = await register(target, lastChance);
        if (!feed.isLive()) return;
        if (result.ok) {
            activate(feed, target);
            return;
        }
        const { origin } = target.endpoint;
        const retry = deps.backoff.retryAt(
            origin,
            expiresAt,
            result.failure,
            lastChance
        );
        if (retry) {
            scheduleRenewal(
                feed,
                target,
                expiresAt,
                retry.at - deps.now(),
                retry.lastChance
            );
            return;
        }
        const late =
            result.failure !== 'refused'
                ? '; the registration expires before the cloud can be retried'
                : '';
        feed.fail(
            `rssCloud renewal failed: ${result.reason}${late}`,
            'rsscloud',
            origin
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
