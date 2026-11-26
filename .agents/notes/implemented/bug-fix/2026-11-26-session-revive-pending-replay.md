# Agent Note: dsh-session-revive replays deferred decisions across a restart and sweeps closed-error sessions

Status: implemented

## Problem

The 2026-11-26 incident, one chain in the active logs: at 11:21:20 a
`TRANSPORT` death (ba0d8ab6) was detected and the ruled account decided
`revive` (quota 1/4); the v2 gate deferred it `probe-pending` because the
route probe was red (11:21:23, 11:23:33). At 11:25:39 the UI restarted. The
deferred decision lived only in `SessionState.pending` — process memory — so
it evaporated with the process. The 11:26:20 boot sweep screened
`rows:6, candidates:3, revived:3`, but this session was already closed by
its error turn, and the sweep's criterion is "unclosed turn only", so it was
never a candidate. The probe turned green at 11:30:51 with no pending left
to release, and at 11:32:20 a human typed `continue`. Two-layer gap:

1. pending revive decisions are pure in-memory state — lost on any UI
   restart;
2. the boot sweep only screens unclosed turns — a session already closed
   with a revivable error is invisible to it, and the event-driven detect
   never replays an old error.

## Decision

Design first (仓规 #5): both rules landed in
`content/tech/ai/dsh/session-auto-revival-design-1102.md` §4.2 (rule one,
rule two, and the quota-boundary sentence 拍板⑪ 零额只免 boot sweep 计数)
before any code changed.

Rule one — pending persistence:

- New `src/pending-state.ts`: `readPendingEntries` is the ONE boot read
  (missing file = clean empty; any parse/shape/bound failure = a fail-closed
  result the shell turns into "skip ALL replay" plus one loud line), and
  `RevivePendingWriter` is the change-only atomic writer seeded from that
  very read — a replayed ledger re-stringifies byte-identically and costs
  zero writes. The file is bounded (`PENDING_MAX_ENTRIES`): an over-bound
  ledger is corruption, and an over-bound snapshot is never written (a
  stale-but-readable ledger beats an unreadable one).
- `v2-machine` gains `pendingSnapshot()` — exactly the `releaseDue` input
  set (plannedAt/code/channel/route/cooldownUntil; route falls back to
  `currentRoute`, the same fallback the release itself uses) — and
  `restorePending()`, which replays idempotently: live-wins (an existing
  pending or in-flight attempt is never clobbered), the gate is checked
  first (every v2 entry point fails closed), and `nextChannel` is restored
  beside `channel` so the attempt record's channel evidence does not drift.
- Shell wiring: read → restore → loud `pending-replay` (with count) or
  `pending-replay-skipped` (`read-failed` / `first-gate`) line; when the
  read fails OR the first gate is red no writer is built at all, so an
  unreadable or un-replayed ledger is preserved for the next boot instead of
  being clobbered by an empty one. `applyV2` and `offDisposed` both sync
  change-only (disposal clears a pending outside the applyV2 path).

Rule two — closed-error sweep expansion:

- `classifySweepRow`: a checkpoint-closed row whose `lastTurnOutcome`
  projection reads `kind === 'error'` re-enters the candidate face (the
  projection survives `trimHeavyProjections`, so zero extra IO); every other
  closer and a missing projection stay `closed`.
- `scanOpenTurn` folds `lastError` (code/message), stamped only when the
  log's LAST `turn/end` is an error — a later non-error closer clears it, so
  the raw tail always wins.
- `runBootSweep`'s closed branch decides only when `lastError` is present
  AND the optional `reviveClass` dep is bound AND it answers true;
  anything else stays `confirmedClosed` (an unbound classifier fails closed).
  The row then rides the existing attached-check → seedRoute → `decide`
  chain and the zero-quota `onBootSweep` channel — the summary detail key
  set is unchanged (it is `toEqual`-asserted).
- `RevivalPolicy.revivable(code)` is the one effective classification as a
  read-only query: sticky eviction vetoes first, then `classOf` (admission
  over the ruled/config lists). It never feeds the learner and never counts
  quota. The shell binds `refineFailureCode(code, message)` first, so the
  sweep confirm and the live `turn/end` path can never classify a code
  differently.

## Alternatives considered

- **Read `session-revive-v2-state.json` back as the replay source.** It is a
  one-way bilateral export contract (field set must not widen; the inbox单
  consumes it), and its field set is not the `releaseDue` input set (no
  plannedAt, no channel). Design §4.2 rule one names this exact move a
  打回 example; rejected.
- **Persist the whole machine state** (strikes, stopped, relay, wave and
  breaker counters). 拍板⑪ restart-zero-quota and §4.2 条1 already rule
  those restart-cleared; persisting them would resurrect quota stamps across
  the boundary the ruling draws. Persistence surface stays the releaseDue
  inputs only.
- **Re-decide on replay** (feed the error to `policy.onError` again). That
  would re-run admission and double-count quota; the replay must EXECUTE the
  decision the dead process already made (restart-zero-quota). Rejected.
- **Let the projection screen decide directly** (no raw confirm). The
  checkpoint lags the log by the write-behind window, so a stale projection
  could revive a session whose raw tail is not an error; the raw read stays
  authoritative and the projection only widens the candidate face.
- **Make `reviveClass` required on `BootSweepDeps`.** It would force every
  existing binding and test to change at once; optional-with-fail-closed
  keeps older bindings compiling while never deciding an unclassified tail.

## Consequences

- A deferred decision survives a Host restart: restore → probe → release
  opens EXACTLY ONE attempt. The two re-admission paths (pending replay and
  the rule-two sweep) meet in the single pending slot plus the
  attempt-in-flight guard, so they compose without double-nudging — the
  fixture pins the count.
- Error-closed sessions re-enter the boot sweep; closed non-error turns,
  wall-class and evicted codes stay `confirmedClosed`, and a screen-closed
  row is never even read (the documented write-behind residual is
  unchanged: the lag can only miss, never wrongly revive).
- The quota boundary is written into the design: replay and closed-error
  recheck ride the restart-triggered zero-quota face; the non-restart
  event-driven error line still counts 4h×4 unchanged.
- A corrupt pending ledger degrades to a loud `pending-replay-skipped` line
  on every boot (a human fixes the file) — never silent data loss and never
  a clobber of unread state (宁漏不误复活).
- README: the security-model bullet previously claimed no files written and
  no outbound network — stale since the v2 probe gate — now names the local
  ledgers under `<dsh-home>` and the route probes; the in-memory-state
  limitation notes pending as the one persisted exception; both languages
  re-paired (`verify-docs.mjs --write`).
- The built `lib/index.js` keeps its hardlink to the installed profile
  copy; the running Host picks the change up only on restart (repo rule:
  agents do not restart the service).

## Testing

Package gates green: `pnpm typecheck` (main + test configs), `pnpm vitest
run` 16 files / 231 tests (new: `pending-state.spec` 13 — reader fail-closed
matrix, change-only/seeded/retry/over-bound writer, full-loop round trip;
`restart-replay.spec` 2-state fixture; +8 rule-two cases in `sweep.spec`;
+9 pending/replay cases in `v2-machine.spec`), `pnpm build`.

The acceptance fixture's 正态 builds the incident shape — error-closed
session + pending defer — simulates the reload (fresh machine, one ledger
read, idempotent restore), runs the boot sweep over the closed-error row,
then goes probe-green: exactly one `v2-attempt` with the
detect → decision → attempt chain present across the reload. 反态: a
closed `completed` turn produces zero reads and zero decides.
