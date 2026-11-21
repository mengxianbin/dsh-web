# Agent Note: LiangShen row ships enabled in the aggregate

Status: implemented

## Problem

The aggregate ships low-usage family plugins disabled by default: `packages/dsh-web-all/aggregate.yml` lists row ids under `inactive:`, and the generator renders a trailing `disabled: true` override for each, so a fresh install neither loads the row nor shows its settings entry (`web-ui-liangshen` was on that list from 2026-09-09 alongside SSH and skill-explorer).

For liangshen the absence is total rather than cosmetic. The row's host half is what declares the bundled LiangShen preset to the agent-preset registry, and the composer lever reads its roster and selection state from that registry, so a disabled row means new sessions have no LiangShen mode and the homepage lever has nothing to toggle. The mode is the deployment's standing surface for new sessions, so it has to be present on a fresh install without a detour through Settings → Plugins → Plugin manager.

## Decision

`web-ui-liangshen` is absent from the `inactive:` list, so the generated patch has no `disabled: true` override for it: fresh aggregate installs load the row, the host half declares the `liangshen` preset at activation, and the lever is present on the blank-session homepage. SSH and skill-explorer keep the opt-in default.

The disable path is unchanged. A user who turns the row off writes an explicit user-layer `disabled: true` that outranks the bundle default, and the plugin manager composes the effective state as user row, then bundle default, then enabled ([the effective-enablement fix](../../implemented/bug-fix/2026-09-10-plugin-manager-effective-enablement.md)), so the switch keeps reading what the next start loads.

## Testing

`node scripts/aggregate.mjs` regenerates `cordis.patch.yml` without the override, `node scripts/aggregate.mjs --check` reports no drift, and `scripts/aggregate.test.mjs` still asserts that every remaining `inactive` id carries its override. `pnpm docs:check` and `pnpm i18n:check` pass over the updated aggregate README pair and the architecture diagram.

## Alternatives considered

- Keep the row disabled and surface an onboarding prompt for it. Rejected: it needs a new host route and panel for a single row, and the mode is meant to be there from the first session rather than offered.
- Express the default through the `patches:` seed config instead of the loading list. Rejected: that section rewrites a row's config, not whether the loader mounts the row, so the preset would still be undeclared.
- Enable the row lazily when the first blank session is opened. Rejected: the lever cannot render while the row is unloaded, so the trigger has no surface, and writing the user layer without a user action makes a product default look like a user choice.

## Consequences

- Fresh aggregate installs carry one more loaded row (host and browser halves) and one more settings card.
- Existing installs that never touched the row follow the bundle default and see the mode appear; installs that disabled it explicitly keep it off.
- Standalone `@linxin666/dsh-liangshen` installs are unaffected, and the aggregate row id `web-ui-liangshen` is unchanged.
