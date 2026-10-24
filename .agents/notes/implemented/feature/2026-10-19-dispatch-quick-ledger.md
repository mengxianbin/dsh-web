# Agent Note: dsh-session-dispatch quick ledger (taskRef bindings + 409 dedupe + bindings endpoint)

Status: implemented

## Problem

Batch task dispatch creates one session per task, but nothing durable records which session is executing which task. The task boards (git) and the dsh runtime (workspace store) are two accounts synchronized only by human memory: an interrupted dispatcher forgets which tasks were dispatched, and a second dispatch of the same task silently forks the work. The obvious fix — writing `session-xxxx` back into the git board — fails under worktree isolation: many independent board sessions cannot see each other's git updates, so the board can never be the live-occupancy account. What is needed is a machine-local ledger of task-to-session bindings with a real-time aliveness view, plus a gate that refuses to double-dispatch a task whose session is still alive.

## Decision

- **`POST /api/session-dispatch` accepts an optional `taskRef`** (opaque string, recommended shape `<board path>#<item anchor>`, at most 2000 characters). A dispatch carrying it records `{ taskRef, sessionId, workspaceId, title?, createdAt }` in `$DSH_HOME/dispatch-bindings.json` after the first prompt is queued. Dispatches without `taskRef` behave exactly as before (backward compatible).
- **409 dedupe gate**: before creating a session, a `taskRef` dispatch checks the ledger for a binding whose session is still alive; if found it answers `409 { ok, taskRef, sessionId }` naming the existing session. Aliveness reads `$DSH_HOME/storages/workspace.json` (a session is alive when its id is in some workspace's `sessionIds` and not in `global.archivedSessionIds`), so an archived session releases the gate without any ledger cleanup.
- **`GET /api/session-dispatch/bindings`** serves the whole ledger with a real-time `alive` boolean per entry. Dead bindings are kept, never deleted: the ledger records what happened, and the caller decides what a dead binding means.
- **The ledger is fail-open everywhere**: an unreadable workspace store releases the 409 gate instead of wedging dispatch; a corrupt ledger file is quarantined to `<path>.corrupt-<epoch>` (the trace) and rebuilt empty; a failed binding write answers `200` with `bindingRecorded: false` rather than turning a successful dispatch into an error. Every write goes through unique temp file + fsync + rename, mirroring the dsh-session-archive ledger.
- **The ledger is an occupancy sensor, not an account of record.** It lives on local disk, never in the repository; the git board stays the only task authority. This boundary is stated verbatim in the m-note `dsh-session-dispatch` skill next to the 2026-10-18 policy block.

## Alternatives considered

- Writing `[/] 🔗 session-xxxx` back into the git task board as the binding account: rejected — worktree-isolated board sessions cannot see each other's commits, so the board would show stale occupancy exactly when concurrency matters (this was the original charter idea, overturned in design v3). The board may still carry such annotations as a human convenience, but the machine gate cannot depend on them.
- Storing bindings in the workspace store (alongside `sessionIds`): rejected — that store is Host-owned schema; extending it couples this plugin to its internal shape and risks the session-persistence machinery. The ledger is plugin-local with a structural read of the workspace store.
- Deleting bindings when sessions are archived (event-driven cleanup): rejected — the archive plugin runs in a separate process and the Host may be killed at any time; deletion-on-event would leak live bindings on missed events. Aliveness is therefore computed at read time from the authoritative store, making the ledger self-healing.
- Returning 500 when the binding write fails: rejected — the session is already created and prompting; a disk hiccup on the ledger must not make the caller believe the dispatch failed and retry into a duplicate session.

## Consequences

- The 409 body doubles as the reclaim handle: a dispatcher that wants to re-dispatch anyway can read the existing `sessionId` and archive or steer it first.
- Bindings accumulate forever (one row per dispatched taskRef); the file is rewritten whole per record. At batch-dispatch scale (tens to hundreds of rows) this is negligible; if it ever grows unbounded, a cap or compaction pass belongs in `FileBindingStore`.
- The alive computation couples the ledger's freshness to the workspace store's on-disk state; the Host updates that store on archive, so the propagation delay is one read.

## Testing

`tests/routes.spec.ts` covers the route contracts (taskRef validation, binding record shape, 409 with existing sessionId, re-dispatch after death, backward compatibility without taskRef, fail-open gate and write failure). `tests/bindings.spec.ts` covers the store against real temp directories (durable record, alive/dead/archive semantics, newest-live-wins, corrupt-ledger quarantine with trace, fail-open on unreadable workspace store, atomic write hygiene). 46 tests, plus `pnpm typecheck`, `pnpm build`, `pnpm sync-shared:check`, and `pnpm docs:check` all green.
