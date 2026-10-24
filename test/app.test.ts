import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

function appFor(env: Record<string, string>) {
    return createApp({
        config: loadConfig(env),
        fetch: () => Promise.reject(new Error('no network')),
        lookup: () => Promise.reject(new Error('no dns'))
    }).app;
}

const app = appFor({ PUBLIC_URL: 'https://sub.example' });

it('reports health', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
});

it('serves the home page with the socklog viewer pointed at the WebSocket URL', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<code>wss://sub.example/ws</code>');
    expect(html).toContain(
        '<socklog-viewer id="viewer" url="wss://sub.example/ws">'
    );
    expect(html).not.toContain('{{');
});

it('serves the docs page with the WebSocket URL and configured limits', async () => {
    const docs = appFor({
        PUBLIC_URL: 'http://localhost:3000/prefix/',
        MAX_FEEDS_PER_MESSAGE: '7',
        MAX_FEEDS_PER_CLIENT: '8',
        MAX_FEEDS: '9'
    });
    const res = await docs.request('/docs');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<pre>ws://localhost:3000/prefix/ws</pre>');
    expect(html).toContain("new WebSocket('ws://localhost:3000/prefix/ws')");
    expect(html).toMatch(/URLs in one message<\/td>\s*<td>7</);
    expect(html).toMatch(/Feeds per connection<\/td>\s*<td>8</);
    expect(html).toMatch(/Feeds across the server<\/td>\s*<td>9</);
    expect(html).not.toContain('{{');
});
