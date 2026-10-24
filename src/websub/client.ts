import {
    errorText,
    isSuccessStatus,
    type Fetcher,
    type RequestResult
} from '../net.js';

export type HubSubscription = { hub: URL; topic: string; callback: string };

export function subscribeAtHub(
    fetcher: Fetcher,
    subscription: HubSubscription,
    secret: string,
    leaseSeconds: number
): Promise<RequestResult> {
    const form = hubForm('subscribe', subscription);
    form.set('hub.lease_seconds', String(leaseSeconds));
    form.set('hub.secret', secret);
    return postToHub(fetcher, subscription.hub, form);
}

export function unsubscribeAtHub(
    fetcher: Fetcher,
    subscription: HubSubscription
): Promise<RequestResult> {
    return postToHub(
        fetcher,
        subscription.hub,
        hubForm('unsubscribe', subscription)
    );
}

function hubForm(
    mode: 'subscribe' | 'unsubscribe',
    subscription: HubSubscription
): URLSearchParams {
    return new URLSearchParams({
        'hub.mode': mode,
        'hub.topic': subscription.topic,
        'hub.callback': subscription.callback,
        // PubSubHubbub 0.3 hubs (WordPress.com among them) reject requests
        // without hub.verify; WebSub hubs ignore it.
        'hub.verify': 'async'
    });
}

async function postToHub(
    fetcher: Fetcher,
    hub: URL,
    form: URLSearchParams
): Promise<RequestResult> {
    try {
        const res = await fetcher(hub.href, { form });
        if (isSuccessStatus(res.status)) return { ok: true };
        const body = res.body.trim().slice(0, 200);
        return {
            ok: false,
            reason: `hub returned HTTP ${res.status}${body ? `: ${body}` : ''}`
        };
    } catch (err) {
        return { ok: false, reason: errorText(err) };
    }
}
