# Agent Note: Remove dsh-model-capabilities

Status: implemented

Fully supersedes [per-model capability declarations for custom pi-ai providers](../feature/2026-09-08-model-capabilities-plugin.md): the package it introduced is deleted from the tree and the aggregate. The feature note stays as the record of why the capability was built the way it was; this note owns the removal and what the removal knowingly gives up.

## Problem

The SDK 0.2.1-rc.2 cohort makes `dsh-model-capabilities` a duplicate. The official Models page now natively edits the two fields the package existed to expose — per-model input type and reasoning level on custom pi-ai providers — so the package's provider-card panel re-implements a native editor on the same `llm-pi-ai` settings document. Keeping it would leave the family maintaining a second editor over one official namespace, with the keyed-cell claim protocol and the whole-array write path as permanent duplication cost. The package's second capability, provider disable/enable with an archive of the removed profile, has no native replacement; it exists only here. The user was asked explicitly and chose to retire the package whole rather than re-home the toggle, accepting that the archive/toggle capability leaves the product.

## Decision

The whole package `packages/dsh-model-capabilities` (`@linxin666/dsh-client-ui-model-capabilities`) is deleted: source, tests, README triplet, `cordis.patch.yml`, build configs, the aggregate `patchFrom`/`deps` entries and the `web-ui-model-capabilities` cordis row, the i18n audit package entry, the `dsh-i18n` ru dictionary for its namespace, and the publish-prep package row (the family publishes 16 packages, down from 17). No capability logic is re-homed: the per-model input/reasoning editing is ceded to the native Models page editors, and the provider disable/enable archive is ceded to the official Remove-provider button, which performs the same `unset llm-pi-ai.providers.<route>` the plugin used but archives nothing.

One compatibility seam survives: the aggregate keeps the `model-capabilities` tombstone — the `./model-capabilities` shell subpath export resolves to the shared shell re-export and carries generated `shell-metadata/model-capabilities/locale/{en,zh}.json` plus the shared `icon.svg` target, so existing profiles that recorded the `@linxin666/dsh-web-all/model-capabilities` row keep importing without `ERR_PACKAGE_PATH_NOT_EXPORTED`. Nothing mounts: the tombstone is an inert compatibility row, the same pattern the retired `dsh-perf`, `describe-image` and `doctor` families use.

## Alternatives considered

- **Keep the package as a thin skin over the native editors.** Rejected: the native editors cover the two fields the package existed for, so the panel would be a second editor over one settings document, and the keyed-cell claim machinery (conflict notice, retry latch, footer fallback) would keep costing surface for zero added capability.
- **Delete the capability panel but re-home the provider disable/enable archive under another family package.** Rejected by the owner: the toggle was the package's differentiator, not its payload, and retiring it is a product decision the user made explicitly rather than an implementation detail to preserve by moving. Re-homing would also smuggle the `llm-pi-ai.providers.<route>` unset plus archive orchestration into a package that owns neither the Models page nor the provider namespace.
- **Keep publishing the package unmounted.** Rejected: an unmounted published package still carries the README, the registry listing and the update-check noise for a capability the native page now provides, and the family just shrank its published set by decision — a dormant package is the worst of both.
- **Remove the tombstone export with the package.** Rejected: existing profiles recorded `@linxin666/dsh-web-all/model-capabilities`; deleting the export turns every such profile into a boot-time module-resolution error. The tombstone costs one exports entry and two generated locale files, which is the established retirement pattern.

## Consequences

- Custom pi-ai models gain input type and reasoning level through the native Models page editors; the capability does not regress, it changes owner. Models-page copy and behavior are official from here on.
- Disabling a provider now means the official Remove-provider write with no archive: a removed route's configuration is not restorable from a family surface, and a route that comes back starts from an empty profile. This is the capability the user explicitly accepted retiring.
- The family no longer claims the `settings.models.provider-card` keyed cell, so no family plugin can collide there; the claim protocol (refusal naming the occupant, retry on unload) retires with the only package that used it.
- The aggregate ships 16 family packages; `scripts/verify-version.mjs`, the publish-prep table, the i18n audit package list and the aggregate consistency tests all drop the seventeenth.
- The `shell-metadata/` tree and the `./<family>/icon` + `./<family>/locale/<lang>.json` exports are new generated artifacts this removal shares with the 0.2.1-rc.2 cohort adaptation; the `model-capabilities` subpath is the first entry kept purely as a tombstone.
- The row id is deliberately not tombstoned. A profile that recorded `web-ui-model-capabilities` through the plugin manager's per-row toggle carries an override for an id nothing declares, which the loader warns about on every boot while still composing; the plugin-manager update path prunes that orphan instead of the aggregate keeping a row that mounts nothing ([orphan row-override pruning](../bug-fix/2026-10-17-plugin-manager-orphan-row-override-pruning.md)).

## Testing

- The package directory is gone from the worktree (`git status` shows the full tree deleted) and no family manifest, profile fixture, or script references `@linxin666/dsh-client-ui-model-capabilities` outside the tombstone exports entry.
- `packages/dsh-web-all/tests/shell-subpath.spec.ts` pins the tombstone: `exports['./model-capabilities']` resolves to `./lib/shells/shell.js` and its `icon`/`locale` keys resolve.
- `packages/dsh-web-all/tests/children-consistency.spec.ts` and `pnpm aggregate:check` prove the aggregate regenerates without the package and keeps the tombstone metadata.
- Repository gates for the removal change: `pnpm typecheck`, `pnpm test`, `pnpm aggregate:check`, `pnpm docs:check` (README pairs and publish-prep updated), `pnpm i18n:check` (ru dictionary and audit list updated), `pnpm test:scripts`.
- Live GUI check of the native Models page editors after restart on a 0.2.1-rc.2 host remains with the maintainer; the removal is verified by construction (the native editors are official surface) plus the mount smoke of the cohort adaptation.
