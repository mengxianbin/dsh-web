# Agent Note: dsh-session-revive raises the context watermark from 150k to 300k

Status: implemented

## Problem

The revival plugin parks any orphan at or above its context watermark, and the 150k line no longer has a reason to exist. It originally bought two things: overflow avoidance (a huge context would not be nudged into another expensive turn) and a natural companion to the ≥150k relay routing. Both are gone — overflow avoidance is now owned by the compaction threshold (thresholdRatio 0.3 of the 1M window compacts at 300k down to a ~100k floor), and the relay routing was cut on 2026-11-09 by the [relay line cut](../simplification/2026-11-09-relay-line-cut.md), which explicitly left this gate untouched at 150k. What remains is a gate that only blocks sessions the compactor can handle: every boot sweep since 2026-11-12 parks 8–11 orphans at `context-limit` out of 12–15 candidates, and across those sweeps all 74 parked samples sit between 150,959 and 299,772 tokens (median 273,581) — every single one below 300k, i.e. every single one wakeable. Parked sessions are not lost, but each one is a manual `continue` the automation was supposed to remove (user report: 「会话复活机制似乎没生效」/「150K 闸正在失去意义」).

## Decision

- **`CONTEXT_LIMIT_TOKENS` moves 150_000 → 300_000** (`src/config.ts`, now at :89), aligned with the compaction threshold. The gate keeps its semantics — at or above the line a session parks at zero account movement, below it the remaining gates decide as before — but the line now sits where the compactor takes over: sessions it can handle wake automatically, and the park only catches what is genuinely oversized (≥300k at the time; the value later moved to 1M on 2026-11-14 by the [watermark raise](2026-11-14-session-revive-watermark-1m.md), which supersedes it for this value alone).
- **This is the one §四 ruled parameter that moved.** The JSDoc on the constant records the ruling (2026-11-13, user choice "A") and why the original freeze clause no longer applies to this value; every other §四 number (4h × 4 quota, 10-minute breaker, wave window/cooldown, stagger floor) is untouched, and the watermark stays a non-configurable grep-assertable literal.
- **One constant, both check sites**: the boot sweep (`src/policy.ts:436`) and the error path (`src/policy.ts:690`) both read `CONTEXT_LIMIT_TOKENS`, so the single edit moves both — no behavior fork between restart-revival and error-revival.
- **Docs and tests follow the value**: the README pair and the `package.json` description said 300k (they say 1M since the [2026-11-14 raise](2026-11-14-session-revive-watermark-1m.md)), the README pairing hashes are re-recorded, and the watermark tests derive their boundaries from `CONTEXT_LIMIT_TOKENS` instead of hard-coded 160k/140k, so the next value move touches one line.
- **The m-note design doc carries the ruling**: `content/tech/ai/dsh/session-auto-revival-design-1102.md` §4.2 takes the matching 2026-11-13 re-judgment note in the same batch; this change is the dsh-web half of one ruling.

## Alternatives considered

- **Keep the 150k line**: rejected — both of its rationales are dead (compaction owns overflow, relay routing was cut), so the gate now exists only to queue wakeable sessions for manual continuation; 74/74 parked samples were below 300k, which is the empirical form of 「150K 闸正在失去意义」.
- **Delete the watermark gate entirely** (so every session the compactor can handle wakes, and ≥300k contexts are caught only by compaction itself): rejected by the ruling — keeping the gate at the compaction threshold preserves a zero-cost fail-safe for genuinely oversized contexts at the price of one constant, and it is the smaller change.
- **Make the watermark configurable**: rejected — §四 ruled parameters are fixed literals by design (the two code lists are the only configurable surface); a knob would turn a ruling into a preference and invite drift.

## Consequences

- Sessions between 150k and 300k now auto-revive on every revival path (boot sweep, error path, wall release) instead of parking; the parked set shrinks to ≥300k contexts only (none observed so far — max 299,772; the line itself later moved to 1M — see the [2026-11-14 raise](2026-11-14-session-revive-watermark-1m.md)).
- Takes effect only after the user restarts the dsh web host: the plugin `lib/` is rebuilt, but a running host keeps the old bundle until restart — restart is user-owned per repo rule, never AI-initiated.
- The remaining gates (quota, breaker, wave, stagger) and the zero-account park contract are unchanged; the status endpoint and log line shapes are unchanged, so no consumer breaks.
- Post-restart verification: the next boot sweep's parked count should drop from 8–11 toward 0, and any remaining park must show `contextTokens ≥ 300000` (the threshold is 1000000 since the [2026-11-14 raise](2026-11-14-session-revive-watermark-1m.md)).

## Testing

Package gates green in the construction worktree: `pnpm typecheck`, `pnpm test` (65 tests — the watermark cases now assert against `CONTEXT_LIMIT_TOKENS`: park at the line, revive one token below, shrink un-parks), `pnpm build`. Repo-level `docs:check` / `i18n:check` / `typecheck` / `test` show only pre-existing reds (dsh-auto-route README pairing, dsh-usage ru keys, dsh-liangshen `tsgo` missing, dsh-doctor timeouts under parallel load), each reproduced on a stash baseline without this change. No test touches a real session lifecycle, so the sandbox rule was never engaged.
