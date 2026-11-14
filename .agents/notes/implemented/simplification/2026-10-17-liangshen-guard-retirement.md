# Agent Note: Retire the LiangShen runtime degeneration circuit breaker

Status: implemented

Supersedes [the note that revived the breaker-triggered reasoning step-down](2026-09-20-liangshen-guard-triggered-reasoning-stepdown.md) and [the note that fixed its factory thresholds and step-down target](../bug-fix/2026-10-10-liangshen-guard-thresholds-and-stepdown.md). Both still describe the mechanism this note removes; neither is authority for current behavior. The persona reflection fuse those notes leaned on, and the reasoning-effort removal they constrained, are unchanged.

## Problem

The `liangshen` preset shipped a runtime degeneration circuit breaker — `presets/liangshen/guard.mjs`, a `guard` row in the preset composition, and five plugin settings keys. It folded the durable session event stream into stall, echo, and misuse verdicts, injected a `[Circuit Breaker]` message at the next pre-step, and, for a stall only, rode `agent/request` to step the reasoning effort one notch down. It answered DSH discussion #5976: on a very long context at max effort the model can emit turn after turn of zero-output self-urging reasoning, and the persona's reflection fuse cannot stop it, because in that state the fuse text itself has left the effective context.

The mechanism was never measured on this route. Its five keys were the largest tuning surface in a card whose other fields are two switches and one presentation choice, and in practice every field sat at inherit/adaptive, so the card mostly documented a subsystem rather than let an operator change it. The owner asked for that settings block to be deleted and chose full retirement over keeping an untunable breaker hidden behind fixed defaults. This is a product decision, not an overlap removal: the installed 0.2.1-rc.2 harness has no native degeneration breaker (no circuit-breaker, stall-detection, or effort-step-down surface in the shipped packages), so nothing official replaces it.

## Decision

The breaker is gone from the plugin, the preset, the settings schema, the client card, the locale catalogs, and the package documentation:

- `presets/liangshen/guard.mjs` and its `tests/guard.test.ts` are deleted, and `presets/liangshen/agent.cordis.yml` carries no `guard` row, so no session mounts the pre-step channel or the `agent/request` step-down.
- The schema declares four volatile fields — `enabled`, `announceToAgent`, `presentation`, `dispatcher` — and `ResolvedConfig`, `DEFAULT_CONFIG`, and `resolveConfig` carry the same four. `applyPresetOverrides` overlays only the `tool-catalog` presentation and the `minimal-prompt` dispatcher flag.
- The settings card, the zh/en dictionaries, and the centralized ru dictionary no longer carry the breaker keys, the sensitivity labels, or the adaptive placeholder.
- The misuse batching nudge was the breaker's third signal and had no settings of its own. It retires with the module; the persona's Parallel Inspection line still instructs the model to batch same-kind steps into one `run_code` program, so the static discipline remains without a runtime message.
- `docs/liangshen-known-issues.md` is removed with its last entry (the breaker's missing escalation ladder).
- A profile patch that still carries `guardEnabled` or any other retired key keeps loading: schemastery's object schema is non-strict and preserves unknown keys, and nothing reads them. They are ignored, not migrated or rejected, and the settings form no longer renders them.

The retired mechanism's retained rationale, so a future reader can judge a reintroduction on the same evidence:

- Why it existed: #5976 (V4.1-Flash degenerating under long context at max effort with no fuse), the official effort-cost curve (max costs roughly 1.6-1.8x the sweet spot's trajectory length), and the r/DeepSeek 1whgo3e field report (lowering the effort recovered a stuck loop).
- Thresholds resolved per request from the session's reasoning effort (8000 characters at max, 12000 at high, 20000 at low) and were then scaled by a sensitivity preset (conservative x1.5, balanced x1.0, aggressive x0.5). The one-step runaway ladder tripped on a single zero-output step above the floor; the slow-burn ladder required four consecutive output-free reasoning steps; the echo ladder required three identical-argument failures.
- The step-down ladder ended at `high` (`max -> high`, and `high` untouched), because the official curve places the 60-80 effort band at recovered accuracy and no evidence supported going below it. Only a stall stepped down; an echo injected the message alone.
- The echo message carried a retry-safety split (`effectState none` for provably read-only tools, `unknown` for everything else). Sessions on a route that persisted signed reasoning with empty text fell back to a step-count stall measure with one warning per agent.
- The misuse signal fired after four consecutive successful model-direct shell calls with no `run_code` in between (scaled 6/4/2 by sensitivity) and stayed silent on a wire with no `run_code`.

## Alternatives considered

**Keep the breaker, delete only its settings.** Rejected: the owner asked for the block to be deleted and chose retirement over an always-on breaker with fixed thresholds. A hidden, untunable breaker also cannot be switched off per deployment, which is the one control the previous schema offered.

**Keep the breaker and remove only the numeric overrides.** Rejected by the same decision: the owner's choice was full retirement, and a switch plus a sensitivity preset would still be a settings surface for a mechanism this change declares out of scope.

**Move the breaker to the harness request path as a plugin-independent feature.** Rejected: that is a new official capability, not a simplification here; the installed 0.2.1-rc.2 packages expose no such surface.

**Keep the retired keys as tombstones or reject them loudly.** Rejected: the keys are inert and invisible in the form, and a tombstone would preserve a settings surface for a mechanism that no longer exists. Non-strict validation already makes an old patch load.

**Alternatives carried forward from the superseded notes.** Not re-litigate: restoring a phase-based `reasoning-effort.mjs` and its card controls (rejected by the 2026-09-20 note and still rejected here); pinning the schema defaults to 8000/4/3 (rejected by the 2026-10-10 note, because it masked both the effort table and the sensitivity preset); encoding "adaptive" as a sentinel such as 0 or -1; letting `high` step down into the 60-80 band; dropping the step-down entirely while the breaker existed; warning on a redacted route instead of falling back to step counting; and counting every zero-output step toward the blind cap.

## Consequences

- A session on the preset no longer receives breaker messages, an effort step-down, or the batching nudge. The only defenses left against the #5976 shape are the persona reflection fuse and manual intervention — a deliberate, recorded gap rather than an oversight.
- The settings page for the namespace now shows four fields, and the namespace's schema is four volatile fields; the card's client mirror and the three locale catalogs match.
- Old profile patches keep the retired keys as inert data. Nothing warns about them; a later reintroduction must decide whether to read them.
- `packages/dsh-liangshen` has no known-issues tracker entry and no `docs/liangshen-known-issues.md`.
- The 2026-09-20 and 2026-10-10 notes remain in the active tree as the retired mechanism's history and are linked from here; they are not authority for current behavior.

## Testing

- `pnpm --filter @linxin666/dsh-liangshen test` passes 20 files / 360 tests, including the removal fences: `tests/preset-composition.test.ts` asserts the composition carries no `guard` row, `src/announce.test.ts` asserts a declared preset has no `guard` row, and `tests/settings-card.spec.tsx` asserts the card renders the four surviving fields and no breaker controls.
- `pnpm --filter @linxin666/dsh-liangshen typecheck` passes.
- Removed alongside the mechanism: the guard's own unit suite, its two settings-card cases, and the two overlay cases that pinned the guard keys; `src/index.test.ts` and `src/composition.test.ts` no longer carry guard fields.
- No live-session evidence: this change removes a preset row and settings keys, so it takes effect for sessions created after the plugin re-declares the preset; the running `dsh web` host was not restarted.
