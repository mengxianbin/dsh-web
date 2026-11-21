# Agent Note: Collapse the board card seat into the shared plugin-card helper

Status: implemented

## Problem

`packages/dsh-task-board/src/client/board-card-seat.ts` (102 lines) is a second implementation of `installPluginCard` from `shared/client/settings/plugin-card-seat.ts`. The two reconcile loops are the same code — seat selection through `familyGroupLoaded`, the re-entrancy latch, disposal before re-registration on `slots/changed`, the refusal warning — with one difference: the board's copy forwards a `children` declaration to both seat registrations.

The wrapper's own module header records the intent: "it should collapse back into the shared helper once that helper accepts children". It has one caller, `packages/dsh-task-board/src/client/index.ts:241`, which registers the board's settings card with `children: { 'task-board.settings.section': { kind: 'list', scope: 'root' } }` — the seat a provider renders into, declared by [the extension contract](../../implemented/architecture/2026-09-30-task-board-extension-contract.md) and consumed by `TaskBoardSettingsCard.tsx:519`.

The seat's own decision record has also drifted from what ships. [The seat note](../../implemented/bug-fix/2026-09-17-family-plugin-card-seat-follows-the-loaded-group.md) still names `settings.plugin.item` as the official keyed seat, which the 0.1.6-alpha.2 cohort removed — the helper falls back to `plugins.bundle.config` today, as [the cohort note](../../implemented/architecture/2026-09-17-sdk-cohort-0.1.6-alpha.2.md) records — and it still lists `doctor` and `tool-describe-image` among the five packages that change seat behavior together, although both left the family on 2026-09-23.

The cost is not only the duplicated lines. Because the board's entry never calls `installPluginCard`, the package's synced copy of the helper has no caller of its own, so the family's seat decision is maintained in two places and a fix to one has to be mirrored by hand into the other.

## Decision

The shared `PluginCardSeat` carries an optional `children: Record<string, unknown>` field, forwarded in both registration branches with the same conditional-spread form the helper already uses for `order`, `label` and `inject`. `packages/dsh-task-board/src/client/board-card-seat.ts` is deleted and `packages/dsh-task-board/src/client/index.ts` registers its settings card through `installPluginCard`, keeping the same `children` declaration for `task-board.settings.section`.

Seat selection, the re-entrancy latch, the `slots/changed` reconciliation and the refusal warning are the shared helper's, so the family has one implementation of "how a card picks its seat" and the board's copy of the helper finally has a caller.

[The seat note](../bug-fix/2026-09-17-family-plugin-card-seat-follows-the-loaded-group.md) is refreshed in both languages: the official keyed seat it names is `plugins.bundle.config` (the 0.1.6-alpha.2 cohort removed `settings.plugin.item`), and the packages that share the decision are the three the manifest lists.

## Context & Efficiency Impact

No runtime, wire or configuration change: the board's card still registers into the family list seat when `dsh-web-settings` is loaded and into `plugins.bundle.config` otherwise, still declares the provider seat, and still moves when the group applies late. The change deletes 102 hand-written lines and one module in exchange for one optional field in the shared source plus three regenerated copies.

The gain is one implementation of "how a family card picks its seat" instead of two, which is also the version the other two consumers and the seat spec already exercise.

## Evidence

- `shared/client/settings/plugin-card-seat.ts:131-191` (`installPluginCard`) and `packages/dsh-task-board/src/client/board-card-seat.ts:49-102` (`installBoardCard`) are the same reconcile loop; the only structural difference is `children: seat.children` at board lines 75 and 82.
- The collapse intent is stated in the wrapper's own header (`board-card-seat.ts:5-10`).
- Callers: `installBoardCard` appears at its declaration plus `packages/dsh-task-board/src/client/index.ts:36` (import) and `:241` (call). `installPluginCard` has live callers in `packages/dsh-remote-web-ui/src/client/index.ts:313` and `packages/dsh-liangshen/src/client/index.ts:202`, and a dedicated spec at `packages/dsh-remote-web-ui/tests/plugin-card-seat.spec.ts:62-114`.
- A search for `plugin-card-seat` under `packages/dsh-task-board/src` returns only the wrapper's import: nothing else in the package reads its synced copy.
- The child seat is live: `packages/dsh-task-board/src/client/index.ts:110` declares `task-board.settings.section`, `packages/dsh-task-board/src/client/TaskBoardSettingsCard.tsx:519` renders it through `renderSlot`, and `packages/dsh-task-board-github/src/client/index.ts:63` registers into it.
- A search of `implemented`, `rejected` and `archived` notes for `board-card-seat`, `installBoardCard` and `installPluginCard` returns no decision that depends on the wrapper existing; the notes that own the seat contract require the child declaration, which the shared helper keeps.
- The drift in the seat note is visible in its own text: `2026-09-17-family-plugin-card-seat-follows-the-loaded-group.md` names the removed seat key in its Decision and counts five consumer packages in its Consequences, while `shared/client/settings/plugin-card-seat.ts:45` exports `plugins.bundle.config` and the sync manifest lists three package copies.

## Alternatives considered

- **Keep the wrapper and treat the board's card as special.** Rejected: the special part is one optional field, and the rest is a copy that must be kept in step by hand every time the shared seat decision changes.
- **Make `children` a required field of the shared type.** Rejected: dsh-remote-web-ui and dsh-liangshen declare no child seats, so a required field would force empty declarations into both call sites and change their registrations for no gain.
- **Add a second exported installer to the shared source instead of extending the existing one.** Rejected: two installers over one seat decision re-create exactly the drift this proposal removes, and the copies would grow.
- **Give the board its own seat constants rather than using the family helper.** Rejected: the seat keys and the family-group probe are the one decision every family card must share; a per-package copy is what produces cards that land in the wrong seat.
- **Also collapse the remaining board-local seat helpers** (the settings-entry-form binding and the task-board-github card). Deferred: those have no shared counterpart today, and creating one would add a manifest entry rather than remove an obligation.

## Testing

- `node scripts/sync-shared.mjs --check` passes and the three consumer copies carry the optional `children` field.
- `packages/dsh-task-board/src/client/board-card-seat.ts` no longer exists, and `packages/dsh-task-board/src/client/index.ts` registers its card through `installPluginCard` with the same `children` declaration.
- The board's settings card still registers into `web-ui.plugin.item` when the family group is loaded and into `plugins.bundle.config` otherwise, still declares `task-board.settings.section`, and still moves seats when the group applies after the board; `packages/dsh-remote-web-ui/tests/plugin-card-seat.spec.ts` stays green.
- `pnpm typecheck` and `pnpm test` pass for `dsh-task-board` and the other two consumers, and the react/type-only import rules of the browser bundle stay unchanged.
- Because `dsh-web-all` inlines its children's client sources and commits `lib/`, the aggregate is rebuilt and its fingerprints re-recorded (`pnpm build`, `pnpm libs:write`, `pnpm libs:check`).
- The seat note names the key the helper actually falls back to and the three packages that still ship the decision; its remaining facts and its alternatives stay untouched.

## Risks

- The shared type becomes broader for all three consumers. A seat that must not declare children can only omit the field; nothing enforces that.
- The board's card loses its package-local escape hatch: a future cohort that changes the official seat key changes the board together with the other two consumers instead of independently. That is the intent, but it is a real coupling.
- A registration that receives `children: undefined` must not be emitted; the conditional spread is what keeps the official keyed seat's payload byte-identical to today's, and a careless rewrite into a plain property would change the registration object.
- The aggregate bundle is only correct after a rebuild, so a change that skips `pnpm build` would ship a board whose page still runs the old card registration.
