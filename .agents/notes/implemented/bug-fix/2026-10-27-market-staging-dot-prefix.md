# Agent Note: Workshop staging directories are dot-prefixed siblings

Status: implemented

This note owns the on-disk name of the Workshop installer's staging directory. The fetch and retry policy of the same function is owned by [issue batch 1937-1942](2026-10-24-issue-batch-1937-1942-fixes.md); the preset library that receives one of the three kinds is owned by [community agent presets](../feature/2026-09-09-community-agent-presets.md).

## Problem

`installAsset()` in `packages/dsh-market/src/core/installer.ts` downloads into a staging directory next to its destination and renames it into place only after every file arrived. The staging name was `dest + '.install-' + <stamp>`, i.e. a sibling of `<id>/` inside the same kind directory (`$DSH_HOME/skins`, `$DSH_HOME/pets`, `$DSH_HOME/agent-presets`), spelled as the real asset id plus a suffix and without a leading dot.

Every consumer that lists one of those directories by name meets it, because the staging name is the real asset id plus a suffix. Each one then applies its own check, and none of those checks is a dot-entry filter: `scanPetDir()` in the pet registry (`satellites/dsh-pet/src/registry.ts`) and `scanPresetIds()` in the preset library (`satellites/dsh-presets/src/core/library.ts`) list by name, and the preset library additionally requires the name to match the preset id rule; `collectSource()` in the skin center (`satellites/dsh-skins/src/skin-repo.ts`) lists every directory, dot entries included, and refuses one whose `skin.json` is missing or invalid, or whose `manifest.id` differs from the directory name. Two states expose the directory to those listings:

- during a download, while the staging directory is being filled;
- after a failure whose best-effort cleanup could not delete it — `rmSync` in the catch block is best effort, and on Windows a handle another process still holds makes it fail silently.

The regression test that was supposed to guard this never read a directory. The case named for cleaning the temp dir and keeping nothing partial on download failure called `require('node:fs')` inside a `.map()` callback in an ES module (which throws), swallowed the throw in a `try/catch` that answered `[]`, and iterated `dirs` while reading `home`. Its assertion `expect(leftovers).toEqual([])` therefore held without observing anything.

## Decision

The staging directory is a hidden sibling of the destination:

```ts
const tmp = join(
  dirname(dest),
  '.' + basename(dest) + '.install-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
)
```

Both halves of that expression carry a requirement. `dirname(dest)` keeps staging in the destination's own parent, so `renameSync` remains an atomic same-volume move. The leading `.` is what the consumers that skip dot entries act on: the pet registry filters `!name.startsWith('.')` and the preset library does the same, so both drop the entry without opening it. The skin center filters nothing by name — it lists every directory — so there the dot prefix marks the entry as unfinished scratch space for anyone reading the directory, while the roster's refusal rests on the `skin.json` / directory-name consistency check it already performs. The rename target is unchanged — still `$DSH_HOME/<kind-dir>/<id>` — so no consumer reads a different path.

All three kinds share `targetDir()`, so the staging directory of each kind is dot-prefixed by the same change.

No automatic cleanup is added. A sweeper over `.<id>.install-*` entries in a user's home directory cannot tell an orphan from a concurrent install, and it would be a recursive delete over a directory this plugin does not own.

The module comment of `installer.ts` states the new contract.

## Testing

`packages/dsh-market/src/core/installer.test.ts` parameterizes the failure case over the three kinds (`skin`/whale-song, `pet`/whale-girl, `preset`/demo-preset). The fetch mock records the parent directory listing at the moment the failing file is requested, which is the state a scanner would observe while the install is still running, and the test asserts:

- the recorded entry matches `^\.<id>\.install-[0-9a-z]+-[0-9a-z]+$`;
- it is a child of the destination's parent, so the rename stays same-volume;
- after the rejection, the parent filtered to non-dot names is empty, and every entry that survived the best-effort cleanup starts with a dot.

Restoring the old non-dot expression makes all three cases fail, so the guard is real; with the shipped expression `npx vitest run src/core/installer.test.ts` passes 30 tests. The successful-install case additionally asserts the kind directory holds exactly the plain id, which pins the unchanged rename target.

Focused verification: `npx tsgo --noEmit` in the package, `pnpm build` at the repository root, then `node scripts/lib-artifact-check.mjs --write` and its check mode — all pass. The committed `lib/index.js` carries the same expression and the refreshed fingerprint in `scripts/lib-artifact-fingerprints.json`.

## Alternatives considered

- **Keep `<id>.install-<suffix>` and teach each consumer to filter the suffix.** Rejected: the filter would have to land in the skin center and the pet plugin, which are separate repositories with their own release cadence, plus every future scanner; the suffix is an installer implementation detail that a consumer has no reason to know. The dot prefix needs no cooperation: the consumers that already skip dot entries drop the staging directory for free, and the one that does not (the skin center) keeps refusing it on its own manifest consistency check.
- **Stage in the OS temp directory and move into place.** Rejected: a cross-volume `renameSync` is a copy plus a delete, so it loses atomicity and can leave a partial destination, which is the exact failure staging exists to prevent.
- **Stage in a dedicated hidden directory (`.staging/<id>-<suffix>`).** Rejected: one more dot entry to skip and one more directory to collect, with no benefit over the dot-prefixed sibling.
- **Add a sweeper for stale staging directories.** Rejected: it cannot distinguish an orphan from a concurrent install in the same home, and it would add a recursive delete over user data.
- **Keep the old test and only fix the `require` call.** Rejected: the repaired assertion would have pinned the suffix-based leftover this change removes.

## Consequences

The pet registry and the preset library no longer meet a staging directory at all, because both skip entries whose name starts with a dot. The skin center still lists it — its scanner does not filter on the name — and refuses it through the same `skin.json` / directory-name consistency check it already applied; what the dot prefix buys there is that the directory reads as unfinished scratch space rather than as an asset id. The rename stays atomic because staging and destination still share one parent, so skins, pets and presets all keep the crash-safety they had.

The disk cost is unchanged in kind and newly invisible: a failure whose cleanup could not run leaves a `.<id>.install-<suffix>` directory holding the files downloaded before the failure, and nothing removes it automatically — the bytes are released only by a manual delete. Previously that leftover appeared in every listing of the kind directory under a name shaped like an asset id; now it is a dot entry the pet registry and the preset library skip, and the bytes remain either way — which is why the limitation is written down here rather than fixed by a sweeper.
