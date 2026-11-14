# Agent Note: Incremental TypeScript programs for build and typecheck

Status: implemented

## Problem

Every `pnpm build` and `pnpm typecheck` redid the same compiler work. Fourteen packages ran `tsc --noEmit` for their typecheck program and eleven of them also ran a non-incremental `tsc -p tsconfig.build.json` for their declaration output, so a warm `pnpm build` cost about 6.0s and a warm `pnpm typecheck` about 7.6s with nothing cached between runs. Only three packages (`dsh-git-graph`, `dsh-remote-web-ui`, `dsh-update`) carried `tsc -b` state, and their typecheck runs were the only ones that skipped work.

## Decision

Every package keeps its programs but makes them incremental:

- The declaration program (`tsconfig.build.json`) is `composite: true` with `tsBuildInfoFile: "lib/tsconfig.build.tsbuildinfo"`, and the build script runs `tsc -b tsconfig.build.json && tsdown`. `tsdown` still emits the JavaScript bundles.
- The typecheck program (`tsconfig.json`, `src` plus `tests`) keeps `noEmit` and gains `incremental: true` with its cache inside `lib/` (`lib/tsconfig.typecheck.tsbuildinfo`) for the packages whose build emits declarations, and inside `node_modules/.cache/` (`tsconfig.typecheck.tsbuildinfo`) for the three packages whose build is `tsdown` alone (`dsh-market`, `dsh-web-all`, `dsh-web-settings`). `tsconfig.test.json` inherits `incremental` and already pointed its own cache at `node_modules/.cache/`.
- The typecheck program of the fifteen packages whose `typecheck` is `--noEmit` runs under the native compiler (`tsgo` from `@typescript/native-preview`, pinned exactly in the root `devDependencies`; one root entry suffices because a workspace script resolves the workspace root's `node_modules/.bin`). The three `tsc -b` packages keep `tsc`: build mode emits, tsgo's emitted bytes are not identical to tsc's (printer quote style) and the build's `tsc -b` cannot reuse a tsgo-written `tsbuildinfo`, so switching them made the build slower than the typecheck gained. The native compiler honors the same settings — it writes the configured `tsBuildInfoFile`, reuses it on a warm run, and leaves an unchanged warm file untouched — and produces the same project set and the same verdict as `tsc` for every switched package.
- The five packages whose `files` entry was the bare `lib` directory (`dsh-i18n`, `dsh-model-capabilities`, `dsh-plugin-manager`, `dsh-session-id`, `dsh-skill-explorer`) now list the four artifact globs (`lib/**/*.js`, `lib/**/*.js.map`, `lib/**/*.d.ts`, `lib/**/*.d.ts.map`) that the three existing `tsc -b` packages already used, so the build cache is never published. (Update 2026-10-17: `dsh-model-capabilities` was removed from the family in the 0.2.1-rc.2 cohort adaptation — see [remove dsh-model-capabilities](../simplification/2026-10-17-model-capabilities-native-removal.md) — so the glob change now covers the remaining four.) The three `tsdown`-only packages need no glob change because their typecheck cache lives outside `lib/`.

## Why the cache lives next to the outputs

`tsc` skips re-emitting a file whose version is unchanged, which is the point of the cache — and the sharp edge of it. With the cache outside `lib/`, `rm -rf lib` followed by a warm run restored **zero** declarations: the compiler considered the project up to date and emitted nothing, leaving a package without types while `pnpm build` reported success. Measured on `dsh-task-board`: after deleting `lib/`, a warm incremental run took 0.48s and produced no `.d.ts` files. Putting the cache inside `lib/` ties its lifetime to the outputs it describes: `rm -rf lib` removes the cache too, and the next build re-emits everything (verified: 76 declarations and 9 declarations restored on the two packages tested).

## Alternatives considered

- **The full solution plus host/client split** (the `dsh-git-graph` shape) for all seventeen packages: rejected. That split exists because the host and browser halves merge the same `Context` properties with different types (TS2717); none of the other packages hits that, so the extra program would only add files. It would also change the emitted set (the reference programs emit JavaScript next to the declarations) unless every program kept `emitDeclarationOnly`, and the reference `typecheck` (`tsc -b`) does not check tests at all — adopting it would have dropped the test typechecking these packages do today.
- **`--incremental` without `tsc -b`**, keeping the build script: rejected. The typecheck gains are similar, but on the declaration program a warm `tsc -p --incremental` took 0.48s against 0.08s for `tsc -b` on the same package, because `-b` also skips the emit pass.
- **Caches in `node_modules/.cache` for every program**: rejected for the declaration program, for the reason above.
- **Changing the `files` globs of all seventeen packages**: rejected once the three `tsdown`-only packages moved their typecheck cache out of `lib/`; `dsh-market` and `dsh-web-all` are the two packages whose `lib/` is committed, and their manifests stay untouched.

## Consequences

Warm `pnpm build` drops from about 6.0s to 3.0s (medians of three samples, alternating; the cold path is unchanged — clearing the caches reproduces the old profile at 6.9s and 7.7s). Warm `pnpm typecheck` dropped from about 7.6s to 5.1s with the incremental programs, and the 2026-10-14 native-compiler switch moved it again: measured back to back on ten cores, warm 7.66s → 2.63s and cold 13.95s → 4.64s for the whole tree (`pnpm -r typecheck`), with the three `tsc -b` packages holding the slower end. Per-package figures are compressed by pnpm's own constant startup (~1.4s per script invocation), so the tree-wide ratio is the meaningful number; on a four-vCPU runner the constant dominates more, which is why the CI step's own drop is smaller than this local ratio. The build adds 22 gitignored cache files under `packages/*/lib/`, and package tarballs stay cache-free (verified with `npm pack --dry-run --json --ignore-scripts` for all seventeen packages). Distribution is unaffected: the published `lib/` file sets match the previous runs except for the caches, and the committed `dsh-market` and `dsh-web-all` artifacts are byte-identical.

The recursion guard is the cache location: a package that adds declaration emit must keep `tsBuildInfoFile` inside `lib/`, or a deleted output can survive a "successful" build.

## Testing

`pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:scripts` (384 tests) and `pnpm aggregate:check` pass. `pnpm libs:check` fails on `dsh-web-all` for a source change made by another task, not for these files: every committed artifact under `packages/dsh-market/lib` and `packages/dsh-web-all/lib` is byte-identical before and after this change. A before/after snapshot of all 665 `packages/*/lib` files shows no file removed, the 22 caches added, and two `dsh-git-graph` cache files rewritten — which is the normal churn of a cache that already existed.

The 2026-10-14 compiler switch re-verified the typecheck path: per-package parity against `tsc` over the same project set and verdict (plus a deliberately poisoned project, which both compilers reject with the same diagnostic), a clean-room install with `--frozen-lockfile --ignore-scripts` proving no postinstall is needed (the binary arrives as a platform optional dependency), and `pnpm typecheck`, `pnpm test:scripts` and the rest of the repository gates green.
