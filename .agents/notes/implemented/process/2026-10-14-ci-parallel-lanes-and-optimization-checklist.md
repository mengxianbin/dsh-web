# Agent Note: CI runs its required checks as parallel lanes, and CI work follows one checklist

Status: implemented

## Problem

Every required check was one serialized job. `CI checks` ran the three text rules, the type program, the build, the whole workspace suite and eight consistency gates as steps of a single 2m44s job, although those steps share nothing but the checkout: the text rules read hand-written sources and need no dependencies at all, the consistency gates compare committed artifacts, and the suite reads the committed `lib/` bundles. The second required check, `plugin-mount` (2m24s), re-downloaded its pinned DSH CLI on every run — 32s of it — and any job could sit on a stalled `git fetch` until its 30-minute timeout, because nothing bounded the clone.

The repository also had no recorded answer to the standard CI questions: faster runners, a native type checker, a linter, shallow or filtered checkouts, dependency caches, test sharding, shared module state. Each was re-litigated per task, and a change that trades runner minutes for latency had no stated frame to be judged against — which matters here because the repository is public, so standard runner minutes are free while wall-clock latency is the metric contributors feel.

## Decision

`ci.yml` runs its required checks as three independent lanes plus one fan-in job:

| job | name | content |
| --- | --- | --- |
| `static-checks` | Static checks | elastic checkout, actionlint, setup, the three text rules **before** `pnpm install`, install, lint, typecheck, build |
| `unit-tests` | Unit tests (`shard: [1,2,3,4]`) | elastic checkout, setup, install, `node scripts/test-shard.mjs <shard> 4` — no build |
| `consistency` | Consistency gates | elastic checkout, setup, install, then sync-shared, libs, aggregate, docs, runtime-deps and script tests — never builds |
| `ci` | **CI checks** (unchanged name) | `if: always()`, `needs` the three lanes, fails unless every `needs.<job>.result` is exactly `success` |
| `plugin-mount` | (unchanged) | unchanged behavior, plus the elastic checkout and a cached pinned DSH CLI |
| `contribution-evidence` | Validate PR contribution evidence | unchanged |

`nightly.yml` keeps its two Tier-2 jobs and gains the elastic checkout; `release.yml` keeps its gated publish lane and gives `verify-release` the elastic checkout and the same cached CLI.

The required context names are frozen by the repository ruleset `integration-branch-policy` — `CI checks`, `plugin-mount`, `Validate PR contribution evidence`, `guard-agent-notes` — so the fan-in job carries the old name instead of the lanes becoming new required contexts, and the aggregate check is explicit rather than left to `needs` defaults: a skipped or cancelled lane must never satisfy a required check.

`windows.yml` sits outside all of this and outside the required checks: its single job `Windows smoke` runs on `windows-latest` for a push to `dev` or `main` and for `workflow_dispatch`, installs the workspace with `--frozen-lockfile --ignore-scripts` and runs the `@linxin666/dsh-remote-bridge` and `@linxin666/dsh-client-ui-browser-view` suites with no build, because the only platform-colored change in v0.4.9 — the serial `#writeQueue` in `packages/dsh-remote-bridge/src/core/devices.ts`, through which roster writes are fed because Windows rejects overlapping renames — had never executed on Windows while every other lane runs on `ubuntu-latest`. It renames no job and is not named in any `needs`, so the four frozen contexts keep their meaning and the required wall clock does not move; it advances none of the checklist items below — each measures the required check's latency or runner cost — and the workflow header carries the per-item answers.

### Why each placement is where it is

- **The text rules run after `pnpm install`, not before it.** Running any `pnpm` script in a tree with no `node_modules` makes pnpm perform a whole workspace install of its own before the script starts. Measured on a runner: `Scope: all 19 workspace projects` … `Packages: +429` … `added 429, done`, with 21.7s elapsing before the audit script itself began (24s for the step, 34s on a slower runner, against 1s in the pre-change baseline where the step ran after the install); in a scratch copy the same gate took 33.99s with `node_modules` absent and 5.01s with it present, while the raw script takes about a second either way. That implicit install also ran with pnpm's own flags instead of the lane's `--frozen-lockfile --ignore-scripts`, so "fail fast before the install" was both slower and less controlled. The rules keep the position where the fast failure is worth having: above Typecheck and Build.
- **The build belongs to `static-checks`, and the shard lanes do not build.** The only suites that read built output (`packages/dsh-web-all`) load the committed `lib/` artifacts that a fresh clone already has, and `libs:check` independently ties those artifacts to the committed sources. Measured: in a tree whose `lib/` proved byte-identical to `HEAD`, all eighteen suites passed with no build at all.
- **`consistency` never builds.** `libs:check` fingerprints committed artifacts against the committed sources; a build in the same working tree would replace them first and mask exactly the stale commit the check exists to catch. Separate jobs each get a clean checkout, so the guarantee no longer depends on step order inside one job.
- **Sharding is derived, not listed.** `scripts/test-shard.mjs` enumerates the test-bearing workspace packages from `pnpm-workspace.yaml` and partitions them longest-processing-time first over a checked-in weight table. The union is exactly the set `pnpm -r test` covers, disjoint and deterministic, asserted by `scripts/test-shard.test.mjs` inside `pnpm test:scripts` — including a cross-check against pnpm's own workspace view. A stale weight costs balance, never coverage.
- **Two suites in flight per shard.** Each suite runner already fans out over several cores, so in-flight suites bound oversubscription on a four-vCPU runner; this also matches the bounded-concurrency convention the coverage gate already uses.
- **Elastic checkout.** Three-minute first attempt with `continue-on-error`, a partial `.git` removed on failure, one five-minute retry. The block is inlined in every job that checks out because `timeout-minutes` is not a legal step key inside a composite action (official metadata syntax; [actions/runner#1979](https://github.com/actions/runner/issues/1979)), so it cannot be factored into one shared action.
- **The mount lane installs the pinned CLI at job time and guards it.** Three cheaper alternatives were measured on this change's own pull request and rejected. A prefix install behind `actions/cache` cost 41-44s cold against 32s for the plain global install, and a pull-request-scoped cache does not restore on a first run (a `workflow_dispatch` run logged `Cache not found for input keys: dsh-cli-Linux-0.2.0-rc.2`). The CLI as a workspace devDependency does not run in this tree at all: `dsh-app-boot` imports `@deepseek-ai/cordis-plugin-group` while declaring it only as a peer, and this workspace sets `autoInstallPeers: false`, so the CLI exits with `ERR_MODULE_NOT_FOUND`; satisfying that peer, as a root devDependency or as the repository's documented `packageExtensions` entry, deterministically fails `packages/dsh-web-all`'s `tests/shell-config-surface.spec.ts`, which is a separate change's problem. What remains is the pin as one `DSH_CLI_VERSION` entry per workflow plus a guard that fails unless `dsh` resolves and `dsh --version` prints exactly that pin — the smoke falls back to an unpinned `npx` when `dsh` is missing, and the version, not the path, is the check that cannot pass on the wrong CLI.
- **A resolver guard for the CLI.** `scripts/e2e-mount.sh` falls back to `npx -y --package @deepseek-ai/dsh` when `dsh` is not on `PATH`, which would test an unpinned CLI; a step now fails when `dsh` does not resolve into the cached prefix, so a layout change cannot weaken the smoke silently.
- **Native typecheck.** Fifteen packages run their typecheck program under `tsgo` (the native compiler), verified package by package to produce the same project set and the same verdict as `tsc`. The three packages whose `typecheck` is `tsc -b` keep `tsc`: build mode emits, tsgo's output is not byte-identical (printer quote style), and its `tsbuildinfo` cannot be reused by the build's `tsc -b`, so switching them made the build slower than the typecheck gained.

### The CI checklist

Every CI change states which item it advances, or why the item does not apply here. Item numbers refer to the checklist this repository adopted.

| # | item | verdict |
| --- | --- | --- |
| 1 | Faster runners | **Not applicable.** Public repository on a free personal account: standard runners are free, while larger runners require an organization on Team or Enterprise Cloud and are billed per minute regardless of visibility. Revisit only with an org plan. |
| 2 | Native type checker | **Applied.** Fifteen packages on `tsgo`; warm `pnpm typecheck` locally 7.66s before, 2.63s after. |
| 3 | Type-free lint rules | **Applied.** The gate set was already syntax-only scripts with no type program; Oxlint joins them as the linter, configured on the correctness, suspicious and performance categories, none of which needs type information. |
| 4 | Oxlint | **Report-only for now.** The static lane runs `pnpm lint` in a step that tolerates a non-zero exit. The scoped scan covers 966 hand-written files and reports 892 findings across 37 rules — far past what could be fixed and verified inside a CI change — so the step reports the count and blocks nothing. The script prints in `--format=unix` because oxlint's implicit GitHub formatter emitted one `##[error]` annotation per finding against a green run, which buries real failures; `unix` keeps every finding visible as `file:line:col: message` at 900 lines instead of 12170 for the code-frame format. Four rules are off with recorded cause: `unicorn/no-array-sort` (the type program pins `lib: ["ES2022", …]`, `Array#toSorted` is ES2023, and no call site exists), `eslint/no-underscore-dangle` (every hit is a `__`-prefixed global or build placeholder, and the rule targets member access), `unicorn/require-module-specifiers` and `import/no-empty-named-blocks` (both fire on the repository's ambient-augmentation idiom `import type {} from '<pkg>'`). Follow-up: triage by rule, fix the defect-shaped leaders (`no-await-in-loop` 189, `consistent-function-scoping` 167, `no-unused-vars` 112, `promise/always-return` 75, `no-shadow` 75) and then make the step blocking, or adopt the baseline ratchet `scripts/test-standards.mjs` already uses so findings may only decrease per file. |
| 5 | Lighter checkout | **Already satisfied.** `actions/checkout` defaults to `fetch-depth: 1`, eleven of sixteen workflows never check out at all, and only `release.yml` asks for full history (its release notes walk back to the previous tag). |
| 6 | Elastic checkout | **Applied.** Bounded first attempt plus one retry in every checkout of `ci.yml`, `nightly.yml` and `release.yml`. |
| 7 | Cache writes off the critical path | **Already satisfied.** `setup-node`'s pnpm-store save and `actions/cache` saves run in the post-job phase; no lane waits on a cache write. |
| 8 | Pre-install into the CI image | **Not applicable as written** — no CI image is built here. Its analogue was measured and rejected: caching the pinned CLI install behind `actions/cache` made the mount lane slower on a cold run (41-44s against 32s for the plain install) and the cache never restored on a first run of a pull request. |
| 9 | Filtered install | **Not applicable.** Every lane needs the full workspace graph (`pnpm -r typecheck`, `-r test`, build), and a warm store already installs in 3s; a filter would add a second resolution mode without removing any gate's need. |
| 10 | Drop an expensive cache | **Evaluated, kept.** The item's rule is to measure before keeping a cache; measured here, a warm pnpm store turns the install into 3s, so the cache is a win rather than the liability it was for the source list. The same rule then rejected a cached CLI install (41-44s cold against a 32s plain install). |
| 11 | Schema snapshot instead of migration replay | **Not applicable.** No lane starts a database or replays migrations. |
| 12 | Batch small checks | **Applied, inverted.** The eight consistency steps were already batched into one job; because standard minutes are free here, the trade runs the other way — one frozen required context while the heavy independent work runs as parallel lanes. The four-shard lane plus the fan-in keep the run at nine job records, which is the budget consideration that stopped a fifth lane for the build. |
| 13 | Balanced shards | **Applied.** Four shards over a measured weight table (per-shard weight 29/30/29/30s against 118s total), so the heaviest suites no longer queue behind each other. |
| 14 | Shared module state between test files | **Not applied.** Vitest's per-file isolation is the suites' correctness boundary, and the workspace suite is already under the Tier-1 budget; the equivalent win here came from sharding wall time. Revisit if the suite outgrows the budget. |
| 15 | Shards past the setup boundary | **Applied.** Setup is ~12s per lane, so a shard costs one checkout, one setup and one install while the required wall clock is now bounded by the static lane rather than by the suite. |

## Measured effect

Baseline on `origin/dev` (run 38499514986): `CI checks` 164s, `plugin-mount` 144s, run wall 168s. Two real runs of this change's pull request (38506503973 and 38506816812):

| measured | baseline | run 1 | run 2 | run 3 (both fixes) |
| --- | --- | --- | --- | --- |
| the serialized gate job | `CI checks` 164s | `Static checks` 135s (a 47s checkout and a 34s text-gate step on a slow runner) | `Static checks` 92s | `Static checks` 71s |
| `plugin-mount` | 144s | 157s (44s cold CLI install) | 165s (41s cold CLI install) | 143s (36s CLI install) |
| the required context | 164s | aggregator 4s | aggregator 2s | `CI checks` 73s (71s lane + 2s aggregator) |
| the other lanes | (steps of the one job) | 39-53s shards, 33s consistency | 46-80s shards, 38s consistency | 47-57s shards, 33s consistency |
| run wall clock | 168s | 161s | 170s | 147s |

The restructure moved the required-check work out of one 164s serialized job, and the first two runs showed no wall-clock win, because the run is bounded by `plugin-mount` and the two things that made that lane slower than baseline were exactly the two ideas this change had to retract: the text gates running before the install (24-34s) and the cached CLI install being cold (41-44s). Run 3 carries both fixes — the install now precedes the gates, and the mount lane is back to the plain pinned install with a version guard — and measures `CI checks` at 73s against 164s and the run at 147s against 168s. The required check is 55% shorter and the run 12% shorter, and the bound has moved to `plugin-mount` (143s, of which the CLI install is 36s and the mount smoke 36s): the next win needs the `dsh-app-boot` peer collision fixed so that CLI install can move into the workspace install, which is the follow-up this work hands over. The structural win stands on its own: no further gate lengthens the required check linearly.

A fourth run, carrying only a documentation commit, measured 173s with `Static checks` at 86s and `plugin-mount` at 169s; its extra time sits in a 36s checkout and a 31s build rather than in any step this change introduced. So the wall-clock gain is 147s on the best of four runs against a 168s baseline, inside roughly twenty-five seconds of shared-runner variance, and the robust results are the required-check job (71-86s against 164s) and the emoji step (1s once the install precedes it, against 24-34s when it did not).

## Alternatives considered

- **Keep one job and tune its steps** (front-load the text rules, raise the test concurrency): rejected because the steps are independent and serialization itself was the largest cost; it would have left the build, the type program and the suite queued behind each other.
- **Give the lanes their own names and make all three required contexts**, updating the ruleset: rejected because it makes a repository-settings write part of every future CI change and multiplies the contexts to keep in sync; the fan-in job keeps the public contract stable at one name.
- **A matrix for the three lanes instead of separate jobs**: rejected because each lane needs its own timeout and its own named failing step, and a matrix leg cannot express the different needs.
- **A composite action for the elastic checkout**: rejected on evidence — `timeout-minutes` is not among the legal composite step keys, so the timeout that makes the retry meaningful cannot live there.
- **Sharding deeper than four, or a separate build lane**: rejected because the required wall clock is now bounded by the static lane, so extra jobs add concurrency pressure (free-account job budget) without shortening the check.
- **`tsgo` for the three `tsc -b` packages too**: rejected on measurement — the typecheck gain (914/1191/645ms to 212/315/181ms) is smaller than the build's loss once its cache cannot be reused (121/120/118ms to 973/1215/657ms), and the emitted bytes change.
- **Removing the pnpm-store cache**: rejected on measurement; the install is 3s warm.
- **`isolate: false` to share module state across test files**: rejected — the suite is small enough that the wall-clock gain does not pay for the cross-test contamination risk the isolation currently rules out.

## Consequences

The required wall clock is now `max(static lane, slowest shard, consistency) + fan-in` instead of the sum of the gates, so adding a gate no longer lengthens the check linearly. The cost is runner minutes: nine job records per run instead of three, which is free on a public repository's standard runners and would be a real cost on a private fork — the trade is valid only while that holds, and a move to a private repository means revisiting item 12.

The Windows lane spends one job record per qualifying push — free on a public repository's standard runners and off the required path — and it buys its coverage after the merge: a Windows-only regression surfaces on `dev` or `main` rather than on the pull request that carries it, because the lane is not a required context.

The fan-in job reports no gate detail itself, so a reader must open the lanes to see which gate failed; the lanes carry the named steps for that reason. `scripts/test-shard.mjs` must be re-measured when a suite changes materially, but a stale weight can only unbalance the shards, never drop a package from the run.

The new lint gate already produced a real finding: `shared/tsdown.client.ts` carries a `readonly` modifier on a non-array type (TS1354) at lines 131 and 168, while `shared/tsconfig.json` includes only `client`, `host`, `core` and `types`, so the type program never checks that file. The error is inert today (the compiler ignores the modifier and the bundler strips types), so it stays unfixed here rather than dragging a build-preset edit and a full `libs:write` refresh into a CI change; it belongs to a separate change that also widens the type program over the shared root.

## Testing

Local, before the change shipped: `pnpm typecheck`, `pnpm test:standards`, `pnpm i18n:check`, `pnpm emoji:check`, `pnpm docs:check`, `pnpm sync-shared:check`, `pnpm libs:check`, `pnpm aggregate:check`, `pnpm runtime-deps:check` and `pnpm test:scripts` all pass; `scripts/test-shard.test.mjs` passes 15/15, including the completeness cross-check against pnpm's own workspace view, and the four dry runs assign all eighteen packages once each at 29/30/29/30s. The never-built experiment (a scratch tree whose `lib/` proved byte-identical to `HEAD`) ran all four shards green with no build. `/opt/homebrew/bin/actionlint` reports zero findings across all fifteen workflows after the restructure. The four shards ran end to end on a quiet machine at 15.1s, 12.4s, 12.3s and 14.6s with all eighteen packages green, and `pnpm lint` reports its 892 findings and exits non-zero by design, which the static lane's step tolerates.

The unbounded `pnpm -r test` path is load-sensitive: under full parallel load it hit the five-second test timeout in `dsh-task-board` and, on a later run, in `dsh-liangshen`. Both packages pass in isolation and inside the bounded shard run, and the failures reproduce the behaviour the coverage gate's bounded concurrency and this lane's shard concurrency already exist to contain; no source or test file changed in this work.
