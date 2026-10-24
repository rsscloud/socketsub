import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { isServerTrouble, type Backoff, type Exchange } from './backoff.js';
import { createKeyedLimiter } from './limiter.js';
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
    // The caller's subscription lapses unless this request goes out now.
    lastChance?: boolean;
};

export type Fetcher = (
    url: string,
    request?: FetchRequest
) => Promise<FetchResult>;

// `refused`: retrying will not help. `transient`: the server failed or could
// not be reached. `deferred`: not sent because the origin is cooling down.
export type RequestFailure = 'refused' | 'transient' | 'deferred';

export type RequestResult =
    { ok: true } | { ok: false; reason: string; failure: RequestFailure };

export class FetchError extends Error {
    constructor(
        message: string,
        readonly origin: string,
        readonly failure: RequestFailure,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'FetchError';
    }
}

export class CoolingDownError extends FetchError {
    constructor(origin: string, until: number) {
        super(
            `${origin} failed recently; not contacting it before ${new Date(until).toISOString()}`,
            origin,
            'deferred'
        );
        this.name = 'CoolingDownError';
    }
}

export type Lookup = (hostname: string) => Promise<string[]>;

export const systemLookup: Lookup = async hostname =>
    (await dnsLookup(hostname, { all: true })).map(entry => entry.address);

export type FetcherDeps = {
    fetch: typeof fetch;
    lookup: Lookup;
    timeoutMs: number;
    allowPrivateHosts: boolean;
    backoff: Backoff;
};

const MAX_REDIRECTS = 5;
const MAX_REQUESTS_PER_ORIGIN = 4;
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

type Hop =
    { kind: 'redirect'; to: URL } | { kind: 'done'; result: FetchResult };

export function createFetcher(deps: FetcherDeps): Fetcher {
    const limit = createKeyedLimiter(MAX_REQUESTS_PER_ORIGIN);

    async function assertPublic(url: URL) {
        if (deps.allowPrivateHosts) return;
        const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
        const addresses = isIP(host) ? [host] : await deps.lookup(host);
        if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
            throw new FetchError(
                `refusing private or unresolvable host ${host}`,
                url.origin,
                'refused'
            );
        }
    }

    // The one gate for outbound requests: each hop waits for a slot on its
    // origin, is refused while that origin cools down, and feeds its answer,
    // body included, into the origin's backoff.
    async function send(url: URL, request: FetchRequest): Promise<Hop> {
        if (!isHttpUrl(url)) {
            throw new FetchError(
                `refusing ${url.protocol} URL`,
                url.origin,
                'refused'
            );
        }
        return limit(url.origin, async () => {
            const attempt = deps.backoff.begin(
                url.origin,
                request.lastChance === true
            );
            if (!attempt.admitted) {
                throw new CoolingDownError(url.origin, attempt.until);
            }
            let exchange: Exchange = { kind: 'not-sent' };
            try {
                await assertPublic(url);
                exchange = { kind: 'unreachable' };
                const res = await deps.fetch(
                    url,
                    init(request, deps.timeoutMs)
                );
                const answered: Exchange = {
                    kind: 'answered',
                    status: res.status,
                    retryAfter: res.headers.get('retry-after')
                };
                const location = res.headers.get('location');
                if (!request.form && isRedirect(res.status) && location) {
                    exchange = answered;
                    await res.body?.cancel();
                    return { kind: 'redirect', to: new URL(location, url) };
                }
                exchange = answered;
                let body: string;
                try {
                    body = await readCapped(res, url);
                } catch (err) {
                    // An oversized body is still an answer; a stalled or
                    // broken one is not.
                    if (!(err instanceof FetchError)) {
                        exchange = { kind: 'unreachable' };
                    }
                    throw err;
                }
                return {
                    kind: 'done',
                    result: {
                        status: res.status,
                        url: url.href,
                        headers: res.headers,
                        body
                    }
                };
            } catch (err) {
                // A name that does not resolve never reached a server.
                if (exchange.kind === 'unreachable' && isDnsFailure(err)) {
                    exchange = { kind: 'not-sent' };
                }
                throw err instanceof FetchError
                    ? err
                    : new FetchError(errorText(err), url.origin, 'transient', {
                          cause: err
                      });
            } finally {
                attempt.finish(exchange);
            }
        });
    }

    return async (url, request = {}) => {
        let current = new URL(url);
        for (let hop = 0; ; hop++) {
            const step = await send(current, request);
            if (step.kind === 'done') return step.result;
            if (hop >= MAX_REDIRECTS) {
                throw new FetchError(
                    'too many redirects',
                    current.origin,
                    'refused'
                );
            }
            current = step.to;
        }
    };
}

// The timeout starts once the request has its slot, so time spent queued
// behind other requests to the origin does not count against it.
function init(request: FetchRequest, timeoutMs: number): RequestInit {
    const headers: Record<string, string> = { 'user-agent': 'socketsub' };
    if (request.accept) headers.accept = request.accept;
    const signal = AbortSignal.timeout(timeoutMs);
    return request.form
        ? {
              method: 'POST',
              headers,
              body: request.form,
              signal,
              redirect: 'manual'
          }
        : { method: 'GET', headers, signal, redirect: 'manual' };
}

async function readCapped(res: Response, url: URL): Promise<string> {
    const tooLarge = new FetchError(BODY_TOO_LARGE, url.origin, 'refused');
    if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) {
        await res.body?.cancel();
        throw tooLarge;
    }
    if (!res.body) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > MAX_BODY_BYTES) throw tooLarge;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

const DNS_ERROR_CODES = new Set([
    'ENOTFOUND',
    'ENODATA',
    'ESERVFAIL',
    'EAI_AGAIN',
    'EAI_FAIL',
    'EAI_NODATA',
    'EAI_NONAME'
]);

function isDnsFailure(err: unknown): boolean {
    for (let e = err; e instanceof Error; e = e.cause) {
        const { code, syscall } = e as NodeJS.ErrnoException;
        if (syscall === 'getaddrinfo' || DNS_ERROR_CODES.has(code ?? '')) {
            return true;
        }
    }
    return false;
}

export function errorText(err: unknown): string {
    if (err instanceof Error) {
        return err.name === 'TimeoutError' ? 'request timed out' : err.message;
    }
    return String(err);
}

export function failedRequest(err: unknown): RequestResult {
    return {
        ok: false,
        reason: errorText(err),
        failure: err instanceof FetchError ? err.failure : 'refused'
    };
}

export function statusFailure(status: number): RequestFailure {
    return isServerTrouble(status) ? 'transient' : 'refused';
}

export function isSuccessStatus(status: number): boolean {
    return status >= 200 && status < 300;
}

function isRedirect(status: number): boolean {
    return [301, 302, 303, 307, 308].includes(status);
}
