# socketsub

A WebSocket bridge for feed update notifications. Clients send a list of RSS or
Atom feed URLs. socketsub subscribes to each feed through rssCloud or WebSub
and sends the client a message whenever a feed changes.

For each feed, socketsub fetches the feed and looks for push support:

1. rssCloud, from `<source:cloud>` or the RSS `<cloud>` element.
2. WebSub, from a `hub` link in the feed or the HTTP `Link` header. socketsub
   uses WebSub only when the feed has no rssCloud or rssCloud registration
   fails.
3. Neither. The feed is reported as `unsupported`.

Many clients can watch the same feed. socketsub keeps one upstream subscription
per feed. When the last client for a feed disconnects, socketsub unsubscribes
from WebSub or stops renewing the rssCloud registration. State is held in
memory only.

## WebSocket protocol

Connect to `/ws` and send JSON text messages. Each has a `type` and a `urls`
array:

```json
{ "type": "subscribe", "urls": ["https://example.com/feed.xml", "https://blog.example/atom"] }
{ "type": "unsubscribe", "urls": ["https://example.com/feed.xml"] }
```

Each subscribe adds to the feeds watched on that connection. Subscribing to a
URL again is harmless. Unsubscribing answers each URL with a `status` of
`unsubscribed`, even one the connection never followed. Closing the connection
unsubscribes from everything. A message larger than 1 MiB closes the connection
with code 1009. The full client protocol is also served at `/docs`.

The server sends three kinds of JSON messages. `url` is always the exact string
the client sent, even after redirects.

```jsonc
// Once per subscribed feed, again whenever its state changes, and once per
// unsubscribed URL.
{ "type": "status", "url": "https://example.com/feed.xml",
  "state": "pending" | "subscribed" | "unsupported" | "error" | "unsubscribed",
  "via": "rsscloud" | "websub",   // present once a protocol is chosen
  "detail": "rssCloud registration failed: ..." }   // present when there is a reason

// Each time the feed changes.
{ "type": "update", "url": "https://example.com/feed.xml" }

// The message itself was rejected: not JSON, no valid type, urls not an
// array of strings, or more than MAX_FEEDS_PER_MESSAGE entries.
{ "type": "error", "message": "message is not valid JSON" }
```

An invalid URL inside a valid message gets a `status` of `error`, as does a new
URL past `MAX_FEEDS_PER_CLIENT` or `MAX_FEEDS`. The rest of the message is still
processed.

## Configuration

| Variable                | Default  | Meaning                                                                                 |
| ----------------------- | -------- | --------------------------------------------------------------------------------------- |
| `PUBLIC_URL`            | required | Externally reachable base URL. All callback URLs are built from it.                     |
| `PORT`                  | `3000`   | Listen port.                                                                            |
| `RSSCLOUD_RENEW_HOURS`  | `24`     | rssCloud re-registration interval, at most 596. Servers expire registrations after 25h. |
| `WEBSUB_LEASE_SECONDS`  | `86400`  | Requested WebSub lease. Renewal happens at 90% of the lease the hub grants.             |
| `MAX_FEEDS_PER_MESSAGE` | `500`    | Maximum URLs in one client message.                                                     |
| `MAX_FEEDS_PER_CLIENT`  | `1000`   | Maximum feeds one connection can follow.                                                |
| `MAX_FEEDS`             | `10000`  | Maximum feeds the server follows across all connections.                                |
| `FETCH_TIMEOUT_MS`      | `10000`  | Timeout for feed fetches and subscribe requests.                                        |
| `DISCOVERY_CONCURRENCY` | `8`      | Maximum parallel feed fetches.                                                          |
| `ALLOW_PRIVATE_HOSTS`   | `false`  | Allow fetching loopback, private, and link-local addresses.                             |

rssCloud servers call back with the `https-post` protocol when `PUBLIC_URL` is
https, and `http-post` otherwise. The callback port is the port in
`PUBLIC_URL`, or 443 or 80 by scheme.

`PUBLIC_URL` can include a path prefix, such as `https://example.com/socketsub`.
Callback URLs then include the prefix, and the reverse proxy must strip it
before forwarding. The service itself always serves its routes at the root.

## Routes

| Route                        | Purpose                                       |
| ---------------------------- | --------------------------------------------- |
| `GET /`                      | Home page with a socklog-based test client.   |
| `GET /docs`                  | Client protocol documentation.                |
| `GET /ws`                    | WebSocket endpoint.                           |
| `GET /health`                | Health check.                                 |
| `GET, POST /rsscloud/notify` | rssCloud challenge and notification callback. |
| `GET, POST /websub/:id`      | WebSub verification and content delivery.     |

## Local development

Requires Node 24 and pnpm.

```sh
pnpm install
cloudflared tunnel --url http://localhost:3000
```

Copy the `https://….trycloudflare.com` URL that cloudflared prints into `.env`:

```sh
PUBLIC_URL=https://abc-def.trycloudflare.com
```

Then start the server and open `http://localhost:3000/`:

```sh
pnpm dev
```

Without a tunnel, clouds and hubs cannot reach the callbacks, so registrations
fail. The WebSocket protocol still works.

Checks:

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

## Docker

```sh
docker build -t socketsub .
docker run -p 3000:3000 -e PUBLIC_URL=https://socketsub.example socketsub
```

To build and push a multi-arch image to `ghcr.io/rsscloud/socketsub`:

```sh
pnpm docker:dry-run      # show what would be built and pushed
pnpm docker:build-push
```
