# Agent Note: analyzeSeal verdict memo on transcript mtime+size

Status: implemented

## Problem

Every `POST /seal-check` and every archive-gate decision re-derives a session's seal verdict from scratch: `analyzeSeal` does a full `readFileSync` of the zstd transcript, decompresses every frame, and `JSON.parse`s every line to find the `SAVE_STATUS` sentinel — zstd frames cannot be tail-read, so there is no cheap path. The 2026-11-10 access-log day count for seal-check was n=122, avg 3337 ms, max 13056 ms (407 s of daily duty), and an unchanged transcript was recomputed each time. One archive click fronts the same gate three times in a row (pre-check, gate, post-check/light refresh), so the same bytes were judged repeatedly within seconds.

## Decision

- **The memo lives inside `analyzeSeal` itself** (`packages/dsh-session-archive/src/host/seal.ts`). Contract C1 keeps one grouping implementation, and both channels — the `POST /seal-check` endpoint through `service.sealCheck` and the archive gate's direct call in `ArchiveService.archive` — call this function, so a memo here is shared by the whole endpoint face with no second cache to keep coherent.
- **Key = transcript absolute path + `mtimeMs` + `size`, stamped before the read.** An append (the only writer is the harness, outside this plugin) changes the stamp, so the next call misses and recomputes — invalidation needs no explicit hook, and the rule matches the seal-light per-session cache (转录 append 即作废重算).
- **Stamp-before-read ordering is part of the contract**: a stamp taken after the read could pair a post-append key with pre-append content and serve that stale verdict forever; a pre-append key with post-append content only ever forces the next call to recompute (the safe direction). The LEGACY cut reuses this same pre-read stamp, so a stat failure still reads as "strict modern rules" (conservative), exactly as before.
- **Read/decode failures are never memoized** — they are transient (lock, torn open) and must retry on the next call even while the stamp holds. Content-derived results (including the empty-transcript tiers) are memoized.
- **The endorsement recheck's git verdict rides the memo** for the stamp window — the same trade the seal-light design records. A git-state change without a transcript write keeps the previous reading, and the failure direction is conservative: an unendorsed DONE stays blocked until the next append, never a false green.
- **Bounded LRU, cap 4096** (above the ~1900 live sessions): insertion-order Map, a hit re-inserts, the oldest entry drops at the cap. On a hit the `id` is re-stamped onto the cached result so one file can never answer under another session's id. `clearSealMemo()` / `sealMemoStats()` export a full reset and hit/miss counters for tests.

## Alternatives considered

- **One-entry TTL memo (`TtlMemo`, the dir-index precedent)**: rejected. Seal traffic interleaves many sessions (a batch seal-check, the 100–150 s line-light sweep), so a single slot would thrash to zero reuse; and TTL-based invalidation would serve stale verdicts for the window, while the mtime+size key is exact and free (one `statSync`).
- **Content hash of the transcript**: rejected. Computing it requires reading and hashing the whole file — the exact I/O the memo exists to avoid; the stat stamp is the same freshness signal at ~zero cost.
- **Stamp after the read (stat first seen, simplest insertion)**: rejected as unsafe — see Decision; under a concurrent append it pins post-append keys to pre-append content and serves it until the next write.
- **Memo at the endpoint/service layer only**: rejected. The archive gate calls `analyzeSeal` directly, bypassing any endpoint-layer cache — two caches to keep coherent and the gate (the expensive three-times-per-click path) still cold, plus a second grouping face would strain contract C1.
- **Rely on the seal-light host-state cache instead (do nothing here)**: complementary, not a substitute. That work (harness side, `#seal-light-host-state-1109`, currently T2-halted) caches for the line-light/list plane; this memo covers the plugin-side residue it does not — the archive-gate POST's live calls — and both share the same append-invalidation rule, so its "cache-side relocation" path can reuse this memo.

## Consequences

- Warm calls cost one `readdirSync` (transcript selection) + one `statSync` + a Map lookup — the p95 ≤ 200 ms acceptance bound holds with wide margin; cold calls keep the previous full-derivation cost.
- Git-state changes (a push landing after an unbacked DONE) do not recompute until the next transcript append; the observable direction is extra blocking, never a missed red.
- The memo is per host process: a restart drops it (one cold call per transcript afterwards), and there is no cross-process coherence question because only the host evaluates seals.
- The seal line ships as a profile hot-fix (this branch builds, then `build + cp` into `~/.dsh/profiles/web/node_modules/@linxin666/dsh-session-archive/lib`); until that re-pack and a host restart happen, the running host keeps the uncached code — 收口 ≠ 生效.
- This branch (`local/seal-analyzeseal-cache-1110`) is based on `local/seal-backtick-miditem-1109` (the deployed lineage tip) and stays local: upstreaming the seal line into `dev` remains a T2 decision for the user.

## Testing

`tests/seal-memo.spec.ts` (4 cases): memo hit serves the unchanged verdict with one derivation; an appended zstd frame flips NEUTRAL → `sentinel-pending` and recomputes (negative test, misses 1 → 2); a hit re-stamps the requested id; 30 warm calls keep p95 ≤ 200 ms with hits=30. Package `typecheck` (tsgo both configs) and `vitest run` (226/226 across 22 files) pass; `oxlint` clean on the touched files; `test-standards --check` reports zero violations for the new file (the package's other files carry pre-existing baseline debt from the seal lineage, untouched here).
