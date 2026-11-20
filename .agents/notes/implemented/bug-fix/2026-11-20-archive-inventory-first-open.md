# Agent Note: Archive panel first open — prewarm, honest loading state, real refresh

Status: implemented

## Problem

After a DSH restart, the first open of the Session Archive Manager (已归档会话列表) blocked for many seconds on an empty list, and the Refresh button often changed nothing:

1. The whole-response inventory cache (`inventory-response-cache.ts`) starts cold at boot, so the first panel open paid the full 11–35 s rebuild inline — and the list area rendered "no sessions" (`arch.empty`) the whole time, because the loading status never distinguished "still loading" from "loaded and empty".
2. Refresh was a plain `GET /inventory`. Inside the 15-minute TTL the server answered the byte-identical retained payload (`x-dsh-inventory-cache: hit`), and outside it stale-while-revalidate still serves the retained bytes first. On top of that, the per-session projcache file memo (`projcacheFiles`) has no TTL of its own — a title landing on disk after a pass stayed invisible until the next mutation cleared the memo. A plain refresh could therefore never pick up a late-landed title.

Untitled blank sessions with no live projcache file (236 rows, 230 of them under backup archives) are data truth, not this bug: a refresh cannot invent a title. Scope ruling (user, 2026-11-20): code fixes only; the backup title files stay untouched.

## Decision

Three coordinated changes in `@linxin666/dsh-session-archive`:

1. **Boot prewarm.** `ArchiveService.start()` arms a background attempt (`PREWARM_DELAY_MS` = 5 s so the boot catch-up tick gets the event loop first, then `PREWARM_RETRY_MS` = 1 s retries while the `sessionController` feed face is not answering, capped at `PREWARM_MAX_ATTEMPTS` = 30) that calls the new `InventoryResponseCache.prewarm()` — a no-op when a snapshot exists or a build is already in flight, otherwise `kick()` with no reader waiting. The readiness gate exists because a full-corpus build taken without the feed caches a disk-only snapshot (every row flagged `unreadable`) for a whole TTL window — worse than no prewarm at all. `stop()` clears the timer.
2. **Honest loading state.** The card's empty branch renders `arch.loading` while `status === 'loading'` and `arch.empty` only otherwise; rows already on screen stay visible through a refresh because `setStatus` retains the inventory.
3. **Real refresh.** `GET /inventory?fresh=1` (parsed the way `seal-check` parses `recheck`) routes to the new `ArchiveService.inventoryFresh()`: it clears the untitled `projcacheFiles` memo plus the two 2 s index memos and awaits `InventoryResponseCache.rebuild()` — `invalidate()` (drop the generation, abort any in-flight build), then `kick()` and wait for THAT build. The caller pays the rebuild; every other reader arriving meanwhile still gets the retained bytes instantly, so the taskbot's 10 s poll never queues behind a click. The client's Refresh button calls `controller.load({ fresh: true })` → `api.inventory({ fresh: true })` with a 45 s timeout (the route answers by the build's own 30 s abort, so the client must outlast it to see the server's error); the initial mount load and the post-batch reloads stay plain.

## Testing

- `inventory-response-cache.spec.ts`: prewarm lands a background build with no reader and the first read is a hit over it; prewarm is a no-op over an existing snapshot and coalesces with an in-flight build instead of starting a competing one; `rebuild()` returns the new bytes (never the retained body) and the window follows, concurrent reads keep the retained bytes while it waits, and an invalidation abort mid-refresh retries under the new generation with the aborted attempt uncounted. Service-level: start issues one build before any reader asked (fake timers), the feed-face gate defers the build until the face answers, and a late-landed title appears only through `inventoryFresh()`, never through a plain read.
- `routes.spec.ts`: `?fresh=1` serves a rebuilt document containing the landed title (header `miss`), the plain read before it keeps the window (`hit`, title still absent), and the next plain read hits the rebuilt bytes.
- `controller.spec.ts`: a fresh load keeps the old rows on screen while it waits, passes `{ fresh: true }` to the api, and swaps in the rebuilt payload when it lands.
- `card-loading.spec.tsx` (new, jsdom): first load in flight shows `arch.loading`, not `arch.empty`; a landed load with zero rows shows `arch.empty`; the refresh button requests `{ fresh: true }` and shows `arch.refreshing`; rows never blank while a refresh waits.
- Package gates: `pnpm --filter @linxin666/dsh-session-archive test` green (332 tests); `tsdown` rebuild lands in the profile's hardlinked `lib/` (sha256 repo == profile for `index.js` and `client.js`).

## Alternatives considered

- **Restore the 230 backup title files** so the untitled rows gain titles. Rejected by the scope ruling (2026-11-20): those sessions carry no title in live storage, refreshing cannot invent one, and rewriting backup archives to change a list's cosmetics corrupts the historical record the backups exist to preserve.
- **Drop the response cache so every read rebuilds.** Rejected: one rebuild costs 11–35 s and the taskbot polls every 10 minutes behind a 10 s timeout — removing the cache turns each poll into a fail-closed round, exactly the failure the cache was built to prevent.
- **Clear `projcacheFiles` on every GET, or give it a short TTL.** Rejected: every pass would re-read every per-session projcache file — the dominant cost the memo exists to skip — for a staleness window only a human clicking refresh cares about. The memo stays mutation-cleared and is additionally cleared by `inventoryFresh()`.
- **Invalidate-and-serve-stale for the click instead of `rebuild()`.** Rejected: it would answer the click with the very bytes the user is asking to bypass — the observed "refresh does nothing". The fresh reader must await the new build while everyone else keeps the window.
- **Prewarm unconditionally at start() with no readiness gate.** Rejected: a build taken before the feed face mounts caches a disk-only snapshot for a whole TTL window; retrying until the face answers costs one timer and removes that failure mode.
- **Also make the post-batch auto reload fresh.** Deferred: it would end every batch with an inline 10–35 s rebuild. The refresh button now deterministically recovers the list, and the batch dialog already reports each operation's outcome; the plain post-batch read keeps serving the invalidated window's bytes until the background rebuild lands, as before.

## Consequences

- The first panel open after a restart is a hit whenever the prewarm lands before the click; a click that beats it coalesces with the prewarm's build instead of starting a second one.
- A refresh click is the one read that deliberately pays the rebuild (up to the route's 30 s abort, surfaced as an error with retry); concurrent taskbot polls keep sub-millisecond reads.
- Late-landed titles become visible on refresh instead of at the next mutation; genuinely title-less sessions still show as untitled, unchanged by design.
- The prewarm degrades explicitly: after 30 failed attempts (feed face never answers) it stops and the first open pays the rebuild inline, exactly as before.
- The `x-dsh-inventory-cache` vocabulary is unchanged — an explicit fresh rebuild reports `miss` with `age` 0, since that read paid for new bytes.
