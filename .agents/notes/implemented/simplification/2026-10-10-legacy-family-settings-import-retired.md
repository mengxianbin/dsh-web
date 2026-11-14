# Agent Note: Retire the dsh-web-settings legacy family-settings import

Status: implemented

## Problem

`packages/dsh-web-settings/src/legacy-import.ts` (532 lines), its spec (487 lines), a README section and a versioned on-disk document in `$DSH_HOME` exist to adopt family settings that the official 0.1.7 settings subsystem left orphaned. The Host renames `settings.yaml` once and imports each section under its own name as a profile entry id; family rows are `ui-pet` / `web-ui-pet`, `ui-liangshen` / `web-ui-liangshen`, `web-ui-usage`, so those sections match no entry, stay behind in the renamed `settings.yaml.imported`, and would revert to schema defaults. [The 0.1.7 cohort note](../../implemented/architecture/2026-09-22-sdk-cohort-0.1.7-alpha.1.md) owns the decision and documents the two resolution rules, the no-clobber merge and the one-shot marker.

The repair runs in the plugin, after composition settles (`src/index.ts:197-199`), and its whole benefit accrues to a profile that crossed the rename with family sections still un-adopted. Two facts frame the cost:

- Every family package now declares `dsh.engines.dsh >= 0.2.0-rc.2`, so the module can only run on a host line newer than the state it repairs.
- That floor does not prove the state is gone: the orphan state is produced by a 0.1.7-era host, and a profile that ran one with a family plugin older than the cohort note's implementation can cross the floor with its sections still sitting in the renamed document. This module is then the only thing that adopts them.

No document outside the notes names the support window the repair serves: `grep -rn '0.1.7' docs/*.md packages/AGENTS.md` returns nothing, and the four symbols re-exported at `src/index.ts:34-44` have no consumer outside the module's own spec.

## Decision

The owner confirmed the removal. `packages/dsh-web-settings/src/legacy-import.ts` (532 lines) and `packages/dsh-web-settings/tests/legacy-import.spec.ts` (487 lines) are deleted, and `src/index.ts` drops the module import, the four re-exports and four types, the activation-time call and `importLegacyFamilySettings` itself — 222 lines become 184.

The settings-document readers stay: `settingsYamlCandidatePaths`, `readSettingsYamlDocument`, `importedSettingsYamlPath` and `settingsYamlFallbackPath` also feed the bridge's `readSettingsYaml`, so the proposal's item to delete them was wrong and the change keeps them.

The marker document `$DSH_HOME/dsh-web-settings-legacy-import.json` is inert: nothing writes or reads it, and no cleanup job was added. The README trio loses the feature bullet, the 39-line "Legacy settings import" section and the two import-scoped limitation bullets in both languages, and the pair sidecar is re-recorded.

The consequence the owner accepted: a profile that crosses from a 0.1.7-era host with family sections still un-adopted keeps them in `settings.yaml.imported`, and those values read as their schema defaults.

## Context & Efficiency Impact

Roughly 1000 lines of maintained source and tests, one README section in three files, and a versioned document the package writes into the user's `$DSH_HOME` disappear. No runtime behavior changes for an install that has nothing left to adopt, because the repair is a no-op there by construction.

The context gain is that `dsh-web-settings` stops carrying two unrelated jobs: the settings bridge it exists for, and a repair for a host line its own engine floor excludes.

## Evidence

- Production path: `packages/dsh-web-settings/src/index.ts:197-199` calls `importLegacyFamilySettings` (:211), which calls `importLegacyFamilySections` from `legacy-import.ts`.
- A search for `settings.yaml.imported` outside `node_modules` matches only this package's own source and README: no other package, script, test or document names the input.
- The official side of the rename is in the installed `@deepseek-ai/dsh-settings` (`lib/index.js` renames the document once and imports each section by name, logging the ones no entry claims).
- Public surface: `src/index.ts:34-44` re-exports the marker constants and the marker reader plus four types; their only consumer is `tests/legacy-import.spec.ts` (487 lines).
- Floor: `packages/dsh-web-settings/package.json` declares `"dsh": { "engines": { "dsh": ">=0.2.0-rc.2" } }` and the same range as the `@deepseek-ai/dsh` peer, so the package refuses to load on the host whose artifact it repairs.
- Durable format: `LEGACY_IMPORT_MARKER_FILE = 'dsh-web-settings-legacy-import.json'` and `LEGACY_IMPORT_MARKER_VERSION = 1` (`legacy-import.ts:50-53`), written under the resolved DSH home.

## Alternatives considered

- **Keep the repair and state the host window it serves in the package README.** This is the honest form of today's implicit obligation, and it is the alternative the owner should pick if the answer to the open question is "yes". It retains the ~1000 lines and the marker, but it makes the obligation reviewable and retirable on evidence instead of on a hunch.
- **Schedule the retirement instead of doing it now.** Rejected as the primary proposal but recorded as the safe path: keep the module for one more cohort, announce the window's end in the release notes, and delete it in a later release when the notes can say no supported host carries the state. It costs one more release of the code and removes the silent-settings-loss risk.
- **Delete the module now and accept the loss for un-migrated profiles.** Rejected: the loss is silent (the values stay in the renamed document and the user sees defaults), so it is not a trade the survey can make on the owner's behalf.
- **Keep the repair but drop the public re-exports and the four types.** Rejected as insufficient: those are a dozen lines of the cost, while the file, its spec and the durable document are the obligation.
- **Move the repair into a one-off script the user runs.** Rejected: it relocates the same logic to a tool nobody invokes, and a user who never runs it loses exactly the settings the repair exists to save.

## Testing

- `pnpm --filter ./packages/dsh-web-settings typecheck` and its 87 tests pass; no test imported the removed module or its re-exports.
- `pnpm docs:check` passes with the re-recorded `README.i18n.yaml`; the two README sides lost the same 39 section lines and the same three bullets.
- `pnpm i18n:check` and `pnpm emoji:check` pass, and `pnpm test:scripts` stays green.
- A search for `legacy-import`, `importLegacyFamilySections`, `LEGACY_IMPORT_MARKER_` and `readLegacyImportMarkerState` outside `.agents/notes/` returns nothing.

## Risks

- Deleting the repair silently reverts family settings to schema defaults for a profile that crosses from a 0.1.7-era host, and nothing reports it: the official host logs only that it left the section alone.
- Keeping it keeps a versioned on-disk document and ~1000 lines alive for a population the repository cannot enumerate; if that window has closed, the cost is paid forever.
- The marker is a durable format with a version field. Any later change must still read version 1, or drop the document deliberately, which is a second reason the decision belongs in one place.
