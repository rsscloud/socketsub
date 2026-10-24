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

const MAX_REDIRECTS = 5;

export type FetcherDeps = {
    fetch: typeof fetch;
    timeoutMs: number;
};

export function createFetcher(deps: FetcherDeps): Fetcher {
    return async (url, request = {}) => {
        const signal = AbortSignal.timeout(deps.timeoutMs);
        const headers: Record<string, string> = {
            'user-agent': 'socketsub'
        };
        if (request.accept) headers.accept = request.accept;
        const init: RequestInit = request.form
            ? { method: 'POST', headers, body: request.form, signal }
            : { method: 'GET', headers, signal };

        let current = new URL(url);
        for (let hop = 0; ; hop++) {
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
                body: await res.text()
            };
        }
    };
}

function isRedirect(status: number): boolean {
    return [301, 302, 303, 307, 308].includes(status);
}
