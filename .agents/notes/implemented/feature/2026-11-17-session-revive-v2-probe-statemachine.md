# Agent Note: dsh-session-revive adds the revival v2 probe gate and three-triage state machine

Status: implemented

## Problem

The ruled revival account (quota, breaker, waves, watermark) can only react
after a death is already in flight: a revive nudge is planned from the ruled
lists alone, with no proof that the provider path is alive, no distinction
between a session that spent tokens without progress and one that never
started, and no verified path for a dead session's work to be saved at all.
The 2026-11-16 design (m-note `content/tech/ai/dsh/session-revival-v2-alert-inbox-1116.md`)
names three failures: blind sends on a dead route (the probe result is never
observed), money burned on sessions that cannot progress (no spend x
progress triage), and a dead session whose transcript the relay save needs
but nobody proved readable (archive assumed, never checked). The 施工单
(`content/tech/ai/dsh/tasks.md#revive-v2-probe-statemachine-1116`) fixes six
items in one package, with the fail-closed first gate as 施工第一步.

## Decision

Six additive pieces, all in `packages/dsh-session-revive` (host face only);
the ruled account's parameters, code lists, status `quota`/`waves` and
health facts stay untouched (翻裁项只写档不改运行时):

- **Fail-closed first gate** (`src/v2-transcript.ts`): at activation the
  plugin walks an archived session's multi-frame zstd transcript (magic
  boundary frame walk, zero bad frames, at least one event). No sessions
  root or an empty ledger passes as "nothing archived yet"; a non-empty
  ledger whose ids resolve to no readable transcript FAILS, and every v2
  entry point then emits only a `v2-halt` record - no attempt, no state.
- **L2 probe gate** (`src/v2-probe.ts`): GET the route's provider baseURL
  through the global fetch slot (the dispatcher's proxy - the same egress
  real requests use). ANY HTTP response, 4xx/5xx included, proves the path
  alive; only a connection-layer failure parks. L1 TCP attribution
  (`local-egress-down` vs `provider-path-down`) never grants permission,
  and no L3 token spend exists. Cadence is event-driven 60-120s randomised,
  only while a session is parked (zero parked = zero probes); the suggested
  `N = 2h` for `probeRedAlarmed` lives in `PROBE_RED_ALARM_MS` and stays
  marked 待拍板 in the design's section-eight TODO.
- **Three-triage state machine** (`src/v2-machine.ts`): the section-three
  transfer table as a pure class - probe red parks (no attempt, no
  transcript events, re-probe on cadence); 0-token failure cools down 10
  minutes and strikes (3 -> stop `zero-cost-3strike`, attribution
  probe-false-green / classification anomaly); spend without progress opens
  the structured-reason archive-relay intent at relay depth 1 (recidive ->
  keep the scene, stop `relay-recidive`); spend with progress cools down and
  grants exactly one retry (re-failure -> stop `progress-retry-failed`);
  any completed turn clears every counter. Progress is the two-level boolean
  (L1 activity AND L2 effectiveness), and the ACTUAL form decides - a
  granted retry that dies 0-token re-joins the zero-cost channel.
- **Archive-relay-save chain** (`src/v2-chain.ts`): verify transcript ->
  resolve spawn target -> archive with the structured reason -> spawn the
  relay (seed carries `relayDepth=1` and the 代劳 save first step) -> rewrite
  the ledger reason. A pre-flight refusal stops the chain BEFORE any
  archive; the reason rewrite after a successful spawn is best-effort.
  The chain runs over loopback REST because archive and dispatch are
  sibling plugins with no in-process face.
- **False-green / false-red 保底**: the three-strike stop carries the
  false-green attribution; `probeRedAlarmed` fires once per red run past N;
  both live in the section-seven export for the alert-inbox reader.
- **State export** (`src/v2-state.ts`): `<dsh-home>/session-revive-v2-state.json`,
  change-only (the `sessions` payload is compared, `at` rides along), the
  literal section-seven field set, atomic temp+rename, best-effort - a state
  hiccup degrades to an absent file, never to a half-written one.

Wiring is additive in `src/index.ts`: every revive decision - live and
shadow alike - routes through the machine (only a granted attempt is sent,
and only in live mode); event feeds carry turn/end deaths, assistant spend
and the structural refusal probe, tool activity halves, the durable route,
and disposal; the probe loop and the machine's wake timer ride the same
cordis effect and tear down with it.

## Alternatives considered

- **Probe with a real 1-token call (L3)**: rejected - even an input token
  costs money on output, and any HTTP response already proves the path.
- **Treat 4xx as red**: rejected - a 401/404 proves the route answers; the
  gate answers "is the path alive", not "are credentials valid".
- **Probe on a fixed timer regardless of state**: rejected - design section
  five demands event-driven 60-120s with zero parked sessions meaning zero
  probes.
- **Triage by attempt count instead of actual form**: rejected - the
  design's discipline sentence (a granted retry dying 0-token rejoins the
  zero-cost channel) exists exactly to prevent a channel-shaped miscount.
- **Gate only live mode**: rejected - shadow must exercise the same gate so
  its evidence lines match what live would do; side effects stay live-only.
- **Rebuild quota/waves/breaker inside v2**: rejected - the 翻裁项 red
  line keeps the ruled account the single quota source; v2 only withholds.

## Consequences

- Takes effect only after the user restarts the dsh web host: the bundle is
  rebuilt, but a running host keeps the old code - restart is user-owned
  per repo rule, never AI-initiated.
- While the first gate fails, NO revival runs anywhere: a torn archived
  transcript halts the mechanism loudly instead of risking a partial 代劳
  save.
- A session parked on a red route consumes zero events until the probe goes
  green; an unresolvable baseURL parks with `route-unresolved` attribution
  instead of failing sends.
- The state export is a new bilateral file; the alert-inbox reader consumes
  the literal section-seven field set (and tolerates unknown fields on its
  side only).
- Repo-level `docs:check` / `i18n:check` currently fail on pre-existing
  issues in OTHER packages (dsh-better-sidebar locales, dsh-auto-route
  pairing, dsh-i18n ru keys); this package's own README pair is re-recorded
  and its files are absent from both failure lists.

## Testing

Package gates: `pnpm typecheck` (exit 0), `pnpm test` (exit 0 - 11 files,
145 passed, 70 of them new across the five v2 spec files: transfer-table
row-by-row, fail-closed halt preceding any attempt, chain order with every
pre-flight stop, section-seven field set, change-only write self-check,
probe verdicts / L1 attribution / cadence bounds), `pnpm build` (exit 0).
The 翻裁连带列 zero-deletion grep reports 0 deleted lines across
policy/config/health-state/routes/sweep/selflearn, and the v2 sources
mention quota/waves only in the compliance sentence that says they are
untouched. No test touches a real session lifecycle - the sandbox-workspace
rule was never engaged.
