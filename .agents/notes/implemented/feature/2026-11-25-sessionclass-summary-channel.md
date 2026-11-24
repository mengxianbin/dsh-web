# Agent Note: Session class on the list channel (sessionClass summary projection)

Status: implemented

## Problem

The hover card's session-type line (hover-sessionclass-1121) read `GET /api/session-dispatch/attention` through a page-lifetime lazy fetch singleton: the line appeared only after the first hover triggered the request, and one failed request settled the cache as absent for the whole page's lifetime, so the line could vanish permanently while the session id beside it — carried by `SessionSummary` — was there from the first paint. Every reload repeated the wait. The class itself was never in question: the attention ledger (see [triclass session identity](2026-10-29-sessionclass-triclass.md)) held all recorded classes and answered the endpoint in 3.6–28 ms (measured 2026-11-25, 818 classes, 45 817 B). The problem was the channel — a second, lazy, per-page fetch for a fact the list already ships.

## Decision

- **Fold the class into `SessionSummary` through a new `sessionClass` projection** (dispatch `src/host/class-projection.ts`): record type `plugin:session-dispatch/attention` carrying `{ class }`, unit state `SessionClass | null` (init `null`, last record wins, malformed payloads skipped, identity view), `wire.summary` default true so the value rides the list's projection column beside the session id.
- **Two writers, one source of truth (the ledger file)**: every ledger write fires the new `onClassSettled` seam — `syncById` resolves the id in the store and appends onto a live Session (`stateOf` dedupe; store miss is a no-op). Once per boot, after the startup pass settles and the projection unit is mounted, a backfill pass walks `classes()`: a live store hit syncs as above; a cold Session gets a zero-I/O skip when `cachedSnapshot` already carries the class, otherwise one write-open append (only when the record is missing from the log) plus `coldSnapshot` to refresh the checkpoint. The checkpoint refresh is mandatory: `staleCheckpointKeys` deliberately skips absent rows, so a new key never cues the controller's cold repair and a log-only backfill would leave every pre-existing Session blank forever. Per-Session fail-open, paced between sessions; mount-before-backfill ordering guarantees the refold sees the unit registered.
- **The archive hover line reads the list snapshot**: `SessionClassLine` takes the standard `useSessions` hook and selects `byId[sessionId].projectionValues.sessionClass`, narrowing to the triclass — no fetch, no effect, quiet absence unchanged. The row/list/hook types are restated structurally in the client file because this package compiles host and client in one tsc program where the ui-session / api-session-controller client `sessions` Context merges collide with the host `dsh-session` merge (the package comment documents the deliberate non-import; git-graph's `import type {}` trick needs split programs).
- **`GET /api/session-dispatch/attention` stays** as the diagnostic read face: only the client fetch layer retired — the archive identity table reads the ledger file, not the endpoint.

## Alternatives considered

- **Keep the fetch, prefetch it on list load** (option A): rejected — it keeps a second channel for a fact the list already transports, still settles absent forever on one bad response, and adds a round trip to every page load.
- **Keep the hover-time fetch and only cache harder** (option B): rejected with A — the structural gap (type not on the list channel) remains, which is the complaint itself.
- **Let the list's cold repair cue the checkpoint instead of backfilling**: rejected — `staleCheckpointKeys` skips absent rows by contract ("an absent key promises nothing"), so nothing ever cues it for a new key; the backfill owns that write-back.
- **Import the real `SessionListState` in the archive package**: rejected — its single host+client tsc program collides on the `sessions` Context merge; structural restatement carries the same runtime value with no import edge.

## Consequences

- The first boot after install does a full read + refold for every recorded Session (hundreds; seconds to a minute, asynchronous, paced, fail-open). Rows pulled mid-backfill pick the class up on the next list reconciliation; every later boot takes the zero-I/O fast path.
- Each pre-existing Session gains exactly one appended record — the fast path and the log scan keep later boots append-free, and the logged class is always the ledger's current value.
- The endpoint keeps serving (no regression for other readers); any failure degrades to "line absent", never to a banner or a retry loop.
- First-hover latency disappears: the line renders from the same snapshot the row already has, so type and id now arrive together.

## Testing

`packages/dsh-session-dispatch`: new `tests/class-projection.spec.ts` (18 cases: fold purity — init/last-wins/same-reference/malformed skip/wire schema — plus the backfill's fast-path skip, append + flush + refold ordering, checkpoint-only refresh, handle close on refold throw, missing services, live-store sync, non-triclass drop, and mount/dedupe/store-probe behavior) and `tests/attention.spec.ts` gains 5 `onClassSettled` cases (write-only firing, declare, pending retry, non-member silence, throwing seam) — 170/170. `packages/dsh-session-archive`: `tests/session-class-hover.spec.tsx` rewritten around the `useSessions` stub (registration kept, triclass render, absent record/row/hook, out-of-triclass) with `src/client/session-class.ts` deleted — 343/343. Both packages' `typecheck` pass; full five gates green at close (2026-11-25).
