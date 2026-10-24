import { XMLParser } from 'fast-xml-parser';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { RssCloudCallback } from './config.js';
import { errorText, type Fetcher, type RequestResult } from './net.js';
import type { Registry } from './registry.js';

const xml = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false
});

export async function pleaseNotify(
    fetcher: Fetcher,
    endpoint: URL,
    callback: RssCloudCallback,
    feedUrl: string
): Promise<RequestResult> {
    const form = new URLSearchParams({
        domain: callback.domain,
        port: String(callback.port),
        path: callback.path,
        protocol: callback.protocol,
        url1: feedUrl
    });
    try {
        const res = await fetcher(endpoint.href, {
            form,
            accept: 'application/json'
        });
        return parseNotifyResult(res.status, res.body);
    } catch (err) {
        return { ok: false, reason: errorText(err) };
    }
}

function parseNotifyResult(status: number, body: string): RequestResult {
    const unexpected = `unexpected response (HTTP ${status})`;
    const result = (success: boolean, msg: string): RequestResult =>
        success ? { ok: true } : { ok: false, reason: msg };
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
        try {
            const json = JSON.parse(trimmed) as Record<string, unknown>;
            return result(
                json.success === true || json.success === 'true',
                typeof json.msg === 'string' ? json.msg : unexpected
            );
        } catch {
            return result(false, unexpected);
        }
    }
    try {
        const doc = xml.parse(trimmed) as {
            notifyResult?: { success?: string; msg?: string };
        };
        const notifyResult = doc.notifyResult;
        if (!notifyResult) return result(false, unexpected);
        return result(
            notifyResult.success === 'true',
            notifyResult.msg ?? unexpected
        );
    } catch {
        return result(false, unexpected);
    }
}

const NOTIFY_BODY_LIMIT_BYTES = 1024 * 1024;

export function rssCloudRoutes(registry: Registry) {
    const routes = new Hono();
    routes.use(bodyLimit({ maxSize: NOTIFY_BODY_LIMIT_BYTES }));

    routes.get('/notify', c => {
        const url = c.req.query('url');
        const challenge = c.req.query('challenge');
        if (!url || challenge === undefined) return c.notFound();
        if (!registry.acceptsRssCloudChallenge(url)) return c.notFound();
        return c.text(challenge);
    });

    routes.post('/notify', async c => {
        const body = await c.req.parseBody();
        const url = body.url;
        if (typeof url === 'string') registry.notifyRssCloud(url);
        return c.text('ok');
    });

    return routes;
}
