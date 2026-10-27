# Agent Note: Sysmon net reading — a single-target ICMP round trip replaces the connection segment (A-case)

Status: implemented

## Problem

The connection-segment reading (2026-10-27, [sysmon-conn-latency](2026-10-27-sysmon-conn-latency.md))
was dimensionally honest but still a *stack* of spans: local-proxy CONNECT
reply plus TLS tunnel handshake equals two to three round trips, over a
cross-border path, so the chip showed 477ms-scale numbers next to
percent-metered CPU/memory/disk — read at a glance, that looks like "the
network is terrible". On 2026-10-28 the user reflected that network quality
has too many internal stages for any single parameter to express all of
them, and asked to give 【网络质量】 one simple meaning instead. The
reference the user reached for was their own `ping api.deepseek.com` —
19ms, an ICMP echo round trip: bare network layer, nothing else in the
number. The user ruled (ask id `net-quality-semantics`, option A,
recommended): the main cell reads a single-target domestic ICMP RTT;
cross-border/proxy trouble is carried by the failure half; and because a
probe is an active packet, this ruling **supersedes the 2026-10-27 "zero
active probing" judgment** (the user accepted low-frequency probing
explicitly when choosing A).

Probe evidence same day (this machine): `ping api.deepseek.com` →
123.54.208.173, avg 19ms, 0% loss; `ping opencode.ai` → 172.65.90.20,
avg 237ms — same NIC, same instant, 12× apart, which is exactly the
destination-dependence that makes a *fixed* reference target the only way
a one-number reading can mean "this machine's network". The retired
reading decomposed as: via-proxy TLS setup 520/647ms, direct TCP connect
189/679ms (curl), against the chip's live `connMs=477, connVia=proxy`.

## Decision

The fourth read-out now shows **the round trip of one ICMP echo to a fixed
domestic reference target** — the same concept `ping <target>` measures:

- `src/host/ping-probe.ts` (new): one round immediately at start, then one
  per `PROBE_INTERVAL_MS` (60s) *after the previous round settles* — a
  slow or failing probe can never overlap itself. It spawns
  `ping -n 1 -w 3000 <target>` (hidden window, stdout piped), decodes stdout
  as **GBK/ANSI** (probe-verified: Chinese Windows writes the system code
  page on a pipe — first line bytes `d5fd d4da` = "正在", not UTF-8; a
  UTF-8 decode garbles the `时间` prefix and silently nulls every reading),
  parses both Windows locale shapes (`时间=19ms` / `time=19ms`, `<1ms` → 1)
  with an ASCII-only `NNms` fallback for a UTF-8-configured system (the
  reply line always precedes the statistics on exit 0, so the first token is
  the reply's), and reports timeout, loss, non-zero exit, or a spawn error
  as `null`. One 32-byte packet per minute: the traffic cost the earlier
  ruling wanted to avoid is negligible at this cadence, and the user
  accepted it in the A-case.
- **Failed probes record nothing** — the last good round trip stands until
  `RTT_STALE_MS` (150s = two intervals + grace) ages it out to `—`. A
  single dropped packet does not blank the cell; sustained probe loss does,
  which is the disk row's "never show stale values" rule at probe cadence.
- `src/core/net.ts`: `NetMonitor` sheds the whole pending-attempt /
  connection-attribution machinery (`noteStart`/`noteConnect`/`noteChunk`/
  `noteEnd`, `MAX_PENDING`, FIFO rules — rollback anchor for all of it is
  commit `8ec42c58`) and gains `noteRtt(ms | null)`. The 10-minute
  failure window, `TIMEOUT`/`TRANSPORT` classification, the
  `{ prepend: true }` posture, `netWarnFailures`, and the `⚠n` badge are
  untouched — **RTT itself never reddens**; the red state stays the failure
  threshold's decision. `provider` is now sourced only from counted
  failures (the probe has no route), so the tooltip's route label appears
  when failures are present and never claims a route for the RTT.
- Wire: `SysmonNet` swaps `connMs`/`connAt`/`connVia` for
  `rttMs`/`rttAt`/`probe` and keeps all three plus `ttftMs` as **always-null
  retired stubs**. New client + old host degrades via `?? null` to
  dash/failures; old client + new host reads the null stubs and also shows
  a dash — neither restart window renders `NaN`, and the old client never
  mistakes a leftover `connMs` for an RTT (it is emitted null).
- `src/host/net-observe.ts` keeps exactly one listener: the prepended
  `agent/request-error` counter (prepend remains load-bearing — llm-retry
  answers retried failures without calling `next()`). `conn-tap.ts` and
  the `agent/assistant-stream` attribution window are deleted along with
  their tests; the local Events shim for `agent/assistant-stream` went with
  them.
- Client: `formatNetValue` reads `rttMs` (`19ms` / `⚠3` / `19ms ⚠3` /
  `—`); the tooltip renders `chip.netDetail` with `{rtt}`, rewords
  `chip.netIdle`, and replaces the two handshake-shape notes with one
  honest measurement note `chip.netPath` carrying `{target}` — "ICMP echo
  round trip to {target} — network-layer latency only, no DNS/TCP/TLS
  handshake or proxy overhead". zh/en in the package, ru mirror in
  dsh-i18n. Judge source for the wording: ask `net-quality-semantics`
  ("含义更单纯").
- Config: `netProbeTarget` (default `api.deepseek.com`; `''` disables
  probing — RTT half reads `—`, failures keep counting). The declared
  `Config` interface marks it optional while the schemastery default fills
  it at runtime, so the wiring narrows explicitly.
- The skin-center semantic-attrs `chip` row needs no change (its `net` key
  only ever described the failure alarm).

## Alternatives considered

**B — dual target (domestic reference + current provider domain).**
Rejected with the ruling: the reading stops being single, and ICMP to the
provider domain probes the *direct* path while real model traffic rides
the proxy tunnel — it would measure a path the traffic never uses.

**C — keep the connection reading, reword the tooltip only.** Rejected:
the number stays in the hundreds of milliseconds, which is the confusion
being fixed, not the wording.

**Ping through the proxy / TCP-timing through the proxy.** ICMP cannot
traverse an HTTP proxy; a TCP/TLS timing through the tunnel reintroduces
the multi-span stacking the ruling removes. The A-case semantics are
deliberately "this machine's local network", not "the provider path" —
the provider path's trouble shows up as counted failures.

**Per-success-probe reset of the failure window.** Not done: the failure
half's 10-minute meaning is pinned by the earlier dual-reading ruling and
the A-case only replaced the latency source.

## Consequences

- Four states and warn semantics unchanged (`19ms` / `⚠3` / `19ms ⚠3` /
  `—`; `data-warn` still carries `net` on the failure threshold alone).
- Destination-dependence is now a documented property, not a surprise:
  the same network measures 19ms to the domestic reference and ~237ms to a
  cross-border anycast — the fixed target is what makes the single number
  mean "local network". Cross-border health lives in `⚠n`.
- Probe cadence is host-side and dies with the plugin effect (disposer
  clears the timer, kills the in-flight child, and suppresses late
  results); the timer is unref'd so it never holds the process open.
- Tests 81 (82 − deleted conn-tap/attribution suites + probe suite): the
  conn-tap and attribution suites are gone; `ping-probe.spec.ts` covers the
  parse (zh/en, `<1ms`, ASCII fallback, timeout/null cases), the GBK decode
  against the probe-verified byte shape, the encoding-label fallback, and
  the loop (settle-based cadence, failure/spawn-error reporting, spawner
  arguments, dispose posture). Per file: net 12, net-observe 3,
  ping-probe 12, chip 18, seats 7, routes 4, sampler 9, sample 16.
- Gates green: package typecheck / test (81) / build; repo typecheck,
  `docs:check` (README pair re-recorded via `docs:write-pair`),
  `i18n:check` (16 namespaces, 1293 zh = 1293 ru), dsh-i18n tests (10).
  Repo-wide `pnpm test` (no-bail): 21/23 packages green; the two reds are
  outside this batch — `dsh-task-board` (zero files touched; isolated rerun
  334/334 green, load-jitter class matching the in-case dsh-doctor /
  dsh-plugin-manager flakes) and the sysmon run itself landing inside this
  batch's edit window (final settled state: 81/81).
- Host-half effect needs a DSH web restart (owner: user); the client half
  lands with F5. During the restart window the wire stubs keep both
  bundle generations rendering a dash rather than `NaN`.
