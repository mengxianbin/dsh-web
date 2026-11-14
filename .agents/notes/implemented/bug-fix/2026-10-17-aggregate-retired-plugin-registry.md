# Agent Note: Generate the aggregate's retired-plugin registry from its manifest

Status: implemented

## Problem

The family aggregate's fault-isolation shell (`packages/dsh-web-all/src/shell.ts`) skips a stale profile row whose plugin has been retired: it mounts nothing, imports nothing and records nothing, so a normal retirement never reaches the degraded ledger. That skip reads a list of retired package names, and the list was a hand-written literal beside the shell. Hand-written lists drift from reality. The 2026-09-23 removal of dsh-doctor and dsh-tool-describe-image deleted both packages without touching it, so a profile still carrying either row fell past the guard into `await import(spec)`; the import failed because the package no longer exists anywhere in the workspace, and `recordDegraded(spec, 'import', error)` turned a deliberate retirement into a permanent "this plugin is broken" record on `GET /api/dsh-web-all/degraded`. The later model-capabilities removal happened to edit the literal, which is exactly the failure mode of a hand-maintained copy: correct only when someone remembers.

Two gaps let that survive. No test covered the direction this note is about, shell-metadata families against dependencies and the retirement registry; the existing children-consistency suite covers only patch rows against `src/client/children.specifiers.json`. And `node scripts/aggregate.mjs --check` compared expected file contents one by one, so it could not see a shell-metadata family directory or locale file that no longer had a manifest entry behind it — `pruneShellMetadata` removes those only in write mode.

## Decision

`packages/dsh-web-all/aggregate.yml` gains a `retiredPlugins` section: one single-line JSON flow mapping per retired family, `{"family": "<tombstone subpath>", "plugin": "<real package name>"}`, in the same style as `rows:` and `shellNotes:`. The manifest is the only source for the list.

`scripts/aggregate.mjs` parses the section, validates it fail-closed, and generates `packages/dsh-web-all/src/retired-plugins.generated.ts` next to the client-children modules it already owns. The generated module exports `RETIRED_FAMILIES` (subpath to package name, sorted by family) and `RETIRED_PLUGINS` (every package name, sorted, derived from `RETIRED_FAMILIES`). Validation rejects a non-string or empty field, a family that does not match `^[a-z0-9-]+`, a family that is not already a tombstone, a duplicate family or package name, and a plugin that is also one of the aggregate's own dependencies. Each of those is an error, not a warning, because every one of them produces a shell that either crashes a boot or silently swallows a live plugin.

`src/shell.ts` imports `RETIRED_PLUGINS` from the generated module and wraps it in the same `Set` it used to build from a literal. The guard's position and semantics in `apply()` are unchanged.

The check direction is closed in three places: `scripts/aggregate.test.mjs` gates the manifest shape (every family is a tombstone, no plugin is a dependency, the generated module matches the manifest entry for entry, and both issue-named packages are present); `packages/dsh-web-all/tests/retired-plugins.spec.ts` gates the runtime contract against the generated files; and `aggregate.mjs --check` now reports shell-metadata entries the manifest does not own as drift, so a family that loses its row while keeping its directory and its exports fails the gate instead of passing it.

## Shell-metadata families have exactly two sources

`shell-metadata/<family>/` is generated display metadata, and every directory in it is either carried by a dependency (a shell-wrapped row through `config.plugin`, or a direct-mounted row through its own `name`), or registered as retired. The test asserts that equality in both directions: a family with no carrier and no registry entry fails, and a carrier or registry entry with no directory fails. That is what makes the two facts one fact. The tombstone is not a leftover — it is the export that keeps a stale `@linxin666/dsh-web-all/<family>` row resolvable, so an entry may only be retired while its family stays in `tombstones:`, and the generator refuses the reverse order.

## Alternatives considered

- Delete the five retired shell-metadata directories and their twenty exports outright: rejected. The old profile rows naming those subpaths resolve the export before any plugin code runs, so removing it turns a quiet no-op into a boot-time `ERR_PACKAGE_PATH_NOT_EXPORTED` — a startup-level failure for every user who upgraded without editing their profile. The tombstones are the compatibility surface, not dead weight, and the 2026-09-23 removal note already records the same rejection.
- Keep the hand-written `RETIRED_PLUGINS` literal and only add the two missing package names: rejected. The facts (which families are retired, which package each used to be) already live in the manifest beside the tombstones; a second copy beside the shell is a copy that has already drifted once, and fixing today's drift does not stop tomorrow's. Generating the module from the same section makes the drift structurally impossible rather than a thing to remember.
- Validate the registry in a test only, without teaching `--check` about stray shell-metadata: rejected. A gate that runs one direction and prunes the other stays green while write mode would delete files, which is how the missing test and the missing check coexisted in the first place.

## Consequences

Adding a retired family is a three-line manifest edit (a `tombstones` entry, a `retiredPlugins` entry, its `shellNotes` line) plus a generator run; the shell never needs a manual edit again. `src/retired-plugins.generated.ts` is a build input of both shell entry artifacts, so a stale copy is caught by `pnpm aggregate:check` and by the committed lib fingerprint rather than by a boot that reports false degradations. The module is small and frozen at render time, so the shell still has no runtime dependency on the manifest.

The gate now reports a shell-metadata directory the manifest does not own as check drift. That is the intended coupling: display metadata, subpath exports and the retirement registry are three views of one family list, and any of them moving alone fails the gate. A future aggregate that ships shell metadata without a shell package is unaffected — the registry module and the stray check are scoped to the package the shell actually belongs to.
