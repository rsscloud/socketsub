import { createHmac, timingSafeEqual } from 'node:crypto';

const ALGORITHMS = new Set(['sha1', 'sha256', 'sha384', 'sha512']);

export function signatureValid(
    secret: string,
    header: string | undefined,
    body: Uint8Array
): boolean {
    const match = /^(sha1|sha256|sha384|sha512)=([0-9a-f]+)$/i.exec(
        header?.trim() ?? ''
    );
    const algorithm = match?.[1]?.toLowerCase();
    const hex = match?.[2];
    if (!algorithm || !hex || !ALGORITHMS.has(algorithm)) return false;
    const expected = createHmac(algorithm, secret).update(body).digest();
    const given = Buffer.from(hex, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
}
