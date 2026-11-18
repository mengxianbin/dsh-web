# Agent Note: dsh-session-revive stops the v2 wake/probe timer self-spin

Status: implemented

## Problem

On 2026-11-17 the DSH web host main thread ran at 100 percent of one core for
hours: API latency carried a ~400 ms floor, `/api/session/list` took 4-8 s, and
the client re-ran its full bootstrap roughly every 25 s - the "dsh-web keeps
reconnecting" report. A 12-second inspector CPU profile attributed the burn to
the revival v2 timer chain:

```
listOnTimeout -> applyV2 -> armProbeLoop -> routesNeedingProbe
  -> resolveBaseURL -> readSettingsNamespace -> settings.describe()
     (full profile-directory scan: readFileSync/existsSync/lstat/structuredClone)
```

`dsh-config-editor` alone was 29 percent of samples and native fs 24 percent,
because every pass paid a complete profile scan.

Two compounding defects in the shell's re-arm made it a closed loop:

1. **Overdue wake deadline -> `setTimeout(0)` spin.** `releaseDue` releases a
   parked session only on a green cached route, so while the route is unprobed
   it returns nothing, `nextWakeAt()` keeps returning a deadline already in the
   past, and `armV2Wake` re-armed at 0 ms forever.
2. **Probe timer starvation.** `applyV2` arms the wake timer (A) before the
   probe timer (B); both were 0 ms, so A fired first, and every pass
   `armProbeLoop` cleared B and re-registered it behind A. The probe never ran
   (80 minutes of log, zero `v2-probe` lines), the route never went green, and
   defect 1 never resolved.

The boot sweep at 01:42 left four sessions pending with past `plannedAt`, which
is what closed the loop that morning.

## Decision

Three scheduling rules live in `src/v2-timers.ts` as pure functions (tested
without mounting the plugin); `src/index.ts` only wires them:

- **Wake floor** - `wakeDelayFor(deadline, now)`: an exact delay for a future
  deadline, `WAKE_RETRY_FLOOR_MS = 1_000` for an overdue one. An overdue
  release is blocked, so the best the timer can do is poll at 1 Hz instead of
  spinning.
- **Probe timer plan** - `planProbeTimer(pending, targets)`: keep a pending
  timer (never restart the randomised 60-120 s countdown, never clear a
  due-now timer), clear it when no session needs a probe, and arm an immediate
  one only when the pending timer is not itself immediate. A more urgent
  schedule still wins, so a route that just lost its cache probes at once.
- **Settings read TTL** - `makeTtlReader(SETTINGS_READ_TTL_MS = 5_000)` wraps
  both namespace reads in `makeResolveBaseURL`, taking `settings.describe()`'s
  full directory scan off the hot path. An `undefined` result is cached too, so
  a transient settings hiccup costs one TTL rather than one scan per pass.

`armWake` (the policy wave timer) carries the same `Math.max(0, ...)` shape but
was left alone: its `releaseDue` always clears `wave.held`, so `nextWakeAt()`
returns null and the timer terminates by construction.

## Alternatives considered

- **Floor every wake delay with `Math.max(FLOOR, delay)`** - rejected: it would
  also push legitimate near-future deadlines out by up to a second. Only an
  already-passed deadline is floored.
- **Defer `baseURL` resolution out of `routesNeedingProbe`** (resolve only in
  `runProbeRound`) - cheaper still, but it changes the machine contract and its
  tests; the TTL keeps this fix inside the shell, where the burn was.
- **Restart only, or disable the plugin** - a restart clears the pending set and
  lets one probe slip in, but the same boot-sweep timing race recurs on the
  next restart; disabling loses the revival account entirely.
- **Switch to `settings.get`** - the settings service exposes no single-
  namespace read (only `describe`), so there is no cheap read to switch to.

## Consequences

- An overdue release polls at 1 Hz and the probe timer actually runs, so a boot
  sweep's parked sessions release on the first green probe instead of pegging
  the host main thread.
- A settings edit reaches route resolution within 5 s; probe rounds are 60-120 s
  apart, so no observable behavior changes.
- The loop stays event-driven: zero parked sessions still means zero timers.
- The bundle is rebuilt into `lib/index.js`, which the installed profile copy
  shares by hard link; the running host only picks it up after a DSH web
  restart (repository rule: the agent does not restart the service).
- Left untouched as out of scope: `@linxin666/dsh-usage` reads the same
  `describe()` from its credential path, but per-turn rather than in a spin.

## Testing

`tests/v2-timers.spec.ts` pins the three rules: the overdue wake floor, the
keep/clear/arm probe plans (including "never restart the countdown" and "never
clear a due-now timer"), and TTL caching including the cached `undefined`.
Package typecheck, vitest (155 tests, 12 files) and build are green.

See also: [revival v2 probe gate and state machine](../feature/2026-11-17-session-revive-v2-probe-statemachine.md).
