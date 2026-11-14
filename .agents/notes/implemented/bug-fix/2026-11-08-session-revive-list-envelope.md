# Agent Note: dsh-session-revive boot sweep list binding unwraps the SessionListValue envelope

Status: implemented

## Problem

The [boot sweep](../feature/2026-11-08-session-revive-boot-sweep.md) shipped with its list binding declaring `sessionController.list()` as returning a bare row array, but the Host method returns `SessionListValue` — rows wrapped in `{ items }`. The binding reached the screen through an `as unknown as` structural cast, so TypeScript never compared the two shapes, and the unit tests injected `listRows` directly with bare arrays, so no test crossed the binding either. The first real activation after a Host restart (boot 11:01:42, failure line 11:02:04, both 2026-11-08) therefore died at the first `for...of` with `TypeError: rows is not iterable`, logged one `boot-sweep-failed` line at stage `sweep`, and screened zero sessions — fail-closed, so nothing was nudged and nothing was damaged, but restart revival was silently inert on the very restart it was built for.

## Decision

- **Declare the envelope where it is consumed.** `SweepListApi` in `src/sweep.ts` types `list()` as `Promise<{ items: readonly SweepRow[] }>` — the shape the Host actually returns — instead of promising a bare array that only the cast made compile.
- **One tested unwrap.** `makeListRows(controller)` owns both the ruled row-scope request (`includeArchived: false`, `trimHeavyProjections: true`) and the `.items` unwrap; `src/index.ts` binds `listRows: makeListRows(...)` and no longer declares its own list view. The binding seam is a pure function the tests exercise directly.
- **Regression tests at the binding, not around it.** Three cases in `tests/sweep.spec.ts`: the envelope unwraps to rows, the request carries the two ruled flags, and `runBootSweep` driven through `makeListRows` with an envelope-shaped controller screens and decides with zero `boot-sweep-failed` lines.

## Testing

Package `pnpm typecheck` green, `pnpm test` 65 passed (62 existing + 3 new), `pnpm build` green (`lib/index.js` regenerated 2026-11-08). The end-to-end case reproduces the production failure shape: a controller returning `{ items: [...] }` must reach `decide` without a failure line; under the pre-fix binding that exact input produced `rows is not iterable`.

## Alternatives considered

- **Keep the unwrap inline in `index.ts` and fix only the declared type**: rejected — the original defect was precisely that the binding sat outside the tested surface; moving the logic behind an exported pure function is what makes a regression test possible at all.
- **Accept both shapes in `runBootSweep` (array sniffing)**: rejected — two accepted shapes let a future envelope change drift silently instead of failing loud, and the loud fail-closed line is this package's contract; one honest shape plus a pinned test beats runtime guessing.
- **Type the binding against the installed `@deepseek-ai/dsh-api-session-controller` SDK instead of a structural view**: rejected — the installed SDK lags the running Host (its `SessionSummary` lacks `agentAvailable`, which the screen reads), so SDK types would misdescribe this Host; structural views against the observed wire shape are the package's established convention (`ReviveSessionApi`, dispatch's `DispatchSessionApi`).

## Consequences

- The fix reaches the running Host only on the next restart (the link install loads `lib/index.js` at activation); restart remains human-owned, so the post-restart criterion stays "no `boot-sweep-failed` at stage `sweep`, and a `boot-sweep` summary whose `rows` is nonzero".
- If the Host ever changes the list envelope again, the compiled binding still cannot catch it (the structural cast remains by convention), but the pinned test documents the expected shape and any runtime mismatch stays fail-closed and loud rather than half-working.
- The sweep's other seams (`sessionPersistence.open/read/close`, `agents.get`, `prompt`) were re-verified against the Host source in the same pass and matched their declarations; the `{ items }` envelope was the only mismatch.
