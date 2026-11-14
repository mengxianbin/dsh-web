# Agent Note: Manual column switching on the task board

Status: implemented

## Problem

The board's five columns had two owners. `backlog` and `todo` belonged to the operator; `running`, `done` and `failed` belonged to the execution runner. `MANUAL_STATUSES` was `['backlog', 'todo']` and every guard and affordance that meant "the runner owns this card" was written as `status === 'running'`: the ledger's move/delete/archive/run refusals, the cascade participant filter, the set-parent lock, the drag source, the run button, the subtask detach lock, the card spinner.

That split assumed a card's state is produced by a Host-run session. Boards carry work that is not: a patent filed through an external agency, a paper submitted by a human, a review decided in a meeting, a test executed by hand. Such a card could be labelled "待办" or "已完成" but never "进行中" — the board only showed in-progress when the Host itself was running something, so an operator tracking outside work had to choose between an understated column and a false one.

The obvious relaxation is not enough on its own. If `running` becomes a plain column while the guards keep reading the column, a card parked there by hand becomes unrecoverable: `run` refuses it (it looks busy), `move` refuses it, `archive` and `delete` refuse it, and `settle` refuses it because there is no open execution to close. The lock had to move off the column text before the column could be free.

## Decision

A card may be moved by hand to any column but the one it already shows. What "the runner owns this card" means is an open execution record, never the column text.

### One predicate, three surfaces

- `MANUAL_STATUSES` is every status. `canMoveManually(from, to)` accepts any column that is not the current one, and `canMoveTask(task, to)` adds the two conditions that make a move legal at all: the card is on-board and holds no open execution. `canMoveTask` is the single owner of "may this card move", so the ledger, the detail view's status row and the board's drop handler cannot disagree.
- `hasOpenExecution(task)` moves from a private helper in `host-ledger.ts` to `core/tasks.ts`, where the client half can reach it too.
- The agent tool surface exposes `move-backlog`, `move-todo`, `move-running`, `move-done` and `move-failed`; all five map onto the same `move` protocol action, which already carried a `TaskStatus`, so the wire format is unchanged.

### The lock is the execution

Every guard that read `status === 'running'` now reads `hasOpenExecution`: the ledger's move, delete, archive/restore subtree check, run/rerun and cron-trigger gates, cascade participant selection and launch, the set-parent lock, and restart reconciliation. The client follows the same rule for the drag source, the card spinner, the run button, tag editing, the subtask detach lock, the subtask roll-up's "running" count and the link-subtask candidate list.

A card parked in the running column by hand therefore stays fully operable: it can be moved, archived, re-parented, deleted, edited, and run — a run opens a real execution and settles the column with a recorded outcome. A card with an open execution refuses all of those exactly as before, and `settle` remains the only way out of one the board can no longer observe.

Restart reconciliation drops its `status === 'running'` pre-filter: any open execution that still has no session id after a restart — or on import — is cancelled, fail closed, whatever column the card shows. A stored session-less execution therefore no longer survives import, and the "awaiting session" projection the runtime view serves is produced by a live launch.

### A declaration, not a recorded verdict

A manual move writes the column through `withStatus` and nothing else: no execution record, no schedule change, no touch of the execution history. `done`/`failed` declare that the work finished (or failed) outside a Host-run execution; `running` says the work is under way without a tracked session. The card's execution list keeps the two provenances distinguishable, the next settled run overwrites the column with the recorded outcome, and the durable format is unchanged (`schemaVersion` stays 4, no migration).

Issue #1826 adds a second, record-backed way to reach the same two columns, for the case where an agent OUTSIDE this Host (Codex, Claude Code) actually finished or failed the card with its own model. `task_board_manage(action: 'record-external-outcome', result, initiatedBy)` writes a real execution record — verdict, caller, optional summary — and derives the column from it, so the column and the run history can no longer disagree about what happened. A manual move stays available and stays a bare declaration: which one to use is the difference between "I assert this is done" and "this run finished this way". The alternative that was rejected below (just un-gating `move-done`/`move-failed`) is what produced that disagreement.

The guardrails are the point. A card with an unsettled execution REFUSES an external outcome, because while this Host is running the card it is the only authority on it and a stale outside report must not race the session it claims to have replaced; an archived card refuses it too. `running` and `cancelled` are not in the wire union at all: `running` is the only state a real DSH session may produce, and `cancelled` is this Host's own bookkeeping for a run it closed. Both are rejected by the parser, not merely discouraged. The new record carries `external: true` and never a `sessionId`, which is the single field separating outside work from a Host run; no Host-side path (launch, settle, cascade folding, restart recovery) ever writes it.

## Alternatives considered

**Keep the running column runner-owned and allow only the planning and verdict columns.** Rejected: it leaves work that is genuinely under way unrepresentable, which is exactly the case the change was asked for — an operator tracking work performed outside DSH could only pick a column that understates or overstates it.

**Allow `running` as a column while the guards keep reading the column.** Rejected: a hand-parked card would be unrecoverable (run, move, archive, delete and settle all refuse it, and there is no execution for settle to close). Freeing the column and moving the lock are one change, not two.

**Add a durable provenance field for a declared status.** Rejected: the ledger format is versioned, so the field would need load-time normalization and clearing on the next settled run, and every reader would have to learn it. The execution history already separates a declaration from a run.

Superseded in part by issue #1826, and the superseding part is narrow. The rejection was about a durable field ON THE DECLARATION; the field that now exists is on the EXECUTION RECORD, written only when there is a real outside verdict to record, never by a manual move, and never needing to be cleared (a later settled run appends its own record, exactly as a rerun always has). What was rejected was "make a declaration durable"; what shipped is "record an outside run like a run".

**Mark a hand-parked running card with its own flag or tone.** Rejected for now: the detail view already shows whether an execution exists, and a durable flag would have to be cleared by the settle path that overwrites the column — more state for no additional truth.

## Consequences

- Every column is switchable by hand, from the board (drag), the detail view (status buttons) and a conversation (`task_board_manage`), and the same three surfaces refuse a move together.
- The running column carries two meanings: work the Host is executing (an open execution, with a session and a spinner) and work declared under way by hand (no execution). The detail view's execution list is what separates them.
- Cards with an open execution are locked exactly as before, and the failure messages a client sees are unchanged.
- Import stops preserving a session-less open execution; such a row is cancelled at boot instead of lingering as an unobservable run.
- Content editing now freezes at the first execution record rather than at the `running` column, so a card parked in `running` by hand can still be corrected.
- Issue #1826 adds a recorded provenance to that column: a card can now be in `done` because a real execution settled it OR because an outside agent reported it, and the two are told apart by the record rather than by the column. The consequence for the running column is unchanged and still deliberate — it keeps exactly two meanings, because nothing outside this Host may put a card there.
- An external record's `startedAt` is the instant it was registered, not the instant the outside work began: the Host cannot know the latter, and inventing it would make the history say something untrue.

## Testing

`tests/tasks.spec.ts` pins both predicates (every column reachable, the current column and an executing/archived card refused), `tests/host-ledger.spec.ts` parks a card in `running` by hand and moves it back, records a manual `done` with an empty execution history, and drives the runtime projection from a live session-less launch after the import normalization changed, `tests/controller.spec.ts` runs a hand-parked card and still refuses a second launch while an execution is open, `tests/agent-tools.spec.ts` drives `move-done` and asserts `executionCount` stays 0, and `tests/board-view.spec.tsx` drops a card onto the Done and the Running columns while refusing to drag an executing one.

Issue #1826 adds: `tests/host-ledger.spec.ts` pins the recorded outcome itself (one execution carrying the verdict, the caller and no session, with the column derived from it), the failed variant, both refusals (an open execution and an archived card), and the backward-compatibility case — a ledger document whose execution rows predate the marker reads back unchanged with no fabricated `external`. `tests/protocol.spec.ts` pins the wire rules: a well-formed outcome survives parsing with its summary trimmed, while `running`, `cancelled`, an unnamed caller, an over-long caller, a missing verdict and an extra `sessionId` key are all rejected at the parser. `tests/agent-tools.spec.ts` drives the tool twice — once recording a real outcome the model reads back through `task_board_get`, once refused over a card this Host is running — and covers the two missing-field refusals. `tests/subtask-view.spec.tsx` pins the history row: an external record names its agent and carries no session link, a Host run still shows its initiating session, and the row is machine-readable through `data-external`.

The package typecheck, test suite and build pass, together with `pnpm docs:check` and `pnpm i18n:check` (the new history label is mirrored in the Russian dictionary).
