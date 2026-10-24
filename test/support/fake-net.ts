import { readFileSync } from 'node:fs';

export type Recorded = {
    method: string;
    url: URL;
    form: URLSearchParams;
};

export type Handler = (request: Recorded) => Response | Promise<Response>;

export function fixture(name: string): string {
    return readFileSync(
        new URL(`../fixtures/${name}`, import.meta.url),
        'utf8'
    );
}

export function createFakeNet() {
    const handlers = new Map<string, Handler>();
    const requests: Recorded[] = [];

    const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const text = request.method === 'GET' ? '' : await request.text();
        const recorded = {
            method: request.method,
            url,
            form: new URLSearchParams(text)
        };
        requests.push(recorded);
        const handler = handlers.get(url.origin + url.pathname);
        if (!handler) return new Response('not found', { status: 404 });
        return handler(recorded);
    };

    return {
        fetch,
        requests,
        on(url: string, handler: Handler) {
            const parsed = new URL(url);
            handlers.set(parsed.origin + parsed.pathname, handler);
        },
        feed(url: string, body: string, headers: Record<string, string> = {}) {
            this.on(
                url,
                () =>
                    new Response(body, {
                        headers: {
                            'content-type': 'application/xml',
                            ...headers
                        }
                    })
            );
        },
        to(url: string): Recorded[] {
            const parsed = new URL(url);
            return requests.filter(
                r =>
                    r.url.origin + r.url.pathname ===
                    parsed.origin + parsed.pathname
            );
        }
    };
}

export type FakeNet = ReturnType<typeof createFakeNet>;
