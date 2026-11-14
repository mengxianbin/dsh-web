# Agent Note: Make each package's invariant companion match what it ships

Status: implemented

Superseded on the invariant surface by [sdk-cohort-0.2.1-rc.2](../architecture/2026-10-17-sdk-cohort-0.2.1-rc.2.md): the 0.2.1 line removed the runtime invariants registry upstream (`@deepseek-ai/dsh-invariants` publishes no 0.2.1 release), so the family deleted its last two companions — `dsh-git-graph` and `dsh-remote-web-ui` no longer declare `./invariant`, ship `src/invariant.ts`, or depend on the registry — and no family package declares the subpath anywhere. `scripts/family-dsh-engines.test.mjs` now fails the build if a manifest regresses. What still holds: the note's core rationale (a declared subpath must resolve to what it claims, never a silent no-op) and the audit below as the record of the six-package state this note fixed.

## Problem

`@deepseek-ai/dsh-invariants` is the official registry for package-owned runtime checks: any package may ship a `./invariant` companion, companions register under their package's exact npm name through `ctx.invariants`, and a composition that mounts the registry decides which of them run. Six family packages declare that subpath. Four of the six cannot do what the declaration promises.

| Package | `src/invariant.ts` | `lib/invariant.js` emitted | Registers with the registry |
| --- | --- | --- | --- |
| `dsh-git-graph` | yes | yes | yes — `name`, `inject: ['invariants']`, `apply` registers a documented no-op installer |
| `dsh-remote-web-ui` | yes | yes | yes — the same shape |
| `dsh-ssh` | yes, 4 lines | yes | no — `export function apply(): void {}`, no `name`, no `inject`, no registration |
| `dsh-task-board` | yes, 4 lines | yes | no — the same stub |
| `dsh-session-id` | yes, 2 lines | no — tsdown builds only `src/index.ts` | no — the same stub |
| `dsh-i18n` | no | no | no — the export has no source at all |

The two packages that emit nothing publish a subpath that cannot resolve: a composition mounting `@linxin666/dsh-client-ui-session-id/invariant` or `@linxin666/dsh-i18n/invariant` gets a module-resolution error rather than a check, and neither package's build ever produced the file. The two stubs do resolve, but mounting them runs an `apply` that never touches the registry, so the composition silently gets no check either.

`scripts/plugin-template` keeps the defect alive: it emits the same `./invariant` export block while scaffolding only `src/index.ts` and `src/client/index.ts`, so every new package starts where `dsh-i18n` is. The shared preset's own comment (`shared/tsdown.client.ts:139-141`) says the node-half entry list is "spelled at the call site so the package-invariants gate can see `src/invariant.ts` … in each package's own tsdown.config.ts", but no such gate exists in this repository, which is how `dsh-session-id` and `dsh-i18n` drifted.

The web profile composes no invariants service (the git-graph companion's header records it), so none of the six loads in this deployment. The surface still matters twice: to compositions that do mount the registry, and as the npm contract each package publishes.

## Decision

Six of the family packages declared the `./invariant` subpath and four of them could not serve it. Those four declarations are gone: `dsh-i18n` (which never had a source), `dsh-session-id` (which never emitted the file), and `dsh-ssh` and `dsh-task-board` (whose four-line stubs never registered anything). Their `src/invariant.ts` files are deleted and `dsh-ssh` and `dsh-task-board` no longer list the entry in their tsdown configs.

The two working companions stay: `dsh-git-graph` and `dsh-remote-web-ui` keep the cordis shape — `name`, `inject: ['invariants']`, and an `apply` that registers an installer through `ctx.invariants` — and both still emit `lib/invariant.js`. (Update 2026-10-17: this sentence records the state this note shipped; the 0.2.1-rc.2 cohort adaptation removed both companions with the upstream registry — see the supersession note above.)

`scripts/plugin-template` no longer scaffolds the export block, so a new package cannot start in the state `dsh-i18n` was in, and `shared/tsdown.client.ts` no longer claims a package-invariants gate this repository does not implement. `packages/AGENTS.md` states the obligation in its place: a package that declares `./invariant` must publish a companion the registry can load. (Update 2026-10-17: the `packages/AGENTS.md` obligation paragraph was removed with the convention in the 0.2.1-rc.2 adaptation; the durable gate the shared-preset comment imagined now exists as `scripts/family-dsh-engines.test.mjs`, which asserts the subpath stays gone.)

## Context & Efficiency Impact

The change is small — four stub files, six manifests, one template, one comment — and removes no capability this deployment has, because no invariants service is mounted here. It changes what the packages promise rather than what they do at runtime.

The gain is that the subpath stops meaning two different things: after the change, a package that declares `./invariant` is one a composition can actually mount, which is also the only way the convention stays usable when a composition wants to check a family package.

## Evidence

- The official contract: `@deepseek-ai/dsh-invariants` README ("any package can ship a `./invariant` companion that verifies its own durable relationships") and its `lib/index.js` (the registry service registers companions by package name).
- Per-package verification of all six rows: `package.json` `exports['./invariant']`, the presence of `src/invariant.ts`, the entry list in `tsdown.config.ts`, and `lib/invariant.js` on disk after the last build (present for four packages, absent for `dsh-session-id` and `dsh-i18n`).
- The two stubs (`packages/dsh-ssh/src/invariant.ts`, `packages/dsh-task-board/src/invariant.ts`) are four lines each with no `name`, no `inject` and an empty `apply`; `packages/dsh-session-id/src/invariant.ts` is a two-line variant of the same.
- The scaffold: `scripts/plugin-template/package.json` declares `./invariant`, `scripts/plugin-template/tsdown.config.ts` builds `['src/index.ts']`, and `scripts/plugin-template/src/` contains only `index.ts` and `client/index.ts`.
- No repository code imports `./invariant`: a search over `packages/*/src`, `packages/*/tests` and `scripts/` returns only the self-declarations. The aggregate manifest has no companion row, and the installed DSH archive is not searchable from this session, so the loader's side of the convention rests on the official package's own documentation.

## Alternatives considered

- **Keep all six declarations and treat the companion as a seam declared for future checks.** Rejected: two of them cannot resolve at all, and the others register nothing, so a composition that mounts them gets a module error or a silent no-op instead of the check the declaration advertises.
- **Convert every stub to the real cordis shape.** Rejected as the default: it adds a registration that installs no checks — the shape without the content. It is the right answer only for a package that expects checks soon and wants the seam declared; the proposal leaves that choice per package.
- **Drop the convention from the repository entirely**, including the two working companions, the template block and the shared-preset comment. Rejected: `dsh-git-graph` and `dsh-remote-web-ui` ship companions the registry can load, and the convention is official; the loss would be the one seam a composition uses to check a family package. (Update 2026-10-17: this alternative later happened anyway, from the upstream side — the 0.2.1 line removed the registry, so the convention left with it rather than by family decision.)
- **Only fix the template.** Rejected as insufficient: it stops new packages inheriting the defect while leaving the current four exactly as they are.

## Testing

- Every package that declares `./invariant` either ships a companion the registry can load — `name`, `inject: ['invariants']`, an `apply` that registers an installer, and `lib/invariant.js` in its build output — or does not declare the subpath.
- A package scaffolded by `scripts/plugin-new` starts in one of those two states, and the template's README and AGENTS text describe what it builds.
- `pnpm -r build` emits `lib/invariant.js` for exactly the packages that declare the export; `pnpm typecheck`, `pnpm test` and `pnpm docs:check` pass; the shared preset's comment no longer names a gate this repository does not implement, or the gate exists.

## Risks

- Dropping the subpath from a published package is a semver-visible change for third parties, so it lands with a release rather than as a patch; `dsh-session-id` and `dsh-i18n` already fail such an import, which limits the exposure to a caller that was already broken.
- A composition that mounts `dsh-ssh`'s or `dsh-task-board`'s stub gets a silent no-op today and a resolution error after a deletion. That is why the proposal offers "delete or implement" per package instead of deleting all four, and the owner's answer decides.
- If checks are later added to a package that dropped its declaration, the export and the build entry have to come back together; the acceptance criteria of the scaffold fix are what keep that from being forgotten.
