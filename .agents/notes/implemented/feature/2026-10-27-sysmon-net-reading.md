# Agent Note: Sysmon chip v4 — passive provider-network reading

Status: implemented

## Problem

A day of frequent `connection error` / `request timeout` failures showed the
chip's blind spot: CPU, memory and disk measure the local machine, so every
host metric could read green while the model link was falling over. The
information existed only in hindsight, buried in the trajectory timing tab
(per-turn TTFT) and the chat retry banner — nothing on the primary surface
answered "is the provider link healthy right now?", and the original sysmon
ruling (7-point decision, item 4) had explicitly deferred networking.

## Decision

Add a fourth read-out fed **passively** by two harness agent events, both
observed on the profile bundle's root context with zero behavior change:

- `agent/assistant-stream` (emit): an attempt `start` frame stamps the clock,
  the first `chunk` settles it into a TTFT reading (connect + first byte +
  first token on the exact route real requests travel, proxy configuration
  included), an `end` without a chunk drops the attempt.
- `agent/request-error` (waterfall): counts failures whose `LlmFailure.code`
  is `TIMEOUT` or `TRANSPORT`, then delegates `next()` untouched.

Both feed one **10-minute sliding window** (`src/core/net.ts`, a pure,
clock-injected tracker; pruning happens on read, so an idle host costs
nothing). The payload's new optional `net` field carries `ttftMs`,
`failures`, `provider` (route label for the tooltip) and `warn`; the chip
renders `128ms` / `⚠3` / `128ms ⚠3` / `—` and reddens once the windowed
failure count reaches `netWarnFailures` (default 1, `0` disables the red
state). An empty window reads `—` — the disk row's "never show stale values"
rule, with the bound matched to request cadence instead of the disk row's 5s.

**Zero active probes, zero extra traffic.** The rejected alternative was a
periodic HTTPS probe: it would add its own rate-limit/traffic surface, needs
a token-free endpoint choice, and must replicate the harness proxy settings
to measure the real path — all to obtain a number the actual requests already
produce for free.

## Constraints

- **Prepend is load-bearing.** llm-retry answers a retried failure by
  returning its retry decision *without* calling `next()`, so a listener
  registered behind it would be bypassed on exactly the failures worth
  counting. The failure listener registers with `{ prepend: true }`, observes
  first, and changes nothing downstream (`tests/net-observe.spec.ts` pins the
  posture).
- **Events shim**: the pinned SDK cohort (`@deepseek-ai/dsh-agent`
  ^0.1.2-rc.1) predates `agent/assistant-stream`, so `net-observe.ts`
  carries a type-only `declare module '@deepseek-ai/cordis'` block mirroring
  the harness declaration verbatim; delete it when the cohort ships the
  official one (identical-key augmentation would then conflict — the
  SlotMap-shim precedent).
- One unscoped listener covers every session: scope-filtered dispatch admits
  untagged listeners for all agents (the describe-image precedent).
- The chip keeps its degradation ladder: a pre-v4 host simply omits `net`
  (optional field) and the client renders the dash; a 404 still hides the
  whole chip.

## Alternatives considered

**Active provider probe (periodic HTTPS round-trip).** Rejected per the
2026-10-27 ruling (`q-source`): extra traffic, endpoint/token selection, and
proxy-path fidelity problems, versus passive observations that ride the real
request path. Kept as the fallback if "always-live readings during idle"
ever matters more than zero traffic.

**Bare latency milliseconds only.** Rejected per the same ruling (`q-form`):
a request that times out produces *no* latency value at exactly the moment
the signal matters most — the failure count is the direct reading of the
observed symptom, TTFT is the auxiliary one. Hence the dual reading.

**Measured connect/TTFB as a separate phase.** Deferred: TTFT mixes
provider queue time into the reading, but separating the connect phase
needs another instrumentation point inside the adapter. Recorded as a
known limitation in the m-note design draft instead. (Later the same day
the `sysmon-net-direction` revision shipped exactly this split — see
[conn-latency](2026-10-27-sysmon-conn-latency.md).)

**Show the count only when it reaches the threshold.** Rejected: the badge
is a count (`⚠2` stays unreddened below a threshold of 5), so sub-threshold
failures remain visible rather than disappearing.

## Consequences

- The chip now has four read-outs (`data-warn` gained the `net` key; the
  skin-center semantic-attrs contract row was updated), and the tooltip has
  a network line with the route label plus an idle notice for the empty
  window.
- Multi-provider caveat: the window is shared across routes, and `provider`
  reports the most recent observation's route — readings are attributed to
  that route in the tooltip only.
- Config surface grew by one key: `netWarnFailures` (default 1).
- Package tests grew 45 → 67 (`net.spec.ts` windowing/format, 
  `net-observe.spec.ts` wiring posture, chip render cases); docs:check and
  i18n:check (16 namespaces / 1292 keys, zh↔ru including the four new sysmon
  keys) stay green.
- The m-note design draft (`content/tech/ai/dsh/dsh-sysmon.md`, v4 entry)
  carries the ruling provenance: this note is its implementation record.
- Same-day revision: the latency half now measures the connection segment
  and TTFT left the main grid and the tooltip (user ask
  `sysmon-net-direction`) — shipped shape in
  [conn-latency](2026-10-27-sysmon-conn-latency.md); this note keeps the v4
  decision record as written.
