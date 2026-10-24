import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

it('reports health', async () => {
    const { app } = createApp({
        config: loadConfig({ PUBLIC_URL: 'https://sub.example' }),
        fetch: () => Promise.reject(new Error('no network')),
        lookup: () => Promise.reject(new Error('no dns'))
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
});
