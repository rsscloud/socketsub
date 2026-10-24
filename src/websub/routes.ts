import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { signatureValid } from './signature.js';

export type VerificationRequest = {
    mode: 'subscribe' | 'unsubscribe';
    topic: string;
    leaseSeconds?: number;
};

export type WebSubCallbacks = {
    verify(id: string, request: VerificationRequest): boolean;
    deny(id: string, reason: string): void;
    secret(id: string): string | undefined;
    notify(id: string): void;
};

const DELIVERY_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export function webSubRoutes(webSub: WebSubCallbacks) {
    const routes = new Hono();
    routes.use(bodyLimit({ maxSize: DELIVERY_BODY_LIMIT_BYTES }));

    routes.get('/:id', c => {
        const id = c.req.param('id');
        const mode = c.req.query('hub.mode');
        const topic = c.req.query('hub.topic') ?? '';
        if (mode === 'denied') {
            webSub.deny(id, c.req.query('hub.reason') ?? 'no reason given');
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
        const verified = webSub.verify(id, {
            mode,
            topic,
            ...(Number.isInteger(lease) && lease > 0 && { leaseSeconds: lease })
        });
        return verified ? c.text(challenge) : c.notFound();
    });

    routes.post('/:id', async c => {
        const id = c.req.param('id');
        const secret = webSub.secret(id);
        if (secret === undefined) return c.body(null, 410);
        const body = new Uint8Array(await c.req.arrayBuffer());
        if (signatureValid(secret, c.req.header('x-hub-signature'), body)) {
            webSub.notify(id);
        }
        return c.body(null, 204);
    });

    return routes;
}
