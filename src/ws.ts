import type { UpgradeWebSocket } from 'hono/ws';
import type { Client, ClientMessage } from './messages.js';
import type { Registry } from './registry.js';

type ParsedMessage =
    { ok: true; message: ClientMessage } | { ok: false; message: string };

const SHAPE =
    'message must be {"type": "subscribe" | "unsubscribe", "urls": [...]}';

export function parseClientMessage(data: unknown, max: number): ParsedMessage {
    if (typeof data !== 'string') {
        return { ok: false, message: 'send a JSON object as text' };
    }
    let value: unknown;
    try {
        value = JSON.parse(data);
    } catch {
        return { ok: false, message: 'message is not valid JSON' };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, message: SHAPE };
    }
    const { type, urls } = value as Record<string, unknown>;
    if (type !== 'subscribe' && type !== 'unsubscribe') {
        return { ok: false, message: SHAPE };
    }
    if (!Array.isArray(urls) || !urls.every(v => typeof v === 'string')) {
        return { ok: false, message: 'urls must be an array of URL strings' };
    }
    if (urls.length > max) {
        return {
            ok: false,
            message: `too many feeds in one message (${urls.length} > ${max})`
        };
    }
    return { ok: true, message: { type, urls } };
}

export function wsHandler(
    upgradeWebSocket: UpgradeWebSocket,
    registry: Registry,
    maxFeedsPerMessage: number
) {
    return upgradeWebSocket(() => {
        let client: Client | undefined;
        return {
            onOpen(_event, ws) {
                client = {
                    send(message) {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify(message));
                        }
                    }
                };
            },
            onMessage(event) {
                if (!client) return;
                const parsed = parseClientMessage(
                    event.data,
                    maxFeedsPerMessage
                );
                if (!parsed.ok) {
                    client.send({ type: 'error', message: parsed.message });
                } else if (parsed.message.type === 'subscribe') {
                    registry.subscribe(client, parsed.message.urls);
                } else {
                    registry.unsubscribe(client, parsed.message.urls);
                }
            },
            onClose() {
                if (client) registry.removeClient(client);
            }
        };
    });
}
