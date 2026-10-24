import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { isHttpUrl } from './url.js';

export type FetchResult = {
    status: number;
    url: string;
    headers: Headers;
    body: string;
};

export type FetchRequest = {
    form?: URLSearchParams;
    accept?: string;
};

export type Fetcher = (
    url: string,
    request?: FetchRequest
) => Promise<FetchResult>;

export type RequestResult = { ok: true } | { ok: false; reason: string };

export type Lookup = (hostname: string) => Promise<string[]>;

export const systemLookup: Lookup = async hostname =>
    (await dnsLookup(hostname, { all: true })).map(entry => entry.address);

export type FetcherDeps = {
    fetch: typeof fetch;
    lookup: Lookup;
    timeoutMs: number;
    allowPrivateHosts: boolean;
};

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const BODY_TOO_LARGE = `response is larger than ${MAX_BODY_BYTES / (1024 * 1024)} MB`;

const blocked = new BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
] as const) {
    blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8]
] as const) {
    blocked.addSubnet(network, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return isPrivateAddress(mapped);
    const family = isIP(address);
    if (family === 4) return blocked.check(address, 'ipv4');
    if (family === 6) return blocked.check(address, 'ipv6');
    return true;
}

export function createFetcher(deps: FetcherDeps): Fetcher {
    async function assertAllowed(url: URL) {
        if (!isHttpUrl(url)) {
            throw new Error(`refusing ${url.protocol} URL`);
        }
        if (deps.allowPrivateHosts) return;
        const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
        const addresses = isIP(host) ? [host] : await deps.lookup(host);
        if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
            throw new Error(`refusing private or unresolvable host ${host}`);
        }
    }

    return async (url, request = {}) => {
        const signal = AbortSignal.timeout(deps.timeoutMs);
        const headers: Record<string, string> = { 'user-agent': 'socketsub' };
        if (request.accept) headers.accept = request.accept;
        const init: RequestInit = request.form
            ? { method: 'POST', headers, body: request.form, signal }
            : { method: 'GET', headers, signal };

        let current = new URL(url);
        for (let hop = 0; ; hop++) {
            await assertAllowed(current);
            const res = await deps.fetch(current, {
                ...init,
                redirect: 'manual'
            });
            const location = res.headers.get('location');
            if (!request.form && isRedirect(res.status) && location) {
                await res.body?.cancel();
                if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
                current = new URL(location, current);
                continue;
            }
            return {
                status: res.status,
                url: current.href,
                headers: res.headers,
                body: await readCapped(res)
            };
        }
    };
}

async function readCapped(res: Response): Promise<string> {
    if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) {
        await res.body?.cancel();
        throw new Error(BODY_TOO_LARGE);
    }
    if (!res.body) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > MAX_BODY_BYTES) throw new Error(BODY_TOO_LARGE);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function errorText(err: unknown): string {
    if (err instanceof Error) {
        return err.name === 'TimeoutError' ? 'request timed out' : err.message;
    }
    return String(err);
}

export function isSuccessStatus(status: number): boolean {
    return status >= 200 && status < 300;
}

function isRedirect(status: number): boolean {
    return [301, 302, 303, 307, 308].includes(status);
}
