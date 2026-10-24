export function isHttpUrl(url: URL): boolean {
    return url.protocol === 'http:' || url.protocol === 'https:';
}

export function normalizeUrl(raw: string): string | undefined {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return undefined;
    }
    if (!isHttpUrl(url)) return undefined;
    url.hash = '';
    return url.href;
}

export function sameUrl(a: string, b: string): boolean {
    return (normalizeUrl(a) ?? a) === (normalizeUrl(b) ?? b);
}
