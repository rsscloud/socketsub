# Changelog

## [0.2.0](https://github.com/rsscloud/socketsub/compare/socketsub-v0.1.0...socketsub-v0.2.0) (2026-10-24)


### ⚠ BREAKING CHANGES

* bare JSON arrays are rejected with an error message.

### Features

* back off from struggling servers and retry failed subscriptions ([46126c8](https://github.com/rsscloud/socketsub/commit/46126c8014825bbe040ad7e071001e45ada40407))
* per-origin backoff gate in the fetcher ([24cf6f2](https://github.com/rsscloud/socketsub/commit/24cf6f2b928592616eb43a181ec37405a36548b5))
* retry failed and unsupported feeds on a new subscribe ([9599904](https://github.com/rsscloud/socketsub/commit/959990478846766c3928c8a44f483676546dcee4))
* retry failed renewals until the registration or lease expires ([5bdc483](https://github.com/rsscloud/socketsub/commit/5bdc48330cdebb37d2249c030fe85131014fdab9))
* typed subscribe and unsubscribe client messages ([a7658f5](https://github.com/rsscloud/socketsub/commit/a7658f54f4111dfa3cbab74b9c68bf14e4517365))
* use socklog for the home page and add a client protocol docs page ([1b89b7f](https://github.com/rsscloud/socketsub/commit/1b89b7f2baaf532bf6ff4bc246edb35126ff891a))


### Bug Fixes

* attribute each request outcome to the streak it started in ([511bb8b](https://github.com/rsscloud/socketsub/commit/511bb8b6706b01d09d3662a8fc7964490bd92312))
* bound the backoff map and do not cool an origin that never resolved ([2ebfe52](https://github.com/rsscloud/socketsub/commit/2ebfe525e43fcecb84dddd1c9a27b20b6814dddf))
* classify request failures where they happen and keep the failing origin ([7700104](https://github.com/rsscloud/socketsub/commit/770010467b2b6b4fb10a71eef60e95aaab130759))
* keep page links under the PUBLIC_URL prefix and scroll the log viewer ([2785dac](https://github.com/rsscloud/socketsub/commit/2785dacdcb92fbb0c9c1a709961c3296a3bb9848))
* let the log grow with the page instead of a fixed-height panel ([251c59e](https://github.com/rsscloud/socketsub/commit/251c59ef5e6843f3f762e181029163aaf47289a3))
* limit concurrent requests per origin and read the body inside the attempt ([e1d2883](https://github.com/rsscloud/socketsub/commit/e1d288375db4c56c0bc574637a4631dd780bbb49))
* make one last renewal attempt before the registration or lease lapses ([07fb5fd](https://github.com/rsscloud/socketsub/commit/07fb5fdcf1e25e4bb84cbcad192fc75b045ead6f))
* spread retries on a cooling origin and decay the streak on recovery ([2b449c4](https://github.com/rsscloud/socketsub/commit/2b449c4c8edfdf65c79e171f5d78483c70683830))

## 0.1.0 (2026-10-24)


### Features

* add feed discovery for rssCloud and WebSub ([1fcfa67](https://github.com/rsscloud/socketsub/commit/1fcfa6703230ce940158fdec5b39ef20b1cffbdd))
* add feed registry and websocket protocol ([3d93aba](https://github.com/rsscloud/socketsub/commit/3d93aba6bda526ff7cc5d592347aff37dba4531b))
* add typed config and app factory ([fd53987](https://github.com/rsscloud/socketsub/commit/fd53987aed56949f61c4c4c637f92786206dd7f2))
* guard outbound fetches against private hosts and large bodies ([cd3662f](https://github.com/rsscloud/socketsub/commit/cd3662fa4eab65a7d60ff76bc98c5a241f109bed))
* register feeds with rssCloud and serve its callbacks ([77aa75f](https://github.com/rsscloud/socketsub/commit/77aa75fe402361717f74eef8bd807a44ac3a2b03))
* serve a browser test client at / ([d49f974](https://github.com/rsscloud/socketsub/commit/d49f97407b959b1e972433fa864d2abfb3e73494))
* subscribe through WebSub hubs with rssCloud fallback ([d4c4584](https://github.com/rsscloud/socketsub/commit/d4c4584de2b53bd775d0ffe54124431c0af55690))


### Bug Fixes

* block site-local, NAT64, and 6to4 IPv6 ranges ([69a1b4c](https://github.com/rsscloud/socketsub/commit/69a1b4cab4460987f85168d8c7628837dcc754c7))
* cancel the renewal timer on every state change ([628580a](https://github.com/rsscloud/socketsub/commit/628580aa2ca034b9ab12e6fae0144a994ad9f0cf))
* cap callback request bodies ([93b063f](https://github.com/rsscloud/socketsub/commit/93b063f6d05b25ef1aa191cb4c511e04661bbe5a))
* cap feeds per connection and across the server ([a51aca8](https://github.com/rsscloud/socketsub/commit/a51aca8e9398295b4a1eece609720078d4ffafee))
* fail a WebSub feed whose renewal is never verified ([edd1581](https://github.com/rsscloud/socketsub/commit/edd158175055fe82130ffadfc140aba12d3b4ebc))
* forget pending WebSub unsubscribes after 10 minutes ([9ba9203](https://github.com/rsscloud/socketsub/commit/9ba9203eab0d1e6ee9453a6bef8c293d6946816e))
* keep renewal timers within the setTimeout limit ([4bca0a8](https://github.com/rsscloud/socketsub/commit/4bca0a822edd46c6ca9fae2263b10aa0e853baac))
* limit WebSocket messages to 1 MiB ([b858c04](https://github.com/rsscloud/socketsub/commit/b858c044df6425d6304f142ce2332f067ddc4ec0))
* route each protocol's notifications only to its own feeds ([17de6fd](https://github.com/rsscloud/socketsub/commit/17de6fd619654cf9ff892c986e53e4938d3b0171))
* send hub.verify so PubSubHubbub 0.3 hubs accept subscriptions ([f5d9490](https://github.com/rsscloud/socketsub/commit/f5d9490bd1f5ca835c26d47bb81b130c50621f1e))
