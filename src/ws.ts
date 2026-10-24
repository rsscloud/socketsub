import type { UpgradeWebSocket } from 'hono/ws';
import type { Client } from './messages.js';
import type { Registry } from './registry.js';

type ParsedMessage =
    { ok: true; urls: string[] } | { ok: false; message: string };

export function parseClientMessage(data: unknown, max: number): ParsedMessage {
    if (typeof data !== 'string') {
        return {
            ok: false,
            message: 'send a JSON array of URL strings as text'
        };
    }
    let value: unknown;
    try {
        value = JSON.parse(data);
    } catch {
        return { ok: false, message: 'message is not valid JSON' };
    }
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
        return {
            ok: false,
            message: 'message must be a JSON array of URL strings'
        };
    }
    if (value.length > max) {
        return {
            ok: false,
            message: `too many feeds in one message (${value.length} > ${max})`
        };
    }
    return { ok: true, urls: value };
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
                if (parsed.ok) {
                    registry.add(client, parsed.urls);
                } else {
                    client.send({ type: 'error', message: parsed.message });
                }
            },
            onClose() {
                if (client) registry.removeClient(client);
            }
        };
    });
}
