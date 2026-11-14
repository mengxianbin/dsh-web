# Agent Note: A forwarding header makes a reverse-proxied request remote

Status: implemented

## Problem

A dsh deployment is commonly put behind a reverse proxy: a Cloudflare tunnel, frp, or an nginx reverse proxy that terminates the public connection and dials the host at `127.0.0.1:<port>`. Such a hop produces exactly the shape both halves of the loopback classification ask for, on a request that came from the public internet:

- the origin's socket peer is the proxy, which connects over loopback, so `request.socket.remoteAddress` is `127.0.0.1`;
- the proxy rewrites the `Host` header to its own upstream literal (`127.0.0.1:<port>`, or `localhost:<port>`), so the Host half holds too.

Both facts are individually true and jointly worthless: the request was never local. The shared fence (`isLoopbackRequest`) and this repository's own control-plane predicate (`packages/dsh-remote-web-ui/src/gate.ts` `isLoopbackClient`) returned true, so `makeGateListener` delegated without a device cookie, and the loopback-only pairing control planes (mint, stop, revoke, the device roster, the events stream) served an unauthenticated public caller. The desktop-only status view (`/api/pair/status`) answered that caller with the loopback snapshot as well.

The signal that separates the two situations is the forwarding header the proxy itself stamps: `CF-Connecting-IP` and `X-Forwarded-For` exist only because a hop forwarded the request. Issue #1906 records the report.

Making that header decisive has a cost, and the next report named it (issue #1919): the same shape is what the operator's *own* tunnel or forwarder produces when it dials the loopback upstream. Under the blanket rule a phone on a self-hosted tunnel was refused even the pairing status it needs to boot the pairing flow, and no page of this package could be reached through the deployment's own proxy. The sibling task board had the matching need from the other side (issue #1918): an operator running the proxy themselves has no way to inject the token its allowlisted-proxy path requires.

## Decision

A request that carries `CF-Connecting-IP` or `X-Forwarded-For` is never the desktop. The loopback question is asked in two layers instead — whether a Host may be answered at all (reachability) and whether a request may be served the desktop payload or a credential (payload) — and the forwarding header decides the second, no longer the first.

- The rule lives once, in `shared/host/loopback.ts`: `isProxiedRequest` reports either header as present, `isLoopbackRequest` refuses such a request before it reads the Host, and both stay exactly as the #1906 fix shipped them. The file adds one new fact beside them, `isForwardedLoopbackRequest`: a forwarding header, a loopback socket, and a loopback Host all hold. It is a fact about the route, never a trust decision, so every consumer keeps it behind its own default-off switch. Every package that fences its host routes on `isLoopbackRequest` (ssh, git-graph, market, plugin-manager, session-archive, skill-explorer, task-board, task-board-github, usage, update) inherits the fence through its generated copy, refreshed by `node scripts/sync-shared.mjs`.
- `packages/dsh-remote-web-ui/src/gate.ts` splits the predicate in two. `isLoopbackUpstream` (loopback socket and loopback Host, forwarding headers deliberately ignored) answers "this process is reachable at a loopback authority"; `isLoopbackClient` is that same fact without a forwarding header and stays the desktop decision. `isTrustedHost` in `src/routes.ts` is built on `isLoopbackUpstream`, so a tunneled visitor reaches the pairing entry pages and the status view, while mint, stop, revoke, the events stream, `lan-bind`, the `api/gate` listener and every credential stay on `isLoopbackClient`.
- `/api/pair/status` answers a forwarded or unpaired caller with the minimal payload `{ ok, paired, requirePairingForLan, phase, lanAvailable }`. The full snapshot (token expiry, public tunnel URL, counts) and the per-device roster stay with the desktop or a live device, because a token-expiry and tunnel-URL oracle is a targeting aid.
- The Origin assertion in `isTrustedApiRequest` keeps `Origin == Host` for a direct request and changes only for a forwarded request that landed on the loopback upstream: there the Origin is compared against the authorities this surface actually serves, since the Host the proxy rewrote names the visitor's loopback rather than this host.
- `redirectOrigin` in the pair routes sends the `/pair-accept` 303 to `publicBaseUrl` when the request was forwarded onto the loopback upstream and a public base is configured; a direct desktop navigation keeps the authority it reached.
- `packages/dsh-task-board` ships the narrow counter-case as `trustForwardedProxy` (`Config`, volatile, default `false`, schema default pinned by `DEFAULT_TRUST_FORWARDED_PROXY`, read per request through `resolveProxyAccess` so an edit binds the next request). Off keeps the #1906 fence; on admits only `isForwardedLoopbackRequest` together with the browser same-origin marker and refuses an explicit `sec-fetch-site: cross-site`. That cross-site check is what replaces the Origin-equality the direct path uses, because a rewritten Host gives the fence nothing to compare.
- Every other property of the fix is unchanged: the browser same-origin markers keep their place and their order, a cross-site marker still refuses first, and a real desktop request — loopback socket, loopback Host, no forwarding header — is local exactly as it was.
- The task board adds one admission path that does not read forwarding headers at all: it bridges the Host's `connection` service, so a request the Host itself already authenticated through its Host/Origin fence and signed browser session reaches the board without a board-specific allowlist ([the connection-auth bridge](2026-10-23-task-board-connection-auth-bridge.md)). The rule above and every other fence in this note are unchanged.

## What the rule cannot see

The rule is a header test, and a reverse proxy is configurable. The residuals are deliberate and stated in the package README security model rather than hidden:

- A proxy configured to drop both headers puts the request back into the same shape as the desktop, which no header-level rule can separate. Cloudflare and nginx forward `X-Forwarded-For` by default; a hand-written nginx `proxy_set_header` block that omits it, or clears it with an empty value, does not.
- A process on this machine can forge any header, exactly as it could already forge the `Origin` a local tool sends. Nothing about the local trust model changes: the desktop still needs no credential.
- The desktop shell's own re-issue service and this package's loopback proxy (`loopback-proxy.ts`) do not forward forwarding headers, so neither is newly fenced by this rule.
- Admitting the narrower shape is an operator's decision, not a detection: a public tunnel satisfies `isForwardedLoopbackRequest` by construction because the proxy is the client of this process. That is why the remote-web-ui admission buys reachability only — it hands out no credential — and why the task board, where the same shape would reach the board's whole API, keeps it behind a default-off switch.

## Alternatives considered

Refusing a loopback Host altogether was rejected: the desktop is served from `127.0.0.1`, and a Host-based ban would take the local application down with the proxy case.

Keeping a trusted-proxy allowlist (only the configured proxies may mark a request forwarded) was rejected as the wrong default for a security fix. It is a configuration surface that fails open when unset, and the deployments that need the fix are exactly the ones that were never configured; presence of a forwarding header fails closed.

Normalizing the effective client address from `X-Forwarded-For` and classifying that instead was rejected: the value is caller-supplied unless the number of trusted hops is known, and a wrong count re-establishes the same bypass with extra steps. The decision this note implements is the one the issue settled - a forwarding header means not local - and it needs no knowledge of the topology.

Fixing only `gate.ts` was rejected for the same reason the shared fence exists: ten sibling packages fence on `isLoopbackRequest`, and a fix in one of them would leave the same bypass in the rest.

Treating the forwarded-onto-loopback-upstream shape as local outright, which is what the #1919 report first invited, was rejected because a public tunnel satisfies that shape by construction: a blanket admission would hand the #1906 bypass back. Reachability had to separate from payload instead, which is what shipped.

Folding the narrowing into `isLoopbackRequest` as a parameter or a shared switch was rejected: eleven packages fence on that function and only two need the narrower fact, so the decision would travel inside a generated file every package carries. The opt-in belongs to the consumer that knows whether an operator runs the hop.

Reusing the task board's token-allowlisted proxy path for a tunnel was rejected: a proxy that rewrites the Host offers the plugin no allowlist entry to compare, and the operator of a quick tunnel has nowhere to inject a token. The forwarding header plus the machine-local socket is the weaker but workable signal, which is exactly why it is default-off.

Serving the full status snapshot to a forwarded caller was rejected: the snapshot names token expiry and the public tunnel URL, and the roster holds session credentials. Reachability is all a pairing flow needs from that route.

## Consequences

- A deployment behind a reverse proxy still gets no desktop treatment: the pairing control planes refuse it (403), and the status view answers it as an unpaired caller instead of handing out the desktop snapshot. That is the intended outcome of the fix and a visible behavior change for anyone who had been using the bypass as a convenience.
- A tunneled visitor is now answered where the pairing flow needs it — the entry pages and the minimal status payload — while every credential-bearing surface keeps refusing it. A proxy deployment that used to rely on the desktop view keeps 403ing until it presents a device cookie.
- The task board's switch changes nothing for a deployment that never sets it; a board behind an operator's own tunnel gains a documented way in without the token allowlist, and the board's own README states the shape, the default and the volatility.
- The pairing channel and the browser half are unaffected: a paired device reaches `/remote` through the normalized Host it presented, and the tunnel landing flow keeps working because it never claimed loopback. The 303 now leaves through `publicBaseUrl` when a proxy rewrote the Host, so a phone is not sent to its own loopback.
- The tunnel path this repository instruments itself is not affected: the accept limiter already buckets forwarded requests by the edge-appended hop, and `x-forwarded-proto` still only decides cookie security.
- Every copy of `loopback.ts` in the tree changes at once, because the file is generated; `pnpm test:scripts` fails on any copy that is not re-synced.

## Testing

- `shared/tests/loopback.spec.ts` (18 tests) covers the four required shapes for the fence: loopback socket with loopback Host and no forwarding header is still local; either forwarding header makes it remote; a non-loopback socket stays remote; and the empty-value case, which must not be read as "no proxy". It also pins the browser markers, including that they still decide on their own for a direct request.
- `packages/dsh-remote-web-ui/tests/gate.spec.ts` (25 tests) pins the same four shapes on `isLoopbackClient`, plus the gate decision itself (a forwarded request that looks loopback is refused without a device cookie), and adds an `isLoopbackUpstream` group: a forwarded visitor on a loopback socket and Host is reachable without becoming the desktop, while a non-loopback socket or a foreign Host stays outside.
- `packages/dsh-remote-web-ui/tests/routes.spec.ts` (52 tests) runs the real route family over a real HTTP server: `/api/pair/issue` and `/api/pair/stop` answer 403 for a request with `CF-Connecting-IP` or `X-Forwarded-For` while the direct call still answers 200; `/api/pair/status` answers the forwarded caller with exactly the minimal payload and the direct desktop call still carries the snapshot fields; a served-authority Origin is accepted only when a proxy forwarded the request onto the loopback upstream; and the `/pair-accept` redirect names `publicBaseUrl` for a tunneled request while the desktop keeps its own authority.
- `packages/dsh-task-board/tests/trust-forwarded-proxy.spec.ts` (11 tests) and `tests/trust-forwarded-proxy-settings.spec.tsx` (4 tests) cover the counter-case through the generated copy: `isForwardedLoopbackRequest` needs all three facts, the board refuses the shape with the switch off, admits it with the switch on and a same-origin marker, refuses an explicit cross-site post, and the settings card exposes the switch as volatile. That spec is the only direct coverage of the new shared predicate; the shared source has no spec of its own.
- Repository gates: `node scripts/verify-docs.mjs`, `pnpm emoji:check`, `pnpm i18n:check`, `pnpm test:scripts` (which carries the sync drift gate) and `pnpm test:standards` are green with the change, and the specs above are the affected lanes of `pnpm -r test`.
