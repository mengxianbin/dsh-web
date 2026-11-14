# Agent Note: The release-age override is the kebab-case pnpm key, because pnpm 12 drops the camelCase one

Status: implemented

## Problem

`@linxin666/dsh-update` overrides pnpm's supply-chain gate for a user-initiated update by passing a per-invocation command-line override instead of asking every profile to edit `pnpm-workspace.yaml`. That override was spelled `--config.minimumReleaseAge=0`, the spelling pnpm 11 accepts.

pnpm 12 changed the parsing of `--config.<key>`: only kebab-case keys are recognised. The camelCase key is still accepted as a flag, so there is no warning and no non-zero exit — it simply does not reach the pnpm configuration. On pnpm 12.4.2 the update command therefore ran with the gate fully in force:

- `pnpm add dsh-context@latest --config.minimumReleaseAge=0` installed 0.73.0, one release behind; `--config.minimum-release-age=0` installed the same-day 0.73.1. `pnpm config list --json` showed no `minimum*` entry for the camelCase form and `"minimumReleaseAge": 0` for the kebab-case one.
- The panel's own command, in a profile copy carrying the same `pnpm-workspace.yaml`, printed `Lockfile passes supply-chain policies` and `Already up to date` with exit code 0, and the installed version stayed put.
- pnpm 11.28.6 accepted both spellings, so the regression is invisible on the pnpm the repository itself uses (`packageManager: pnpm@11.24.0`) and only appears on a host that runs pnpm 12.

The post-run verification did surface the no-op as `update.error.stale`, but the copy attributed it to a user-side `pnpm-workspace.yaml` remedy and named pnpm 11 as the owner of the gate — neither of which describes a host where the override itself was ignored.

## Decision

`MIN_RELEASE_AGE_OVERRIDE` is `--config.minimum-release-age=0`. The three candidate commands (`pnpm`, `corepack pnpm`, `npx --yes pnpm`) keep sharing the constant, so the spelling is single-sourced and the pinned tests read it off the spawned argument list.

kebab-case is the only spelling that works on both majors: pnpm 11 accepts kebab-case and camelCase, pnpm 12 accepts kebab-case only. Choosing it makes the override independent of which pnpm the host resolves.

The `update.error.stale` copy in `packages/dsh-update/src/client/locales.ts` (zh source, en counterpart) and in the centralised Russian dictionary (`packages/dsh-i18n/src/client/ru/update.ts`) now says pnpm 11/12, states that the command already passes `--config.minimum-release-age=0`, points at the pnpm 12 key-spelling change as the first thing to check when the override did not apply, and keeps the `minimumReleaseAgeExclude` / `minimumReleaseAge: 0` remedy for the case where it really does not apply. The package READMEs (English and Chinese) record the same fact in their known-limitations entries.

## Alternatives considered

- **Pass both spellings on the command line.** Rejected: the dead key would be a permanent invitation to re-introduce the camelCase form, and the argument list is asserted verbatim by the existing tests, so a second key buys nothing but noise.
- **Detect the pnpm major before building the command.** Rejected: it doubles the process work on the update path (a version probe before every run) to choose between two spellings when one spelling already covers both majors.
- **Drop the override and rely on the stale report.** Rejected: that is the pre-#263 state — every same-day family release becomes an un-updatable version behind a message that blames the user's configuration, which is exactly what the override was introduced to prevent.
- **Write `minimumReleaseAge: 0` into the profile's `pnpm-workspace.yaml`.** Rejected: the plugin would become a second writer of the user's profile configuration for a setting that only matters during one command, and a durable override would also disable the gate for installs the user did not initiate.

## Consequences

- A profile whose host resolves pnpm 12 now actually bypasses the gate, so an update to a release younger than 24 hours installs it instead of printing `Already up to date` with exit code 0.
- A host that ignores the override for some other reason still fails loudly: the post-run verification reports `stale`, and the message now names the key-spelling change and the profile-level remedy rather than a single cause.
- The override stays per-invocation and user-initiated; the gate still protects every other install the profile performs.

## Testing

`packages/dsh-update/tests/update.spec.ts` pins the argument list for all three candidates, so the kebab-case key is asserted verbatim: a regression back to the camelCase spelling fails the suite on the primary `pnpm` path and on both fallbacks. `pnpm i18n:check` holds the zh/en/ru key sets and placeholders together, and `pnpm docs:check` verifies the README pair against its recorded hashes.
