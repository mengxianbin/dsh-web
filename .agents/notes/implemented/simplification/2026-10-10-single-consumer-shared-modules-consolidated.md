# Agent Note: Consolidate the four single-consumer shared modules into their consumers

Status: implemented

## Problem

`shared/` is the family's cross-package source of truth: `scripts/sync-shared.mjs` copies each module into every consumer package as a generated file, and `pnpm test:scripts` fails when a copy drifts from its source. Four manifest entries now declare exactly one consumer each.

| Shared source | Lines | Single consumer copy |
| --- | --- | --- |
| `shared/host/poll-guard.ts` | 108 | `packages/dsh-git-graph/src/host/poll-guard.ts` |
| `shared/host/git-runner.ts` | 123 | `packages/dsh-git-graph/src/host/git-runner.ts` |
| `shared/client/sse-leader.ts` | 121 | `packages/dsh-git-graph/src/client/sse-leader.ts` |
| `shared/host/legacy-migration.ts` | 63 | `packages/dsh-plugin-manager/src/host/legacy-migration.ts` |

Each of the four is maintained twice — a shared source plus a byte-identical generated copy that is one header line longer — and every edit pays a sync run plus the drift gate for a consumer set of one.

The second consumers were deleted by earlier removals that shrank the manifest entries instead of retiring them. [The aionui-panel removal](../../implemented/simplification/2026-08-28-remove-dsh-aionui-panel.md) deleted the panel's copies of poll-guard, git-runner and sse-leader; `b6fea32d` rewrote the git-runner targets from two entries to one. [The dsh-doctor removal](../../implemented/simplification/2026-09-23-remove-dsh-doctor-and-describe-image.md) deleted `packages/dsh-doctor/src/agent/legacy-migration.ts` along with its package.

No satellite repository carries any of the four, so none of them is the canonical definition this repository publishes to its satellites. That role is exactly why [the dead-shared-artifacts note](../../implemented/simplification/2026-09-26-dead-shared-artifacts-removed.md) kept `shared/host/run-guarded.ts` while deleting its consumer copies, and it does not apply here.

The Doctor removal also left four descriptions of its deleted consumer behind, which now contradict shipped reality:

- `shared/host/legacy-migration.ts` and its generated copy still call the map "shared by the plugin-manager update job and the Doctor preflight launcher so they never drift".
- [The legacy aggregate migration note](../../implemented/feature/2026-08-24-automatic-legacy-aggregate-migration.md) still presents the Doctor Launcher as the startup-path implementation and says the map "is synchronized into both consumers".
- `docs/publish-prep.md` still describes the Doctor migration and its constrained `cmd.exe` shim as part of the frozen contract.
- `docs/architecture.md` still lists a `sidebar-entry` client module that `shared/client/` no longer carries, and `packages/AGENTS.md` still names poll-guard as a family-shared module.

## Decision

The four modules now have one home each. `packages/dsh-git-graph/src/host/poll-guard.ts`, `packages/dsh-git-graph/src/host/git-runner.ts`, `packages/dsh-git-graph/src/client/sse-leader.ts` and `packages/dsh-plugin-manager/src/host/legacy-migration.ts` are hand-written sources without a generated header; `shared/host/poll-guard.ts`, `shared/host/git-runner.ts`, `shared/host/legacy-migration.ts` and `shared/client/sse-leader.ts` are gone, and `scripts/sync-shared.mjs` no longer carries their entries, so the manifest holds 18 sources and the gate asserts 106 copies (43 client, 46 host).

The three specs moved with their modules — poll-guard and git-runner into `packages/dsh-git-graph/tests/`, legacy-migration into `packages/dsh-plugin-manager/tests/` — their relative imports now read `../src/host/`, and their `scripts/test-standards-baseline.json` entries carry the new paths with the same recorded counts. No import at a call site changed.

The descriptions that outlived their consumer are repaired: the module header, [the legacy aggregate migration note](../feature/2026-08-24-automatic-legacy-aggregate-migration.md) in both languages, `docs/publish-prep.md`, and the shared-layer sections of `docs/architecture.md` and `packages/AGENTS.md`, which now also state the rule this change establishes: a module with one consumer belongs to that package, not to `shared/`.

## Context & Efficiency Impact

No prompt, schema or runtime cost: the four modules keep their exports, their consumers and their behavior, and no wire, configuration or durable format changes. The change deletes four files (415 lines), four generated headers and four manifest entries, leaving the manifest at 18 sources.

The gain is on the maintenance path. Today an editor of poll-guard, git-runner, sse-leader or legacy-migration writes the shared source and then runs `node scripts/sync-shared.mjs`, and the drift gate keeps a second copy honest forever. Afterwards `shared/` contains only modules with at least two consumers, so "why is this shared?" is answerable from the tree instead of from the manifest.

## Evidence

- Manifest single targets: `scripts/sync-shared.mjs` lines 78-84 (poll-guard), 101-105 (git-runner), 118-124 (legacy-migration) and 162-166 (sse-leader) each hold a one-element `targets` array.
- Consumers: `packages/dsh-git-graph/src/host/routes.ts:19`, `packages/dsh-git-graph/src/host/git-service.ts:15`, `packages/dsh-git-graph/src/client/api.ts:8` and `packages/dsh-plugin-manager/src/host/routes.ts:18`.
- A search for `poll-guard|git-runner|legacy-migration|sse-leader` over `packages` (`*.ts`, `*.tsx`) returns 11 lines: the four copies, their generated headers and the four importers above. No other package names any of the four modules.
- The same search over `shared` returns the four sources plus the three specs (101, 135 and 34 lines); over `scripts` it returns only `sync-shared.mjs` and the two baseline keys for poll-guard and git-runner.
- Searching `satellites/` for each of the four module names returns nothing; the only shared host module a satellite carries is `run-guarded`.
- History: `b6fea32d` ("refactor: remove retired dsh-skins package and dsh-aionui-panel host archive") rewrote the git-runner targets to the single dsh-git-graph path; `ef637f65` ("feat(aggregate)!: remove dsh-doctor and dsh-tool-describe-image from the family") dropped the Doctor targets.

## Alternatives considered

- **Leave the four entries in place and treat "one home under shared/" as the invariant.** Rejected: the copies have one reader each, the modules are not satellite contracts, and the repository already removed a shared artifact whose consumers were gone in [the dead-shared-artifacts note](../../implemented/simplification/2026-09-26-dead-shared-artifacts-removed.md). Keeping them keeps a sync step, a generated header and a drift assertion alive for each.
- **Move the modules and delete their specs instead of moving the specs.** Rejected: poll-guard's timer discipline and git-runner's subprocess plumbing carry 11 real cases between them, and the move preserves that coverage at no cost.
- **Stop copying and publish one shared runtime package the plugins depend on.** Already rejected for the whole family by [the shared pair-access fence](../../implemented/simplification/2026-08-26-shared-pair-access-fence.md), because packages must stay independently publishable without a workspace-internal dependency chain; this proposal does not revisit that decision.
- **Point each manifest entry at the consumer copy, so source and target are the same file.** Rejected: a self-copy is a no-op that keeps the entry, the generated-header rule and the count comments while asserting nothing.
- **Also consolidate the remaining non-synced duplicates** (four `css-modules.d.ts` variants and four duplicated `vitest.config.ts` pairs). Deferred: they are 5 to 32 lines of per-package configuration whose duplication costs nothing to read, and a shared destination would add a mechanism for a handful of lines.

## Testing

- `node scripts/sync-shared.mjs --check` and `pnpm test:scripts` pass with the new counts (106 copies, 43 client, 46 host), and `shared/` no longer contains `host/poll-guard.ts`, `host/git-runner.ts`, `host/legacy-migration.ts` or `client/sse-leader.ts`.
- `pnpm typecheck` and `pnpm test` pass for `shared`, `dsh-git-graph` and `dsh-plugin-manager`; the three moved specs run in their new package's vitest project with the same case counts (4, 7 and 3) and `pnpm test:standards` accepts the renamed baseline keys.
- The four modules export the same symbols to the same importers; no call site changes.
- `pnpm docs:check`, `pnpm i18n:check` and `pnpm emoji:check` pass, and the module header, the migration note in both languages, `docs/publish-prep.md`, `docs/architecture.md` and `packages/AGENTS.md` no longer describe the removed Doctor consumer or a `sidebar-entry` shared module.

## Risks

- A future second consumer of any of the four must extract it back into `shared/` and add a manifest entry. That is the signal the dead-shared note prefers, but it is work that does not exist today.
- The three specs change package: `pnpm --filter dsh-git-graph test` and `pnpm --filter dsh-plugin-manager test` now carry them, and the shared suite can no longer see them during a `shared/` refactor.
- The counts and rationale comments in `scripts/sync-shared.test.mjs` are hand-maintained; landing the change without rewriting the comments invites a future reader to re-add an entry believing it was never audited.
- Moving the legacy-migration spec next to its only consumer keeps it alive for as long as the migration ships. If the owner later retires the legacy aggregate migration itself — its boot-time half already left with dsh-doctor — the map, its consumer code and this spec leave together.
