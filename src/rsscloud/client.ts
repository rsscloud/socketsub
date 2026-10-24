import { XMLParser } from 'fast-xml-parser';
import type { RssCloudCallback } from '../config.js';
import {
    failedRequest,
    statusFailure,
    type Fetcher,
    type RequestResult
} from '../net.js';

const xml = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false
});

export async function pleaseNotify(
    fetcher: Fetcher,
    endpoint: URL,
    callback: RssCloudCallback,
    feedUrl: string,
    lastChance = false
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
            accept: 'application/json',
            lastChance
        });
        const reason = parseNotifyResult(res.status, res.body);
        return reason === undefined
            ? { ok: true }
            : { ok: false, reason, failure: statusFailure(res.status) };
    } catch (err) {
        return failedRequest(err);
    }
}

// The cloud's reason for refusing, or undefined when it accepted.
function parseNotifyResult(status: number, body: string): string | undefined {
    const unexpected = `unexpected response (HTTP ${status})`;
    const result = (success: boolean, msg: string) =>
        success ? undefined : msg;
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
