# Agent Note: restart-signal build stamp for `pnpm build`

Status: implemented

## Problem

The harness host process needs a machine-readable baseline of which source state this repository's plugin libs were last built from (the restart-signal design's B stamp, harness `content/tech/ai/dsh/dsh-restart-signal-design.md` section two). The design lists `dsh-web pnpm -r build` as one of the production build entries that must record that baseline, but the manifest lives in the harness trees that load these artifacts, and the two repositories cannot share one build module. Without a mount here, a dsh-web-only change would leave every harness tree's baseline stale with no way to notice it.

## Decision

- `scripts/build-stamp.mjs run -- <command>` wraps the root `build` script: it captures S_start (repo-level state: HEAD, `git diff HEAD`, porcelain, untracked path/content; whole-repository content state for the host face), runs the command, and on success writes `.dsh-build/restart-stamp.json` (`kind: 'dsh-web'`, `midBuildDirty` when the content state moved during the build). A failed build leaves the previous manifest untouched.
- With `DSH_BUILD_STAMP_ACTIVE` already in the environment the wrapper is a pure passthrough: one opening/closing pair owns each build even when a harness-side stamped chain invokes this script.
- `.dsh-build/` is git-ignored; the harness host process reads this manifest through the profile `link:` dependency scan at startup and combines it with its own tree's manifest (capability gate: a linked repository participates only when it ships a stamp script).
- The manifest schema and the nested marker protocol mirror harness `scripts/restart-signal/build-stamp.ts`; changes to either side must move both.

## Alternatives considered

Writing the manifest into a harness checkout from here was rejected: it needs a machine-specific harness path (or a setx prerequisite) and would let one repository's build rewrite another repository's baseline file. Sharing one module across the repositories was rejected: neither repository vendors the other's scripts, and the harness side needs the TypeScript face-path walk that does not belong in this plain-Node toolchain.

## Consequences

`pnpm build` (and only successful runs) keeps the dsh-web host-face component fresh for the harness R stamp; a dsh-web source change without a rebuild reads as `INIT`/stale baseline on the harness side instead of silently passing. Per-package direct builds (`pnpm --filter <pkg> run build`) bypass the stamp and are documented as outside this entry inventory; the root `pnpm -r build` entry covers the production flow.

## Testing

Smoke on 2026-10-24: `node scripts/build-stamp.mjs run -- node --version` wrote a complete manifest (repo/host hashes present, `midBuildDirty: false`), the `DSH_BUILD_STAMP_ACTIVE=1` rerun passed through without rewriting, and `git status` no longer lists `.dsh-build/` after the ignore rule.
