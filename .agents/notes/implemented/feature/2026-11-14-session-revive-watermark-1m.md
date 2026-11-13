# Agent Note: dsh-session-revive raises the context watermark from 300k to 1M

Status: implemented

## Problem

The 2026-11-13 raise moved the watermark from 150k to 300k to sit on the compaction threshold, but 300k still parks sessions the compactor handles. The boot sweep on 2026-11-13 23:56 skipped `session-b7496aad` at `context-limit` with `contextTokens: 312397` while its surface was only ~194.6k; the session sat dead until a manual attach at 00:02, and once woken a single compaction dropped it to 76.5k surface / 116.5k pressure. The pressure metric (`inputTokens + cacheReadTokens`) routinely runs ~1.6x the surface, so any session doing real work drifts past 300k pressure long before its surface reaches the compaction line — the gate parks wakeable sessions and queues them for manual `continue`, which is the same failure the previous raise set out to remove (user ruling: 「把复活闸调到 1M 吧」).

## Decision

- **`CONTEXT_LIMIT_TOKENS` moves 300_000 → 1_000_000** (`src/config.ts:89`), the full context window. The gate keeps its semantics — at or above the line a session parks at zero account movement, below it the remaining gates decide as before — but at the window size the park only catches a context that genuinely cannot take another request, so every session the compactor can handle wakes automatically.
- **This is again the one §四 ruled parameter that moved.** The JSDoc on the constant records the ruling (2026-11-14) and the line's history (150k → 300k → 1M); every other §四 number (4h × 4 quota, 10-minute breaker, wave window/cooldown, stagger floor) is untouched, and the watermark stays a non-configurable grep-assertable literal.
- **One constant, both check sites**: the boot sweep (`src/policy.ts:436`) and the error path (`src/policy.ts:690`) both read `CONTEXT_LIMIT_TOKENS`, so the single edit moves both — no behavior fork between restart-revival and error-revival.
- **Docs and tests follow the value**: the README pair and the `package.json` description say 1M, the README pairing hashes are re-recorded, and the watermark tests keep deriving their boundaries from `CONTEXT_LIMIT_TOKENS`, so the next value move touches one line.
- **The m-note design doc carries the ruling**: `content/tech/ai/dsh/session-auto-revival-design-1102.md` §4.2 takes the matching 2026-11-14 re-judgment note in the same batch; this change is the dsh-web half of one ruling.

## Alternatives considered

- **Keep the 300k line**: rejected — the pressure/surface gap (~1.6x observed on the triggering session) means 300k pressure parks sessions whose surface is far below the compaction line; the 312,397-token skip is exactly the wakeable-orphan queue the 2026-11-13 raise was meant to empty.
- **Delete the watermark gate entirely**: rejected by the ruling — keeping the literal at the window edge preserves a zero-cost fail-safe for a genuinely full context at the price of one constant, and it is the smaller change.
- **Make the watermark configurable**: rejected — §四 ruled parameters are fixed literals by design (the two code lists are the only configurable surface); a knob would turn a ruling into a preference and invite drift.
- **Set the line to a value between 300k and 1M (e.g. the observed pressure band)**: rejected — every such value re-creates the same judgment call at a new number; the user ruling picks the window edge, which is the only value that needs no tuning as pressure/surface ratios shift.

## Consequences

- Sessions at or above 1M pressure park; in practice the park stops firing (compaction at 300k keeps sessions far below the window), so boot sweeps should stop producing `context-limit` skips altogether.
- Takes effect only after the user restarts the dsh web host: the plugin `lib/` is rebuilt, but a running host keeps the old bundle until restart — restart is user-owned per repo rule, never AI-initiated.
- The remaining gates (quota, breaker, wave, stagger) and the zero-account park contract are unchanged; the status endpoint and log line shapes are unchanged, so no consumer breaks.
- Post-restart verification: boot sweeps show zero `context-limit` skips, and any residual park must show `contextTokens ≥ 1000000`.

## Testing

Package gates: `pnpm typecheck`, `pnpm test` (65 passed — the watermark cases assert against `CONTEXT_LIMIT_TOKENS`: park at the line, revive one token below, shrink un-parks), `pnpm build`. Repo-level `docs:check` / `i18n:check` run for the README pair and note triplets touched here. No test touches a real session lifecycle, so the sandbox rule was never engaged.
