# Agent Note: Subagent-orchestration cost survey and the unbounded cascade fan-out

Status: implemented

## Problem

Using subagents was believed to drive CPU and memory up, and the obvious culprits had already been measured. The earlier gradient measurement ([multi-agent GUI lag, 2026-08-23](../../../../docs/archive/perf-measurement-multi-agent-gui-lag-20260823.md)) priced the load subagents *produce* — worktree installs, vitest, tsc — and found memory pressure and swap thrash, not plugin code. What nobody had priced was the opposite side: the cost of *orchestrating and observing* many subagent sessions, which grows with the number of sessions rather than with the work inside them. That is the cost a teammate-heavy workflow pays even when every teammate is idle.

## Decision

The session-history rescan in `HostExecutionRunner.inspect` is the one measured fan-out cost in this repository, and it is fixed in the note that owns that memo: [history-head probe memo](2026-08-26-inspect-head-probe-memo.md).

Everything else measured is left unchanged, each for a reason recorded below. The one gap this survey left open — the unpaced fan-out of a run group — is closed in its own record: [run launch admission](2026-10-16-task-board-run-launch-admission.md) bounds how many sessions one action asks DSH to create at once, without changing what a run group opens.

## Measurements

**Cascade fan-out is unbounded.** Driving the real entry point (`TaskBoardHostService.apply({ kind: 'run' })`) against a counting gateway gives a deterministic count, not a timing:

| subtasks | `session/create` calls | peak concurrent creates |
| --- | --- | --- |
| 3 | 4 | 4 |
| 40 | 41 | 41 |

The chain is `core/subtask.ts:190-198` (`cascadeTargets` bounds depth, never width) → `host-ledger.ts:1291-1302` (one execution per member in a single commit) → `host-service.ts:1031-1039` (`dispatchRuns` launches in a loop with no `await`) → `:1051-1055` (`scheduleLaunch` is `void this.launch(...)`, fire and forget). No backstop exists anywhere in the package, and the runtime exposes none either: `@deepseek-ai/dsh-subagent` declares recursion depth (`maxDepth`) but no fan-out width, and the host settings schema has no subagents key at all. The only bound is the written discipline in [multi-agent resources](../../../../docs/multi-agent-resources.md).

**The per-tick ledger scans are quadratic but priced far below the threshold.** `host-ledger.ts:1365-1387` calls `settleCascade` once per task per tick, and `settleCascade` is itself O(tasks), giving O(G·M²·E); measured `finalizeReadyRuns` 0.196 ms at 416 cards and 1.763 ms at 1216 (M ×2.92, time ×9.0). `reconcileExecutions` (`host-service.ts:770`) adds one linear `getTask` find per open execution. At 1216 cards the whole tick is 1.956 ms, about 0.035% of one core at the 5-second cadence.

**git-graph is independent of worktree count.** `runPoll` iterates SSE subscribers, never a repository list: 5 spawns and 7 stats per 30-second round per subscriber, identical at K=1, 8 and 32 worktrees, touching only the subscribed repository. The sensitivity control matters more than the flat curve — injecting a per-repo sweep into the same harness moves the same measurement to 13 and 37 spawns at K=8 and 32, so the negative is real rather than a blind instrument.

**The session-layer packages have no periodic path.** With both auto-policies at their defaults the janitor tick performs zero traversals and zero readdir/stat/readFile; enabling them produces exactly one scan per tick. `dsh-usage`'s bucket key is day → provider → model with no session dimension, and `sessionRoutes` is a `WeakMap`. The only grow-only structure keyed by session is a 98 KB / 1211-entry map.

**The client is bounded by rendered rows, not by session count.** The aggregate shim's per-flush frame sweep costs 0.59 ms at zero rendered sidebar rows and 1.00 ms at 832, bounded at one flush per frame (≤60/s) — roughly 6% of one core at the worst case measured, which is why the [combined plugin mutation cost](2026-09-11-combined-plugin-mutation-cost.md) rejection stands with its pricing refreshed. The official session-list store is a different matter and is not ours: a committed session event drives `handleControlFrame` → `notifier.markDirty()`, every `markDirty` rebuilds the whole snapshot (O(N) over summaries and projection stores), and the path lands on `projectionStore(sessionId)` without requiring that session to be retained or rendered. So N background teammates invalidate the table at step granularity each turn. The repository-side multiplier is a satellite: `dsh-pet` subscribes to the list and issues one HTTP RPC per invalidation. Read from the installed 0.2.0-rc.2 package rather than measured: that projection allocates a fresh row object for every session on each invalidation and `set()` notifies unconditionally, so what grows is allocation churn, not retained memory. Each session also holds a resident projection store for the client root's lifetime, which puts client memory at roughly the session-directory count — under 1 MB at 832 sessions — and not on the concurrent-subagent count.

## Alternatives considered

**Capping cascade fan-out at the launcher inside this survey.** Deferred here as a product decision rather than a defect fix: the shape (reject, queue, or serialize behind a configurable width) changes the observable promise that a run group opens its whole subtree, so it needed the user's answer rather than an agent's. It was then settled as a batched queue and implemented in [run launch admission](2026-10-16-task-board-run-launch-admission.md); the reject shape stayed rejected for the reason given above.

**Adding a `maxConcurrent` subagent setting.** Rejected: the repository does not own the subagent registry, which lives in the host, and inventing a local throttle would leave the documented discipline and the real mechanism disagreeing.

**Extending the memo to goal runs.** A goal execution re-walks its history every poll (measured 12 pages per tick) because finding the `turn/end` deletes the memo while `goalVerdict` returns pending for an active goal. Rejected for now: it needs a second kind of memory on a settled session and changes which material a verdict is derived from, and goal runs are off by default at both the global setting and the card.

**Fixing the quadratic settle in the same pass.** Rejected on proportion: 1.76 ms at 1216 cards does not outrank the risk of editing cascade settlement, which several constraints require to stay conservative.

**Bounding the shim sweep by scoping it to added subtrees.** Rejected on the same evidence as the original rejection: the cost tracks frame size, not the `:not([data-dsh-part])` filter, and a sidebar-scoped sweep recovers only about 0.03 ms of 1.0 ms.

## Consequences

The inspect fix removes the one fan-out cost that actually grew with teammate count. Everything else that grows with sessions is either negligible at measured scale or outside this repository. The task board still opens a whole subtree for one card, but it no longer asks DSH for every session in the same tick: [run launch admission](2026-10-16-task-board-run-launch-admission.md) paces that burst, so the counted reproduction now guards a fix rather than describing an open hazard. The quadratic settle has a named return condition too: at the measured slope, card counts in the low thousands put it around 30 ms per tick.

## Testing

`pnpm --filter @linxin666/dsh-client-ui-task-board typecheck` and `test` (1101 pass, 1 skip) over the fixed runner, plus the focused regressions recorded in the owning note. The probes were process-local and are deleted; the client harness lived outside the repository and is not committed.
