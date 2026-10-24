import { randomBytes, randomUUID } from 'node:crypto';
import { callbackUrl, type Config } from '../config.js';
import type { Fetcher } from '../net.js';
import type { FeedHandle, FeedState } from '../registry.js';
import { schedule, type Timer } from '../timer.js';
import { sameUrl } from '../url.js';
import {
    subscribeAtHub,
    unsubscribeAtHub,
    type HubSubscription
} from './client.js';
import type { VerificationRequest, WebSubCallbacks } from './routes.js';

const UNSUBSCRIBE_VERIFY_WINDOW_MS = 10 * 60_000;
const RENEW_AT_LEASE_FRACTION = 0.9;
const MIN_RENEW_SECONDS = 60;
const SECRET_BYTES = 24;

export type WebSubTarget = {
    hub: URL;
    topic: string;
    id: string;
    secret: string;
};

export type WebSubState =
    | {
          kind: 'subscribing';
          via: 'websub';
          target: WebSubTarget;
          detail?: string;
      }
    | {
          kind: 'active';
          via: 'websub';
          target: WebSubTarget;
          renewal: 'scheduled' | 'awaiting-verification';
          timer: Timer;
      }
    | {
          kind: 'active';
          via: 'websub';
          target: WebSubTarget;
          renewal: 'requested';
      };

export function isWebSubState(state: FeedState): state is WebSubState {
    return (
        (state.kind === 'subscribing' || state.kind === 'active') &&
        state.via === 'websub'
    );
}

export function createWebSubSubscriber(deps: {
    config: Config;
    fetcher: Fetcher;
}) {
    const feedById = new Map<string, FeedHandle>();
    const unsubscribing = new Map<string, WebSubTarget>();

    function subscription(id: string) {
        const feed = feedById.get(id);
        if (!feed?.isLive()) return undefined;
        const { state } = feed;
        if (!isWebSubState(state) || state.target.id !== id) return undefined;
        return { feed, state };
    }

    function hubSubscription(target: WebSubTarget): HubSubscription {
        return {
            hub: target.hub,
            topic: target.topic,
            callback: callbackUrl(deps.config, `/websub/${target.id}`)
        };
    }

    function requestSubscription(target: WebSubTarget) {
        return subscribeAtHub(
            deps.fetcher,
            hubSubscription(target),
            target.secret,
            deps.config.webSubLeaseSeconds
        );
    }

    function fail(feed: FeedHandle, target: WebSubTarget, reason: string) {
        feedById.delete(target.id);
        feed.transition({ kind: 'failed', via: 'websub', reason });
    }

    function scheduleRenewal(
        feed: FeedHandle,
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
        return schedule(
            () => void renew(feed, target, graceSeconds),
            renewSeconds * 1000
        );
    }

    async function renew(
        feed: FeedHandle,
        target: WebSubTarget,
        graceSeconds: number
    ) {
        feed.transition({
            kind: 'active',
            via: 'websub',
            target,
            renewal: 'requested'
        });
        const result = await requestSubscription(target);
        const found = subscription(target.id);
        if (!found) return;
        if (!result.ok) {
            fail(feed, target, `WebSub renewal failed: ${result.reason}`);
            return;
        }
        if (
            found.state.kind !== 'active' ||
            found.state.renewal !== 'requested'
        ) {
            return;
        }
        feed.transition({
            kind: 'active',
            via: 'websub',
            target,
            renewal: 'awaiting-verification',
            timer: schedule(
                () =>
                    fail(
                        feed,
                        target,
                        'WebSub hub did not verify the renewal before the lease ended'
                    ),
                graceSeconds * 1000
            )
        });
    }

    const callbacks: WebSubCallbacks = {
        verify(id: string, request: VerificationRequest): boolean {
            if (request.mode === 'unsubscribe') {
                const target = unsubscribing.get(id);
                if (!target || !sameUrl(target.topic, request.topic)) {
                    return false;
                }
                unsubscribing.delete(id);
                return true;
            }
            const found = subscription(id);
            if (!found || !sameUrl(found.state.target.topic, request.topic)) {
                return false;
            }
            const { feed, state } = found;
            feed.transition({
                kind: 'active',
                via: 'websub',
                target: state.target,
                renewal: 'scheduled',
                timer: scheduleRenewal(
                    feed,
                    state.target,
                    request.leaseSeconds ?? deps.config.webSubLeaseSeconds
                )
            });
            return true;
        },

        deny(id: string, reason: string) {
            unsubscribing.delete(id);
            const found = subscription(id);
            if (!found) return;
            fail(
                found.feed,
                found.state.target,
                `WebSub hub denied the subscription: ${reason}`
            );
        },

        secret(id: string): string | undefined {
            return subscription(id)?.state.target.secret;
        },

        notify(id: string) {
            subscription(id)?.feed.sendUpdate();
        }
    };

    return {
        callbacks,

        async subscribe(
            feed: FeedHandle,
            found: { hub: URL; topic: string },
            rssCloudFailure: string | undefined
        ) {
            const target: WebSubTarget = {
                ...found,
                id: randomUUID(),
                secret: randomBytes(SECRET_BYTES).toString('hex')
            };
            feed.addAlias(target.topic);
            feedById.set(target.id, feed);
            feed.transition({
                kind: 'subscribing',
                via: 'websub',
                target,
                ...(rssCloudFailure && {
                    detail: `${rssCloudFailure}; trying WebSub`
                })
            });
            const result = await requestSubscription(target);
            // A teardown during the request already sent the unsubscribe.
            if (result.ok || !subscription(target.id)) return;
            fail(
                feed,
                target,
                [rssCloudFailure, `WebSub subscribe failed: ${result.reason}`]
                    .filter(Boolean)
                    .join('; ')
            );
        },

        unsubscribe(target: WebSubTarget) {
            feedById.delete(target.id);
            unsubscribing.set(target.id, target);
            setTimeout(
                () => unsubscribing.delete(target.id),
                UNSUBSCRIBE_VERIFY_WINDOW_MS
            ).unref();
            void unsubscribeAtHub(deps.fetcher, hubSubscription(target)).then(
                result => {
                    if (!result.ok) unsubscribing.delete(target.id);
                }
            );
        }
    };
}
