# Agent Note: Profile rows follow the package that now carries their entry id

Status: implemented

## Problem

The include patch semantics skip a row whose `name` does not match the name of
the row a bundle inserted under that id, and the skip takes the whole row with
it. A profile row that names a package the bundle no longer mounts is therefore
inert: a `config:` row stops configuring anything, a `disabled: true` override
stops disabling anything, and the loader only says so once per boot
(`patch: name mismatch for "<id>" … skipping`) in a log line no product
surface reads.

[Issue #1901](../architecture/2026-10-18-aggregate-family-rows-mount-real-packages.md)
renamed every family row of the aggregate from the
`@linxin666/dsh-web-all/<family>` subpath to the real package
(`@linxin666/dsh-client-ui-task-board` and friends). The row ids stayed
`web-ui-*`, so an id-targeted override still matched — but every profile row
that also carried the old `name:` was skipped whole. On the machine where
this was found, the task board's GitHub provider had been configured through
the aggregate row; its repository list stopped applying, the `assignee`
channel was gone with it, every issue the repository auto-assigns to the
account was filtered out, and the board reported zero open issues with nothing
wrong visible anywhere in the product.

## Decision

The plugin manager repairs the profile's own rows: a row whose entry id a live
bundle still claims, but whose recorded name is not the name that bundle's row
carries, is rewritten to the live name.

- The live names are read from the installed bundles' own `cordis.patch.yml`
  files — the very place the loader takes the name of the row it inserts — so a
  repaired row names exactly the package the loader mounts under that id.
- A row whose id no installed bundle claims is left alone. Its package may
  still be carried by a layer this manager cannot see, and a name it cannot
  prove is a name it must not write.
- The repair is idempotent and writes only when a row actually changed, so a
  healthy profile is never rewritten, never backed up and never reloaded.
- It runs in two places: once after the boot settled (the host rewrites the
  layer and the loader hot-reloads it, so the repaired configuration applies
  without a restart) and once in the post-update repair pass, so a profile that
  met a renamed row through a plugin update is repaired while that update runs.

The repair is a repair, not a migration: it restores what the profile already
says about a row whose id still exists. It never adds a row, never removes
one, and never decides what a row should contain.

## Alternatives considered

**Let the aggregate keep its old subpath names.** Rejected: it reverts the
half of #1901 that removed the 2.9 MB inlined client bundle, which is the
whole point of the rename.

**Ship a one-shot migration script in this repository.** Rejected: the
breakage is silent, so nobody knows to run the script, and a script that must
be run by hand cannot be the only repair for a defect whose whole shape is
that nobody notices it.

**Make the family plugins tolerate a missing configuration.** Rejected: it
repairs one symptom of the general breakage. The same rename also silently
drops a `disabled: true` override, so a plugin the user switched off comes
back; a plugin-level workaround would leave that untouched.

**Ask the host to write profile rows without a `name:`.** Out of reach from
this repository: the host's configuration editor owns that writer, and the
loader-side name check is host behaviour.

## Consequences

- A profile whose bundle renamed a row's package gets that row's
  configuration and enablement back on the next boot, and the repair is
  reported in the host log (`已修复 profile 中失效的行名`) so the change is
  visible rather than silent.
- The plugin manager writes one file it did not write before (the profile
  layer). The write goes through the same backup + tmp + rename path as every
  other profile write it performs, and it happens only when a row's name was
  provably stale.
- The repair covers the rows of the bundles the profile installed. A row whose
  package is renamed by a bundle outside the profile keeps its stale name, and
  the loader keeps skipping it: the manager proves a name only from a bundle it
  can read.
- The loader's own `name mismatch` warning remains the loader's business.
  The repair removes the situation that produced it for profile rows; it does
  not silence the loader.

## Testing

`packages/dsh-plugin-manager/tests/rows.spec.ts` pins the repair: a stale
config row is pointed at the live package and keeps its configuration, a
stale enablement override is repaired the same way, a row no live bundle
claims and a nameless row are left alone, and a layer whose rows already name
the live packages is returned unchanged so the caller writes nothing.
`pnpm --filter @linxin666/dsh-client-ui-plugin-manager typecheck` and
`pnpm --filter @linxin666/dsh-client-ui-plugin-manager test` pass.
