# Agent Note: The coverage ratchet measures each package's own code, not the shared copies mirrored into it

Status: implemented

Pairs with [the business test discipline gates](2026-09-16-business-test-discipline-gates.md), which owns the coverage ratchet this note scopes.

## Problem

The Nightly coverage-ratchet lane went red three nights running: runs 40079811095 (2026-10-24), 40179561594 (2026-10-25) and 40305250665 (2026-10-26), with `[coverage] not in the baseline (1)/(2); record with --write-baseline: dsh-message-edit, dsh-browser-view`.

`scripts/coverage-baseline.json` had been recorded on 2026-10-22 (commit 20c30c9c7) over the 20 packages that existed then. The two packages that landed afterwards were never recorded, and `scripts/coverage-gate.mjs` treats a measured package missing from the baseline as a failure.

Re-recording exposed the real shape: against the 2026-10-22 baseline the same measurement showed 28 metrics below their recorded value across 8 packages, the worst being dsh-usage functions -10.98, dsh-usage lines -7.63, dsh-market lines -6.85, dsh-web-settings lines -6.70, dsh-liangshen functions -4.83 and dsh-agents lines -3.99.

The mass was not hand-written package code. `scripts/sync-shared.mjs` mirrors `shared/client/settings` and `shared/host` into consumers byte identical, with a generated-file header (`PluginSettingsCard.tsx`, `RangeBubble.tsx`, `SegmentGroup.tsx`, `settings-form.ts`, `settings-card.module.css`, `mount-once.ts`, `http.ts`, `loopback.ts`, `dsh-home.ts`, `pair-access.ts`, `body-mutations.ts`, `telemetry.ts` and the rest of its `MANIFEST`), so the same source was measured once per consumer: one copy landing moved 28 metrics across 8 packages at once with no test change anywhere.

## Decision

A `MANIFEST`-generated copy is not the package's own code. `scripts/coverage-gate.mjs` exports `sharedCopyExcludes(packageName, entries = copyEntries())` and passes one `--coverage.exclude` per copy into that package's vitest run; the list is derived from `copyEntries()` in `scripts/sync-shared.mjs`, so the gate repeats no file name and no package list, and a copy added to the manifest is excluded from its consumer without touching the gate.

The rule is uniform: every manifest target inside `packages/<pkg>/` is excluded for that package whether or not its copy happens to be well covered, with no per-file or per-package exception.

The shared source keeps its behavioural evidence in `shared/tests`, which runs through the shared package's own vitest and is included in `pnpm test`.

## Mechanism

Repeated `--coverage.exclude` flags accumulate in vitest 4.1: instrumented files dropped 25 to 23 for the two excluded paths, and the single brace-glob form produced the identical result.

Paths are package relative because the gate runs vitest with the package as its working directory, and vitest matches an exclusion against the instrumented path with contains semantics. `--coverage.excludeAfterRemap=true` is unchanged.

## Numbers

Repository totals are lines 83.05% with the exclusion, against 79.25% without it. The baseline records what the CI runner measures, not this workstation: the first Nightly after the change (run 40449496263, 2026-10-27) measured nine metrics below a locally recorded baseline and six above it, with dsh-web-all alone 3.6 points lower on CI because that package's percentage depends on the bundle the lane rebuilds before instrumenting. `docs/development.md` already requires recording the CI side, so the recorded numbers come from that run.

Seven metrics in three packages remain below their 2026-10-22 values and are recorded as the new floor: dsh-remote-bridge lines 91.43 -> 90.6, statements 86.39 -> 85.22, functions 88.59 -> 87.21 and branches 82.31 -> 80.87; dsh-session-id lines 83.87 -> 82.75 and branches 78 -> 75; dsh-web-all lines 87.78 -> 86.37. The first two carried well-covered copies, so removing those files from the denominator lowers their percentage with no test change; dsh-web-all's floor follows the bundle its own lane rebuilds.

The two packages that had never been recorded are now in the baseline: dsh-browser-view (lines 79.92) and dsh-message-edit (lines 95.34).

One metric is recorded at the lower of its observed values, deliberately: dsh-session-archive functions = 59.25 rather than the freshly measured 60.55. That metric oscillates about 0.8 points between runs (59.25 recorded on 2026-10-22, 59.75 measured by CI on 2026-10-26, 60.0 and 60.55 measured locally during this change), which is wider than the gate's 0.5-point epsilon, and `docs/development.md` requires the baseline to hold on the CI side and the lower value to be recorded when the two sides disagree.

## Testing

`shared/tests` already carried `settings-form.spec.ts` and `mount-once.spec.ts` and now also carries `plugin-settings-card.spec.tsx` and `range-bubble.spec.tsx`, 21 tests in all.

The verification this change requires: `pnpm test:scripts`, `pnpm test:standards`, `pnpm typecheck`, `node scripts/coverage-gate.mjs` printing `[coverage] OK: no package regressed`, and the Nightly lane after the change is pushed.

## Alternatives considered

- **Recording the whole 22-package reset.** Rejected: it would have lowered 28 metrics across 8 packages whose drop measured copies, not their own code.
- **Writing a test suite per consumer copy.** Rejected: eight identical suites for one source, all of which would drift.
- **Excluding only the poorly covered copies.** Rejected: a per-file judgement that changes meaning whenever coverage moves.
- **Recording only the two missing packages and leaving the regressions red.** Rejected: the lane stays red until the same copies are dealt with.

## Consequences

- A copy's own regression can no longer be caught by its consumer's percentage; it is caught by `shared/tests` behaviour and by `pnpm test:scripts` running `sync-shared --check` for identity.
- `shared/tests` is not itself a ratchet bucket, so the shared sources have behavioural tests but no coverage floor, a named gap rather than an oversight.
- The six metrics above are a real, deliberate lowering of those two packages' floors, recorded here rather than silently absorbed.
