import { readFileSync } from 'node:fs';

export type Recorded = {
    method: string;
    url: URL;
    headers: Headers;
    form: URLSearchParams;
};

export type Handler = (request: Recorded) => Response | Promise<Response>;

export function fixture(name: string): string {
    return readFileSync(
        new URL(`../fixtures/${name}`, import.meta.url),
        'utf8'
    );
}

// Shared by every fake net in a test file, so settle() needs no handle.
const activity = { inFlight: 0, gated: 0, events: 0 };

export function netActivity(): Readonly<typeof activity> {
    return activity;
}

export function gate() {
    let release!: () => void;
    const opened = new Promise<void>(resolve => (release = resolve));
    return {
        release,
        async wait() {
            activity.gated++;
            try {
                await opened;
            } finally {
                activity.gated--;
            }
        }
    };
}

export function createFakeNet() {
    const handlers = new Map<string, Handler>();
    const requests: Recorded[] = [];

    const fetch: typeof globalThis.fetch = async (input, init) => {
        activity.inFlight++;
        activity.events++;
        try {
            const request = new Request(input, init);
            const url = new URL(request.url);
            const text = request.method === 'GET' ? '' : await request.text();
            const recorded = {
                method: request.method,
                url,
                headers: request.headers,
                form: new URLSearchParams(text)
            };
            requests.push(recorded);
            const handler = handlers.get(url.origin + url.pathname);
            if (!handler) return new Response('not found', { status: 404 });
            return await handler(recorded);
        } finally {
            activity.inFlight--;
            activity.events++;
        }
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
