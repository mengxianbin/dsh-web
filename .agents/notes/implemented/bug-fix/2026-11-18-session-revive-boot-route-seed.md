# Agent Note: dsh-session-revive seeds the boot route from the stored log

Status: implemented

## Problem

Since the [v2 probe gate shipped](../feature/2026-11-17-session-revive-v2-probe-statemachine.md),
every boot sweep has sent zero nudges. The 2026-11-17 17:45 and 2026-11-18
01:42 boots each parked all candidates on `v2-gate defer route-unknown`
(`nudge-sent=0`, `model/selection=0` in both active logs), while the same sweep
before v2 sent 9 nudges per boot. The three sessions that later turned green
were woken by a human typing `continue` in the GUI, not by the plugin.

The gate itself was never wrong to ask for a route - a probe needs one - but
the route state it reads cannot survive the event it depends on:

1. `ReviveV2Machine` keeps `state.route` and `currentRoute` in memory only; a
   Host restart mounts the machine empty.
2. The only live fill is the `model/selection` event
   (`machine.setRoute`). It is appended only on an active selection change
   (`AgentModel.select` skips a same-value write), so an idle session - the
   exact population a boot sweep revives - never emits one. Auto-route only
   writes into its in-flight set, which is empty right after a restart.
3. The stored log already carries the route: the three 2026-11-18 candidates
   each hold 4-8 `request/header` events with `config.provider/config.model`.
   The sweep read those very events to confirm the orphan turn and folded
   `contextTokens`, but never folded the route.
4. With no route, `releaseDue` and `routesNeedingProbe` both `continue` past
   the session, so the 1 Hz wake poll retries a decision that can never
   change: a permanent fail-closed deadlock, invisible to the health file
   (five facts stayed `ok:true`).

The design doc (`content/tech/ai/dsh/session-revival-v2-alert-inbox-1116.md`
section five) specifies the probe target as "the current `model/selection`'s
provider baseURL" and has no clause for a session that has no such event -
the cold-start case was never designed.

## Decision

Route evidence is folded from the log the sweep already reads, and lands
before the decision:

- `scanOpenTurn` now folds a `route` alongside `open`/`contextTokens`: the
  latest `model/selection` not yet retired by a matching `request/header`,
  else the last header's config - the same fold as the harness's
  `modelSelection` projection (`pending ?? lastUsed`).
- `BootSweepDeps.seedRoute` (optional) is called for a confirmed, unattached
  orphan immediately before `decide`, and `ReviveV2Machine.seedRoute` stores
  it without overwriting evidence the machine already holds.

The decision then gates `probe-pending` instead of `route-unknown`, the
immediate probe round runs, and the green result releases each decision at
its staggered `plannedAt`.

A second, separate rule closes the anti-herd edge this creates: a probe that
turns green after several `plannedAt`s passed would release a whole batch in
one tick. `planNudgeDelay` (v2-timers) re-anchors every send on the previous
send's real firing time plus the configured `staggerMs`, so consecutive
nudges are always at least the ruled stagger apart, while an isolated nudge
is never delayed. The anchor lives in the shell (`lastNudgeAt`); the rule is
a pure function so tests can pin it.

## Alternatives considered

- **Seed `currentRoute` from the configured default at mount (option B).**
  Cheapest, but it is a guess: a session that actually ran on another
  provider would be probed and released against the wrong endpoint, and the
  wrong route would then be recorded as evidence. Lost to accuracy.
- **Exempt boot decisions from the probe gate (option C).** Restores the
  pre-v2 blast of nudges per boot, including into quota-walled endpoints -
  exactly the wall the v2 gate exists to hold. Rejected as a regression.
- **One-per-pass restamp inside `releaseDue`** so the machine itself never
  opens two attempts together. It would change machine semantics every
  release path depends on, and needs a stagger constant the machine does not
  own (the policy owns `staggerMs`). The send-side anchor covers every path
  with one pure function and no state-machine change.
- **Read the route at decision time from the session projection cache**
  instead of the raw log. The sweep already streams the raw events; a second
  read through another seam would double the I/O for the same facts.

## Consequences

- Boot decisions with stored route evidence now flow route -> probe ->
  staggered release; the deadlock class is closed for every session whose log
  records a request or a selection.
- Sessions with no route evidence at all (never made a request) still park
  `route-unknown` - fail-closed is preserved where there is genuinely
  nothing to probe.
- `currentRoute` still comes only from `model/selection`; this change adds a
  per-session seed and does not weaken that channel.
- Nudge sends now carry a guaranteed minimum spacing even when a deferred
  batch releases late (2026-11-12 anti-herd ruling), reusing the config's
  `staggerMs` (floor 10s).
- The built `lib/index.js` keeps its hardlink to the installed profile copy;
  the running Host picks the change up only on restart (repo rule: agents do
  not restart the service).

## Testing

Package gates green: `pnpm typecheck` (main + test configs), `pnpm vitest run`
12 files / 162 tests (7 new: route fold and seed-before-decide ordering in
`sweep.spec`, seed-then-probe-then-release and first-seed-wins in
`v2-machine.spec`, batch spacing in `v2-timers.spec`), `pnpm build`.
