# Agent Note: dsh-session-dispatch 409 gate and ledger append serialized in-process

Status: implemented

## Problem

The [quick ledger](../feature/2026-10-19-dispatch-quick-ledger.md) 409 gate is check-then-act with no serialization: `POST /api/session-dispatch` awaits `findAlive(taskRef)`, then creates the session, then records the binding, so two concurrent dispatches of one taskRef can both observe "no live session" before either records and both pass the gate, double-dispatching the task. The ledger write has the same shape at the store level: `FileBindingStore.record` reads the document, pushes a row, and rewrites the file, so two appends racing in one process both read the old document and the later rename silently drops the earlier row. The ledger is machine-local and a sensor rather than an account (one Host process, board-sanctioned low concurrency), so the closure had to stay proportionate: in-process serialization, nothing more.

## Decision

- **The gate section runs through a per-taskRef in-process FIFO.** `makeDispatchRoute` wraps everything from `findAlive` through session create/prompt and the ledger append in one `proceed()` executed by `createGateQueue()` — one in-flight dispatch per taskRef. The loser's `findAlive` now observes the winner's binding and answers `409 { ok, taskRef, sessionId }` naming the winner's session. Dispatches without `taskRef` or without a composed store bypass the queue, and dispatches of different taskRefs never wait on each other.
- **Ledger appends run through their own in-process FIFO.** `FileBindingStore.record` chains read-modify-write cycles on `appendTail` (the private `append`), so racing appends keep every row in arrival order. Readers (`findAlive`, `list`) stay outside the queue: `writeJsonAtomic`'s rename means they see either the old or the new document, never a torn one.
- **Process-local scope, deliberately.** One Host process owns the routes and the store (mount-once, link install), so no file lock, external queue, or cross-process protocol is introduced. Both queues are rejection-safe: a failed section does not poison the chain, and an idle taskRef key is dropped again.

## Testing

`tests/routes.spec.ts` adds a concurrent same-taskRef case: two POSTs in flight answer exactly one `200` plus one `409` naming the winner's `sessionId`, with one session create and one recorded row (the create awaits a tick so the unserialized code would let both pass). `tests/bindings.spec.ts` adds racing appends: three concurrent `record` calls keep all three rows in order on disk. 46 tests in the package, package `pnpm typecheck` green.

## Alternatives considered

- A single global queue for every taskRef dispatch: rejected — batch dispatch fires different taskRefs in parallel and they never race each other on the gate, so serializing across taskRefs would add coupling for no correctness gain; the queue is keyed per taskRef, the exact race scope.
- A file lock (or any cross-process lock) on `dispatch-bindings.json`: rejected — over-design against a single-writer process and beyond the board ruling of in-process serialization; no hard evidence exists that a second process ever writes the ledger.
- Reserving the taskRef at gate time (recording a binding before the session exists): rejected — it changes what the ledger means (a dispatch failing after the reserve would gate re-dispatch on a binding that never became usable) when queueing closes the same window without touching ledger semantics.
- Locking `findAlive` alone: rejected — serializing only the check leaves the act outside the lock, so the TOCTOU window survives; the queue must span check through append.

## Consequences

- A concurrent duplicate now waits out the winner's session-create cycle before answering 409: added latency on the losing request only; sequential dispatch is unaffected.
- Serialization exists only inside one process; if a second process ever mounts this plugin against the same `$DSH_HOME`, the gate reopens and this note must be revisited.
- The queues are per route/store instance: production composes once, tests compose their own, so parallel test files never share a chain.
