# Agent Note: Task-board board reads hand out an isolated task array

Status: implemented

## Problem

`HostTaskLedger.state()` answers every board read, and it rebuilt the entire ledger to do it: the task list came back through `JSON.parse(JSON.stringify(tasks))`, and the HTTP handler then serialized that copy a second time. The read is not rare. `state()` serves `TaskBoardHostService.snapshot()` behind `GET /api/task-board/state` and behind every action response (`applyRequest`'s `{ state }` returns), so one board interaction pays the copy several times. Measured on the review window, one read cost 0.43 ms for 400 cards carrying 2 executions each (a 365,346-byte response) and 2.72 ms for 400 cards carrying 20 executions each (1,830,946 bytes) — the retained-history ceiling, since `EXECUTION_HISTORY_LIMIT` trims a card's history to 20. Nothing on the path is memoized, so a repeated read costs the same as the first.

The copy was there to enforce one contract: a consumer that receives a board read must not be able to rewrite the ledger through it.

## Decision

`HostTaskLedger.state()` hands out `tasksForRead(this.document.tasks)`, and `tasksForRead` is one level of copying — `[...tasks]`. The isolation boundary is the array itself: a consumer can splice, sort, push into, or empty the collection it received without reaching the document.

That boundary is the whole contract, because the records the array carries are stable values. Every write in `HostTaskLedger` replaces the document's array (`this.document.tasks = ...`, 30 assignment sites) and replaces the records it changes instead of mutating them; the class holds no `document.tasks[i].field = ...`, no `document.tasks.push/splice/sort(`, and no `executions.push/splice(`. Copying the records as well therefore rebuilt the whole document on every read and bought no property a consumer relies on.

The call sites were checked one by one before choosing that boundary: six `state()` call sites (`host-ledger.ts` 689, 945 and 1177 for the action results, `host-service.ts` 311 for `snapshot()`, 425 for a `find`, and 438-440 for the action snapshot) and seven downstream consumers of the snapshots they build (`host-routes.ts:192`, which only serializes, and `agent-tools.ts` 321, 402, 438, 485, 537 and 576, which map, filter and search). None of them writes to the array or to a record. `summary()`, which feeds the SSE frames, never copied in the first place and is untouched.

## Measured

One board read through the same synthetic ledger, before and after, three passes each, in fresh processes:

| Shape | Before | After |
| --- | --- | --- |
| 400 cards × 2 executions (365,346 B) | 0.43 ms | about 0.2 ms |
| 400 cards × 20 executions (1,830,946 B) | 2.72 ms | about 1.1 ms |

A separate smoke window on the review worktree reproduced the same shape (ordinary 1.303 / 0.703 / 0.959 ms before against 0.622 / 0.253 / 0.213 ms after; tail 5.884 / 4.597 / 4.352 ms against 1.724 / 1.331 / 1.135 ms) and matched the numbers an identity-return control had produced, which is what shows the copy is gone rather than merely cheaper. The deep copy was a transient allocation, not a retention: forced-GC heap after a read is 1,420,824 bytes before against 1,203,744 after on the ordinary shape, and equal on the tail shape.

## Alternatives considered

- **Return the ledger's own array.** Rejected: it removes the isolation boundary entirely. The guard below fails on it — both halves, because two reads then return the same array.
- **`structuredClone(tasks)`.** Rejected: same order of cost as the JSON round trip it replaces, so the read stays as expensive as before.
- **Shallow copy plus `Object.freeze` on every record.** Rejected: freezing would have to cover every object the write path produces, including `repairParentLinks` and `retainRecentExecutions` rebuilds, which is a behavioral change to the write path that the package-local validation of this change cannot cover. It defends against a record-level mutation no consumer performs.
- **Copy only at the HTTP boundary.** Rejected: `state()` has in-process consumers beyond the route — the agent tools reach the snapshot six times and `applyBoardAction` reads a card from it — so moving the copy into the handler would leave those aliases pointing at the document.
- **Narrow the types to `readonly TaskRecord[]` instead of copying.** Not adopted in this change. It is the right way to make record-level mutation impossible at compile time, but `LedgerState.tasks` flows into `TaskBoardSnapshot.tasks` (`protocol.ts`), so the narrowing ripples out of this module.
- **Change `summary()` or the SSE frames.** Rejected: they never copied, so there is nothing to remove, and the frames' behavior is part of what must not move.

## Consequences

A board read hands out a fresh array whose records are the ledger's own. The response body is byte-identical to the previous implementation for both shapes except for `scheduler.lastTickAt`, the mount-time heartbeat every process writes into its own scheduler snapshot, which is not part of the task payload.

The residual boundary is recorded rather than defended: a consumer that mutates a record in place (`state.tasks[0].title = 'x'`) still reaches the ledger. No consumer in this package does it, and the upgrade path when one needs to be impossible is narrowing `LedgerState.tasks` and `TaskBoardSnapshot.tasks` to `readonly TaskRecord[]`, which stays out of this module.

The read path stays uncached: repeated reads still pay the serialization the handler performs. The copy that is gone was the one repeated per read.

## Testing

Two deterministic guards live in `tests/host-ledger.spec.ts` and use no timer or time budget. The first empties and pushes into the array a read returned and asserts that the next read still reports the ledger's own card. The second reads twice and asserts that the two arrays are different objects while the card inside them is the same object — a fresh container per read, and no document rebuild.

Three negative controls pin what the guards can fail on. Against the deep-copy implementation, the record-identity guard fails (`expect(second[0]).toBe(first[0])`) while the isolation guard passes, because a deep copy isolates more than required — that is the cost this change removes. Against an identity return (`return tasks`), both guards fail. Against the shipped `[...tasks]`, both pass.

`pnpm --filter @linxin666/dsh-client-ui-task-board test` passes 955 of 956 (one skipped), and the package's typecheck and build pass. The byte equivalence was taken from a rebuild of the changed source, and that bundle's digest matches the committed artifact of the review branch.

The closest existing records are [Task-board roster polling stands down on an idle board](../bug-fix/2026-10-06-task-board-idle-roster-poll.md), which owns the host-side polling cost gate, and [Task-board client render and lineage-gate costs](../bug-fix/2026-09-28-task-board-client-render-and-lineage-costs.md), which owns the browser half's render costs. Neither owns the ledger's read contract: the first decides when the roster is read at all, the second decides what the browser re-derives, and this note decides what a read hands to its caller. It is a new record rather than an edit to either.
