# Agent Note: dsh-session-revive boot sweep (restart revival at activation, zero quota)

Status: implemented

## Problem

The [2026-11-03 session-revive note](2026-11-03-session-revive.md) shipped the
error-path revival account, but it can only react to `turn/end` events. A Host
restart kills sessions mid-turn, and the `interrupted` closer is appended only
when the session is next resumed (design doc
`content/tech/ai/dsh/session-auto-revival-design-1102.md` §4.2 条3, harness
`agent-loop` `resumeWith`): an idle killed session emits nothing at all, so the
listener waits forever and the session stays dead. The 2026-11-08 ruling flips
the design — 重启要自动复活，并且重启这一次不算额度 — so activation needs an
active scan for those orphan turns, and that batch of revives must not consume
the 4h x 4 quota while the breaker, the stagger, the 150k watermark, and the
wave probe still bound it.

## Decision

- **Boot sweep at activation** in `src/sweep.ts`, wired fire-and-forget in
  `src/index.ts` after the status route (canceled by the plugin's existing
  `AbortController` at teardown). One `boot-sweep` summary line per activation
  carries the counts; every failure is a loud `boot-sweep-failed` line and
  stops that path — an unconfirmed session is never nudged (fail closed).
- **Two-tier screen over existing seams, zero harness changes**: tier 1 reads
  `sessionController.list({ includeArchived: false, trimHeavyProjections: true })`
  rows' harness-maintained `turnBoundary` projection — a numeric
  `openTurnStartSeq` means the final `turn/start` never met a `turn/end` as of
  the last checkpoint flush, `null` proves the turn closed, absent means no
  usable checkpoint; tier 2 (no projection-cache record) skips the screen and
  goes straight to the raw read. Measured on this machine's corpus
  (2026-11-08): 1627/1803 sessions carry cache records; of the 20 orphan turns
  at scan time, 15/15 with records were screened hit with 0 missed and 0 false
  positives, and the 5 without records ride tier 2 (176 sessions / 80MB / ~4s
  full decode, background).
- **Raw confirmation before any nudge**: `sessionPersistence.open(id, 'read')`
  → `handle.read()` returns the unbalanced stream, forward-balanced here
  (`turn/start` opens, `turn/end` closes). That is the only source that
  distinguishes an unclosed turn from a committed `interrupted` closer, and it
  folds the last `assistant/message` usage (`inputTokens + cacheReadTokens`)
  into `policy.recordUsage` so the 150k watermark actually bounds sweep
  revives. An `isAttached` re-check after the read keeps a session a human
  opened mid-sweep from being double-driven.
- **Attribution is structural, not heuristic**: every in-process stop commits
  a `turn/end` (human abort → `aborted`, goal block → `blocked`, fork →
  `forked`, failures → `error`, resume → `interrupted`), so a cold session
  whose raw log ends inside a turn can only have been left that way by the
  process dying mid-turn — a restart. No time window is introduced
  (参数零改).
- **`RevivalPolicy.onBootSweep`** (`src/policy.ts`) runs the error-path gates
  minus the quota can: tripped and breaker checks, wall suspension (expired
  holds fall through exactly like the error path), the 150k watermark, and the
  global stagger slot for `plannedAt`; `lastRevivalAt` arms the breaker so a
  sweep revival that dies again inside 10 minutes trips through the normal
  path. It never stamps `quota`, never touches `counters`, and its parks use
  `sweepSkip` instead of `skipRecord`, so status `counters`/`quota` stay
  byte-identical (拍板⑪ status 零增) — the decision line itself is the
  evidence. `BOOT_SWEEP_CODE = 'boot-sweep'` keeps the nudge a plain 继续 and
  keeps the wave probe out (same isolation as `ROUTE_SWITCH_CODE`).
- **Boot readiness is retried, not raced**: a rejecting listing or a listing
  where no row carries `turnBoundary` yet waits and retries within a fixed
  attempt budget (6 x 1s, plumbing rather than a ruled parameter), then gives
  up with the loud line.

## Alternatives considered

- **Subscribing for the `interrupted` closer / waiting on `session/event`**:
  rejected — the closer is only appended at resume-load, so an idle killed
  session emits nothing and the subscription never fires; this is the design's
  §4.2 条3 structural fact and it still holds.
- **Screening on `lastPromptAt > lastTurnOutcome`**: rejected as the primary
  signal — that fold only advances at `turn/end`, so it cannot see the open
  turn itself and it shares the same write-behind window as `turnBoundary`
  while adding a false-positive class; `turnBoundary` is the harness's own
  client-visible "interrupted mid-turn" summary signal.
- **Full-corpus raw scan at activation**: rejected as the boot path — offline
  measurement of all 1803 transcripts took 19.5s with tail-frame decoding
  alone, full decode worse; the projection screen bounds raw reads to
  candidates (the ~21 screened plus the 176 checkpoint-less rows).
- **`sessionQuery.readSession` (balanced) for confirmation**: rejected — its
  synthetic closer is shape-identical to a committed one (both come from
  `interruptedTurnClosers`), so it cannot tell "never resumed" from "already
  resumed"; the persistence read is unbalanced and can.
- **A recency window on which orphans to wake**: rejected — no time window is
  ruled (参数零改), the design text says scan orphan turns unqualified, and a
  window would be a new ruled value needing its own statistics re-run; the
  first activation's historical backlog is a one-time cost already bounded by
  the watermark, breaker, and stagger.
- **Routing sweep parks through `skipRecord`**: rejected — it mutates
  `counters` and `skipReasons`, which would break the status-zero-increase
  behavior criterion; `sweepSkip` keeps the ruled account byte-identical.

## Consequences

- The first activation after install wakes the historical backlog in one
  staggered batch (measured ~20 orphans including September/October
  leftovers); afterwards each boot only sees orphans cut since the previous
  one. The README states this so the batch wake is not mistaken for a bug.
- The screen trusts the projection checkpoint, which lags the log by the
  write-behind window (`writeIntervalMs: 5000` / `writeEveryEvents: 200`;
  mandatory flush only at creation, `turn/end`, and disposal): a hard-kill
  restart landing inside that window after an orphan's `turn/start` leaves
  that orphan unscreened until the next activation, while a graceful restart
  flushes at session disposal and is caught. Because every screened candidate
  is raw-confirmed, the lag can only miss — it can never revive a closed
  session.
- Sweep decisions are invisible to the status account by design:
  post-restart verification reads the `boot-sweep` summary and the
  `code: "boot-sweep"` decision lines, not counters. The error-path account
  (this package's original decision) is unchanged.
- Sessions without projection-cache records are raw-read on every activation
  until they run live once and gain a record; a deployment with no projection
  cache at all falls through to a full raw scan after the list attempt budget.

## Testing

`tests/sweep.spec.ts` (10 tests) locks the screen classes, the raw tail
balance (including a committed `interrupted` closer reading as closed), and
the orchestration through a fake deps surface: candidates-only reads, retry on
a rejecting listing, projection-less fall-through, list give-up, the missing
persistence seam failing closed, the attached-race skip, the pre-abort quiet
stop, and per-session read-failure containment. `tests/policy.spec.ts` grew to
34 tests with a boot-sweep block covering byte-identical `counters`/`quota` on
both revive and park, breaker arming plus trip plus stopped re-entry, the whole
4h x 4 can left for the error path, the 150k watermark park, stagger spacing,
and wall-suspension hold/fall-through. The three package gates (typecheck,
vitest 62 passed, build) are green; no test touches a real session lifecycle,
so the sandbox rule was never engaged.
