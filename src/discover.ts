import { XMLParser } from 'fast-xml-parser';
import { isSuccessStatus, type Fetcher } from './net.js';
import { isHttpUrl } from './url.js';

export type Discovery = {
    finalUrl: string;
    rsscloud?: { endpoint: URL };
    websub?: { hub: URL; topic: string };
};

const ATOM_NS = 'http://www.w3.org/2005/Atom';

type XmlNode = { [key: string]: XmlNode[] | string | undefined };
type Element = { name: string; ns: string | undefined; node: XmlNode };
type Namespaces = Record<string, string>;

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true,
    isArray: (_name, _path, _leaf, isAttribute) => !isAttribute
});

export async function discover(
    fetcher: Fetcher,
    url: string
): Promise<Discovery> {
    const res = await fetcher(url, {
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8'
    });
    if (!isSuccessStatus(res.status)) {
        throw new Error(`feed returned HTTP ${res.status}`);
    }
    return parseDiscovery(res.url, res.body, res.headers.get('link'));
}

export function parseDiscovery(
    finalUrl: string,
    body: string,
    linkHeader: string | null
): Discovery {
    const discovery: Discovery = { finalUrl };
    const feed = feedChildren(body);

    const rsscloud = sourceCloud(feed) ?? rssCloud(feed);
    if (rsscloud) discovery.rsscloud = { endpoint: rsscloud };

    const links = [
        ...parseLinkHeader(linkHeader ?? ''),
        ...atomLinks(feed)
    ].flatMap(link => {
        const href = resolve(link.href, finalUrl);
        return href ? [{ rels: link.rels, href }] : [];
    });
    const hub = links.find(link => link.rels.includes('hub'))?.href;
    const self = links.find(link => link.rels.includes('self'))?.href;
    if (hub && isHttpUrl(hub)) {
        discovery.websub = { hub, topic: self?.href ?? finalUrl };
    }
    return discovery;
}

function feedChildren(body: string): Element[] {
    let doc: XmlNode;
    try {
        doc = parser.parse(body) as XmlNode;
    } catch {
        return [];
    }
    const root = elements(doc, {}).find(
        el => el.name === 'rss' || el.name === 'feed' || el.name === 'RDF'
    );
    if (!root) return [];
    const rootNs = scope(root.node, {});
    const children = elements(root.node, rootNs);
    const channel = children.find(el => el.name === 'channel');
    if (!channel) return children;
    return elements(channel.node, scope(channel.node, rootNs));
}

function elements(node: XmlNode, inherited: Namespaces): Element[] {
    return Object.entries(node).flatMap(([qname, value]) => {
        if (qname.startsWith('@_') || qname === '#text') return [];
        if (!Array.isArray(value)) return [];
        return value.map(child => {
            const childNode: XmlNode =
                typeof child === 'string' ? { '#text': child } : child;
            const ns = scope(childNode, inherited);
            const [prefix, local] = qname.includes(':')
                ? qname.split(':', 2)
                : ['', qname];
            return {
                name: local ?? qname,
                ns: ns[prefix ?? ''],
                node: childNode
            };
        });
    });
}

function scope(node: XmlNode, inherited: Namespaces): Namespaces {
    const own: Namespaces = {};
    for (const [key, value] of Object.entries(node)) {
        if (typeof value !== 'string') continue;
        if (key === '@_xmlns') own[''] = value;
        else if (key.startsWith('@_xmlns:')) own[key.slice(8)] = value;
    }
    return { ...inherited, ...own };
}

function attr(node: XmlNode, name: string): string | undefined {
    const value = node[`@_${name}`];
    return typeof value === 'string' ? value.trim() : undefined;
}

function text(node: XmlNode): string {
    const value = node['#text'];
    return typeof value === 'string' ? value.trim() : '';
}

function isSourceNs(ns: string | undefined): boolean {
    return (
        ns !== undefined &&
        ns.replace(/^https?:\/\//, '').replace(/\/+$/, '') ===
            'source.scripting.com'
    );
}

function sourceCloud(feed: Element[]): URL | undefined {
    for (const el of feed) {
        if (el.name !== 'cloud' || !isSourceNs(el.ns)) continue;
        const url = resolve(text(el.node));
        if (url && isHttpUrl(url)) return url;
    }
    return undefined;
}

function rssCloud(feed: Element[]): URL | undefined {
    for (const el of feed) {
        if (el.name !== 'cloud' || el.ns !== undefined) continue;
        const protocol = attr(el.node, 'protocol')?.toLowerCase();
        if (protocol === 'xml-rpc' || protocol === 'soap') continue;
        const domain = attr(el.node, 'domain');
        const port = attr(el.node, 'port') ?? '80';
        const path = attr(el.node, 'path') ?? '/';
        if (!domain || !/^\d+$/.test(port)) continue;
        const scheme =
            port === '443' || protocol === 'https-post' ? 'https' : 'http';
        const slash = path.startsWith('/') ? '' : '/';
        const url = resolve(`${scheme}://${domain}:${port}${slash}${path}`);
        if (url) return url;
    }
    return undefined;
}

type Link = { rels: string[]; href: string };

function atomLinks(feed: Element[]): Link[] {
    return feed
        .filter(el => el.name === 'link' && el.ns === ATOM_NS)
        .flatMap(el => {
            const href = attr(el.node, 'href');
            const rel = attr(el.node, 'rel');
            return href && rel ? [{ rels: relList(rel), href }] : [];
        });
}

function parseLinkHeader(header: string): Link[] {
    const links: Link[] = [];
    const pattern = /<([^>]*)>([^,<]*)/g;
    for (const match of header.matchAll(pattern)) {
        const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(
            match[2] ?? ''
        );
        const value = rel?.[1] ?? rel?.[2];
        if (match[1] !== undefined && value) {
            links.push({ rels: relList(value), href: match[1] });
        }
    }
    return links;
}

function relList(rel: string): string[] {
    return rel.toLowerCase().split(/\s+/).filter(Boolean);
}

function resolve(href: string, base?: string): URL | undefined {
    try {
        return new URL(href, base);
    } catch {
        return undefined;
    }
}
