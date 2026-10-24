import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

export type RssCloudCallbacks = {
    acceptsChallenge(url: string): boolean;
    notify(url: string): void;
};

const NOTIFY_BODY_LIMIT_BYTES = 1024 * 1024;

export function rssCloudRoutes(rssCloud: RssCloudCallbacks) {
    const routes = new Hono();
    routes.use(bodyLimit({ maxSize: NOTIFY_BODY_LIMIT_BYTES }));

    routes.get('/notify', c => {
        const url = c.req.query('url');
        const challenge = c.req.query('challenge');
        if (!url || challenge === undefined) return c.notFound();
        if (!rssCloud.acceptsChallenge(url)) return c.notFound();
        return c.text(challenge);
    });

    routes.post('/notify', async c => {
        const body = await c.req.parseBody();
        const url = body.url;
        if (typeof url === 'string') rssCloud.notify(url);
        return c.text('ok');
    });

    return routes;
}
