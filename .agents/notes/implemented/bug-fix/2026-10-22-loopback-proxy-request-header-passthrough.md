# Agent Note: The remote channel forwards the caller's own request headers

Status: implemented

## Problem

`packages/dsh-remote-web-ui/src/loopback-proxy.ts` rebuilt every re-issued HTTP request from a fixed allowlist: `host`, `sec-fetch-site`, `content-type`, `content-length`, `accept`, and the process's own inner credential. A header the allowlist had never heard of stopped at the channel, including the ones a plugin uses to authenticate its own calls.

The report is `@michengai/dsh-im-connect`'s `POST /api/dsh-im-connect/sessions/ensure`, which the browser half sends with `x-dsh-im-connect-client: 1`. Through a paired remote desktop the marker never reached the upstream route, so the route's mutation guard answered `403 {"error":"forbidden mutation request"}` and the sidebar could not restore an IM channel session. The same route over direct loopback answered normally, which located the defect in the forwarding layer rather than in the plugin or the pairing session (issue #1925).

An allowlist is also a standing cost: every plugin that authenticates with its own marker needs this file edited before the remote desktop works.

## Decision

The re-issue forwards every request header except the ones this channel owns, so a plugin's own marker arrives as it does on a direct loopback call.

- **Rewritten rather than forwarded**: `host` becomes `127.0.0.1:<port>`; `sec-fetch-site` is synthesized as `same-origin`; `cookie` is replaced by the process's inner browser-auth credential (the caller's pairing cookie never leaves this process).
- **Dropped — the caller's own origin**: `origin` and `referer`. The loopback fences compare a web `Origin` against the Host header, and that Host now names this machine's loopback, so a forwarded origin would refuse every route (the same defect class as issue #1725).
- **Dropped — browser fetch metadata** (`sec-*`): it describes the outer request, not the re-issued one. `sec-fetch-site` is therefore the synthesized value and can never be asserted by the caller; `sec-fetch-mode` and `sec-fetch-dest` do not let a fetch claim it was a document navigation.
- **Dropped — hop-by-hop headers**: `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, plus every name the caller nominates in its own `Connection` header (RFC 9110 7.6.1).
- **Dropped — forwarding marks**: `forwarded`, `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-port`, `x-forwarded-proto`, `x-real-ip`, `cf-connecting-ip`. The re-issued request is a loopback one; `shared/host/loopback.ts` treats either of `cf-connecting-ip` or `x-forwarded-for` as "a hop stood in between", so carrying an edge's stamp would make every local fence refuse the channel. This keeps the fact recorded in [A forwarding header makes a reverse-proxied request remote](2026-10-19-reverse-proxy-loopback-fence.md) true.
- **Dropped — the cookieless device credential** `x-dsh-remote-device`: the channel's gate consumes it, exactly as the WebSocket `?device=` parameter is stripped, and a live session credential must not reach every other observer of the local port.
- **Dropped — the headers that ask for a body the response side cannot describe**: `accept-encoding`, `range` and `if-range`. The response side copies one fixed header list, and it carries neither `content-encoding` nor `content-range`, so inviting a compressed or a partial upstream body would hand the client bytes nothing describes. Forwarding those two response headers is a separate change against the response direction.

Repeated request headers are folded into one comma-joined value, the same way node folds duplicates on the receiving side, so a duplicated custom header still arrives as one logical value.

## Alternatives considered

Adding `x-dsh-im-connect-client` to the allowlist — the minimum patch the issue itself suggests — was rejected because it fixes one plugin by naming it in this package: the next plugin with its own marker fails identically, and the file gains a list of third-party header names it has no business knowing.

Forwarding the forwarding marks was rejected outright: `isProxiedRequest` refuses a request carrying `cf-connecting-ip` or `x-forwarded-for`, so on any deployment behind a tunnel every re-issued call would classify as remote and the whole channel would answer 403 — a regression that reverses the fix.

Forwarding the caller's `origin` was rejected for the same reason at the fence: the Origin/Host equality check runs against the rewritten loopback Host, so the original origin can only refuse. Synthesizing nothing and forwarding nothing is what the shipped allowlist already did, and it is correct.

Forwarding `x-dsh-remote-device` was rejected: it is a live session credential the gate has already spent, and the WebSocket leg already strips its query-parameter twin for the same reason.

Forwarding `accept-encoding` (and dropping the `range` exclusion) while copying `content-encoding` and `content-range` back was deferred rather than shipped: it changes the response direction, needs its own tests for compressed and partial upstreams, and nothing in the report asked for either — the reported defect is request headers.

Extending the same passthrough to the WebSocket handshake (`proxyLoopbackUpgrade`, which forwards only `sec-websocket-*`) was rejected as out of this issue's scope: no reported route needed it, and the handshake is written by hand into a raw socket, so it needs its own review. The gap stays recorded here instead.

## Consequences

- A plugin that authenticates its calls with a custom request header works behind the pairing gate, and no per-plugin edit is needed in this package.
- A plugin may now see arbitrary caller-supplied headers on the re-issued leg. That is not new authority: the request already reached it as a paired device with full-control privileges, and client-asserted headers were never a trust boundary in this repository.
- The headers the channel owns are unchanged: the loopback authority, the synthetic same-origin marker, the process credential, and the absence of origin/cookies/forwarding marks all stay, so no fence that refused a re-issued request starts accepting one.
- The WebSocket handshake keeps its allowlist, so a plugin that gates an upgrade on a custom header still fails; the note records it as the remaining gap rather than implying parity.

## Testing

`packages/dsh-remote-web-ui/tests/loopback-proxy.spec.ts` runs the proxy over real HTTP servers and three new cases pin the boundary:

- a plugin marker header and the JSON body reach the upstream unchanged (the reported `/api/dsh-im-connect/sessions/ensure` shape);
- the upstream sees the loopback authority, the synthetic `sec-fetch-site: same-origin`, and the process credential in place of the caller's pairing cookie, with `origin` and `referer` absent;
- the device credential, the forwarding marks, browser fetch metadata, `accept-encoding`, and a header the caller nominated through `Connection` are absent while a header the channel does not own passes.

Discrimination was checked against the pre-patch source: the first and third cases fail there, the second holds on both revisions (it pins the security properties that must not move). The package suite, `typecheck`, `pnpm test:standards`, `pnpm docs:check` and `pnpm emoji:check` are green with the change.
