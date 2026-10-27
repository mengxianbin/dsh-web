# Agent Note: Sysmon net reading — the connection segment replaces TTFT

Status: implemented

## Problem

The v4 network reading ([sysmon-net-reading](2026-10-27-sysmon-net-reading.md))
measured TTFT — attempt start to first chunk. TTFT sits too high in the stack:
provider-side queue time and first-token generation ride along in what should
be a network signal, so seconds of server wait drown a millisecond-scale
network component, and the number answers "how slow was the model" rather
than "is the link healthy right now" — limited value for coarse first-pass
triage. The user pinned two judgments the same day (ask id
`sysmon-net-direction`, task `#sysmon-conn-latency-1027`): pure connection
latency is the dimensionally equal partner of the CPU/memory/disk read-outs,
and TTFT's altitude limits its first-glance diagnostic worth. The failure
half of the dual reading and the "zero extra traffic, no active probe"
ruling stayed in force.

## Decision

The fourth read-out now shows the **pure connection segment** — DNS lookup →
TCP connect → TLS secureConnect — passively stamped at the socket layer of
the same real model request that carried the call:

- `src/host/conn-tap.ts` wraps the process entry points the undici fetch
  stack calls (`net.connect`, `net.createConnection`, `tls.connect`),
  records each first hop in a WeakMap, and reports one segment per completed
  TLS handshake. Direct handshakes measure from the `tls.connect` call (DNS +
  TCP + TLS, all real network); a local-proxy CONNECT tunnel links the
  loopback first hop to its TLS leg and measures first-hop start →
  secureConnect — loopback TCP plus the CONNECT reply plus the tunnel
  handshake, network-dominated. `connVia` carries the shape (`direct` |
  `proxy`) to the payload.
- `src/host/net-observe.ts` keeps attempt `start` frames as the attribution
  window: a settled segment goes to the oldest pending attempt and is
  dropped when none is pending, so background traffic outside a model
  request never enters the reading. `chunk`/`end` only close the window — a
  request that reuses a warm keep-alive socket has no new segment to show
  (documented loss; undici's idle timeout makes fresh connections the norm
  per step anyway).
- `src/core/net.ts` replaces the TTFT settle with `noteConnect(ms, via)`.
  The 10-minute sliding window, `TIMEOUT`/`TRANSPORT` failure counting, the
  `{ prepend: true }` failure observer, and `netWarnFailures` are untouched.
  The payload swaps `ttftMs`/`ttftAt` for `connMs`/`connAt`/`connVia` and
  keeps `ttftMs: null` as a wire stub: a pre-revision client bundle polling
  a revised host renders the dash instead of `NaNms` during the restart
  window (the mirror of v4's optional-`net` degradation).
- The tooltip drops the first-packet wording, renders `连接 {conn}`, and adds
  an honest segment-shape line (`chip.netPathDirect` / `chip.netPathProxy`,
  zh/en + the ru mirror in dsh-i18n) — the judge source demands the number
  never claims more than it measures.

## Probe evidence (2026-10-27, this machine)

- Egress is proxied: the host process (pid 15000) held four established
  `127.0.0.1:* → 127.0.0.1:7897` connections (clash-verge / mihomo) and zero
  direct `:443`; `HTTP(S)_PROXY=http://127.0.0.1:7897`,
  `NODE_USE_ENV_PROXY=1`, and the harness `util/http-proxy` installs an
  undici `ProxyAgent` global dispatcher.
- Socket-layer capture works for both shapes on Node 24.16: direct
  `tls.connect({host})` landed lookup/connect/secureConnect at
  +309/+1457/+2453ms in the probe; the proxied path landed
  `net.connect(127.0.0.1:7897)` at +2ms (loopback) and then
  `tls.connect({socket, servername})` with `secureConnect` +1212ms over the
  tunnel. The tap therefore gets real timestamps without touching the
  adapter — no fallback brief was needed.
- Ruled unusable by probe: Node perf `http` entries (the undici stack never
  emits them), fetch Resource Timing (under the proxy every phase field
  collapses onto one timestamp: dl = conn = secure = 53.4ms), and undici
  diagnostics channels (they fire, but carry no connect-phase timestamps).

## Alternatives considered

**Keep TTFT beside the connection reading.** Lost to the ruling: the grid
has one slot per metric, and a seconds-scale TTFT next to a milliseconds-
scale handshake reintroduces exactly the noise the ruling exists to remove;
the failure count already carries the "requests are hurting" half.

**Perf-hook HTTP phase timing (`phases.dns/tcp/tls`).** Node only emits
`http` entries for `node:http` client traffic; the undici fetch stack never
produces them (probe-verified), so the reading would silently never arrive.

**Fetch Resource Timing entries.** Present under Node 24, but behind the
local proxy every phase field degenerates to a single timestamp — wrong in
exactly this machine's dominant (proxy) configuration, where honesty about
the measured segment is the whole point of the revision.

**Undici diagnostics channels (`undici:*`).** Fire reliably but carry no
connect-phase timestamps; deriving the segment from them would need socket
identity bookkeeping for no gain over the direct socket tap.

**Active HTTPS probe.** Still rejected (v4 ruling `q-source`): extra
traffic, endpoint/token selection, and proxy-path fidelity problems. This
revision moves only where the passive number comes from.

## Consequences

- Four-state display unchanged (`23ms` / `⚠3` / `23ms ⚠3` / `—`); `data-warn`
  semantics untouched, so the skin-center semantic-attrs `chip` row needed no
  change (its `net` key only ever described the failure alarm).
- The wire change degrades safely in both directions: new client + old host
  falls back to dash/failures via `?? null`; old client + new host reads the
  `ttftMs: null` stub and also renders a dash — neither restart window shows
  `NaN`.
- Keep-alive reuse means the reading updates when a fresh connection
  happens; a window whose model requests all reused warm sockets reads `—`,
  which is consistent with the no-stale rule rather than a defect.
- The tap wraps process-global connect entry points in the host; the
  disposer is identity-guarded (a later wrapper wins and is left alone) and
  exception-proof in both directions (a throwing segment observer cannot
  break a socket). Tests pin both behaviors.
- Tests grew 67 → 82: net windowing/format (FIFO attribution, pollution
  filter, window aging), tap shapes (direct, proxy tunnel, non-loopback
  parent, error path, disposal, alias restore), wiring posture, chip grid
  and tooltip (incl. both path notes and the pre-revision-host dash), route
  payload. Package typecheck/build and repo `i18n:check` (16 namespaces,
  zh/en + ru parity on the three net keys) plus `docs:check` stay green.
- Host-half effect needs a DSH web restart (owner: user); the client half
  lands with F5.
