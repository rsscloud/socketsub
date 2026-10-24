import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Fetcher } from './net.js';
import type { Registry } from './registry.js';

export type HubRequest =
    | {
          mode: 'subscribe';
          topic: string;
          callback: string;
          secret: string;
          leaseSeconds: number;
      }
    | { mode: 'unsubscribe'; topic: string; callback: string };

export type HubResult = { ok: true } | { ok: false; detail: string };

export async function hubRequest(
    fetcher: Fetcher,
    hub: URL,
    request: HubRequest
): Promise<HubResult> {
    const form = new URLSearchParams({
        'hub.mode': request.mode,
        'hub.topic': request.topic,
        'hub.callback': request.callback,
        // PubSubHubbub 0.3 hubs (WordPress.com among them) reject requests
        // without hub.verify; WebSub hubs ignore it.
        'hub.verify': 'async'
    });
    if (request.mode === 'subscribe') {
        form.set('hub.lease_seconds', String(request.leaseSeconds));
        form.set('hub.secret', request.secret);
    }
    const res = await fetcher(hub.href, { form });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const body = res.body.trim().slice(0, 200);
    return {
        ok: false,
        detail: `hub returned HTTP ${res.status}${body ? `: ${body}` : ''}`
    };
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

export function websubRoutes(registry: Registry) {
    const routes = new Hono();
    routes.use(bodyLimit({ maxSize: 10 * 1024 * 1024 }));

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
        const subscription = registry.webSubSubscription(c.req.param('id'));
        if (!subscription) return c.body(null, 410);
        const body = new Uint8Array(await c.req.arrayBuffer());
        if (
            signatureValid(
                subscription.secret,
                c.req.header('x-hub-signature'),
                body
            )
        ) {
            registry.notify(subscription.topic);
        }
        return c.body(null, 204);
    });

    return routes;
}
