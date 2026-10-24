import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
    errorText,
    isSuccessStatus,
    type Fetcher,
    type RequestResult
} from './net.js';
import type { Registry } from './registry.js';

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

const ALGORITHMS = new Set(['sha1', 'sha256', 'sha384', 'sha512']);

export function signatureValid(
    secret: string,
    header: string | undefined,
    body: Uint8Array
): boolean {
    const match = /^(sha1|sha256|sha384|sha512)=([0-9a-f]+)$/i.exec(
        header?.trim() ?? ''
    );
    const algorithm = match?.[1]?.toLowerCase();
    const hex = match?.[2];
    if (!algorithm || !hex || !ALGORITHMS.has(algorithm)) return false;
    const expected = createHmac(algorithm, secret).update(body).digest();
    const given = Buffer.from(hex, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
}

const DELIVERY_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export function webSubRoutes(registry: Registry) {
    const routes = new Hono();
    routes.use(bodyLimit({ maxSize: DELIVERY_BODY_LIMIT_BYTES }));

    routes.get('/:id', c => {
        const id = c.req.param('id');
        const mode = c.req.query('hub.mode');
        const topic = c.req.query('hub.topic') ?? '';
        if (mode === 'denied') {
            registry.denyWebSub(
                id,
                c.req.query('hub.reason') ?? 'no reason given'
            );
            return c.text('ok');
        }
        const challenge = c.req.query('hub.challenge');
        if (
            (mode !== 'subscribe' && mode !== 'unsubscribe') ||
            challenge === undefined
        ) {
            return c.notFound();
        }
        const lease = Number(c.req.query('hub.lease_seconds'));
        const verified = registry.verifyWebSub(id, {
            mode,
            topic,
            ...(Number.isInteger(lease) && lease > 0 && { leaseSeconds: lease })
        });
        return verified ? c.text(challenge) : c.notFound();
    });

    routes.post('/:id', async c => {
        const id = c.req.param('id');
        const secret = registry.webSubSecret(id);
        if (secret === undefined) return c.body(null, 410);
        const body = new Uint8Array(await c.req.arrayBuffer());
        if (signatureValid(secret, c.req.header('x-hub-signature'), body)) {
            registry.notifyWebSub(id);
        }
        return c.body(null, 204);
    });

    return routes;
}
