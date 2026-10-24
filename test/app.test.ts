import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const { app } = createApp({
    config: loadConfig({ PUBLIC_URL: 'https://sub.example' }),
    fetch: () => Promise.reject(new Error('no network')),
    lookup: () => Promise.reject(new Error('no dns'))
});

it('reports health', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
});

it('serves the test client page at /', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('<title>socketsub test client</title>');
});
