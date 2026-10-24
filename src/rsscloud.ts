import { XMLParser } from 'fast-xml-parser';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { RssCloudCallback } from './config.js';
import type { Fetcher } from './net.js';
import type { Registry } from './registry.js';

export type NotifyResult = { success: boolean; msg: string };

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
): Promise<NotifyResult> {
    const form = new URLSearchParams({
        domain: callback.domain,
        port: String(callback.port),
        path: callback.path,
        protocol: callback.protocol,
        url1: feedUrl
    });
    const res = await fetcher(endpoint.href, {
        form,
        accept: 'application/json'
    });
    return parseNotifyResult(res.status, res.body);
}

function parseNotifyResult(status: number, body: string): NotifyResult {
    const fallback = {
        success: false,
        msg: `unexpected response (HTTP ${status})`
    };
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
        try {
            const json = JSON.parse(trimmed) as Record<string, unknown>;
            return {
                success: json.success === true || json.success === 'true',
                msg: typeof json.msg === 'string' ? json.msg : fallback.msg
            };
        } catch {
            return fallback;
        }
    }
    try {
        const doc = xml.parse(trimmed) as {
            notifyResult?: { success?: string; msg?: string };
        };
        const result = doc.notifyResult;
        if (!result) return fallback;
        return {
            success: result.success === 'true',
            msg: result.msg ?? fallback.msg
        };
    } catch {
        return fallback;
    }
}

export function rsscloudRoutes(registry: Registry) {
    const routes = new Hono();
    routes.use(bodyLimit({ maxSize: 1024 * 1024 }));

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
