# Agent Note: Make mount-smoke artifact intent explicit

Status: proposed

## Problem

The mount smoke has two distinct questions, but its default answers a third hybrid one. CI must mount the checkout's artifacts; release must mount published artifacts. Without `FAMILY_TGZS_DIR`, the [rewriter](../../../../scripts/e2e-mount-rewrite#L159-L170) probes registry versions and silently replaces misses with newly packed workspace tarballs. A successful hybrid run does not by itself prove either the complete checkout or the complete published family.

## Proposal

Keep exactly two explicit intents at the smoke entry: checkout artifacts from a caller-supplied family tarball directory, or registry artifacts with no dependency rewrite. Use the existing `FAMILY_TGZS_DIR` as the checkout selector; absence means registry semantics, not automatic per-dependency fallback. Print the selected intent before mounting. CI keeps its existing pack stage; release keeps its published-registry gate and uses strict registry installation.

Remove automatic registry probes, semver-range resolution, implicit workspace packing, the auto-mode branch and pack-only state. Keep recursive rewriting for supplied checkout tarballs, caller-owned input immutability, missing in-repository tarball failure, cycle/cache handling, external satellite registry dependencies, tar portability and scratch-home/process cleanup. Do not call this deletion of the whole rewriter.

## Context & Efficiency Impact

This eliminates a publication-state-dependent selection policy, network probes and a second package-creation path. [CI](../../../../.github/workflows/ci.yml#L149-L166) already packs explicit checkout tarballs. [Release](../../../../.github/workflows/release.yml#L171) verifies publication before [mounting](../../../../.github/workflows/release.yml#L240). The replacement is a single intent branch, not another registry or pack orchestration framework. No prompt/tool schema changes are involved. The root `semver` dependency remains because other scripts use it; do not claim its removal as a saving.

## Evidence and ownership

- [Smoke entry documentation](../../../../scripts/e2e-mount.sh#L18-L33) describes automatic fallback and explicit full-checkout override. The auto-only producer path is `checkPublished` / `resolvesFromPublished` / `packWorkspace` at [rewriter lines 47–90](../../../../scripts/e2e-mount-rewrite#L47-L90), then `ensurePackedTgz` at [lines 213–255](../../../../scripts/e2e-mount-rewrite#L213-L255).
- The supplied-tarball path at [lines 141–158](../../../../scripts/e2e-mount-rewrite#L141-L158) and [lines 259–294](../../../../scripts/e2e-mount-rewrite#L259-L294) is separately reachable. It keeps external satellites on npm and fails loudly when an in-repository package lacks its supplied tarball. The [test suite](../../../../scripts/e2e-mount-rewrite.test.mjs) exercises both paths and recursive dependencies.
- The [checkout smoke owner](../../implemented/testing/2026-09-23-plugin-mount-smoke-local-tarballs.md) explicitly retains checkout artifacts for CI and registry artifacts for release. Both commitments survive. The [tar capability decision](../../implemented/bug-fix/2026-10-03-windows-tar-force-local-capability-probe.md) and [scratch-home safety decision](../../implemented/bug-fix/2026-09-23-scripts-cannot-delete-the-ambient-dsh-home.md) remain binding.
- Active proposed/implemented/rejected searches found no current owner that requires hybrid mode after explicit CI checkout packing. This would narrow the smoke interface, not supersede the owner's other benchmark, isolation or cleanup decisions. Existing records are retained; supersession can occur only after implementation and review of their remaining obligations.

## Alternatives considered

Keep the hybrid default: its strongest reason is convenient success during a publication window while retaining already-published siblings. This is a real used capability, not dead code; the proposal knowingly gives it up.

Make every smoke checkout-only: rejected because a release must prove consumers can install published artifacts, and external satellite packages do not belong to this checkout's workspace pack set.

Add a third strict-registry flag while keeping auto mode: deferred because it improves intent reporting but deletes none of the automatic probe/packer lifecycle. Moving auto mode to another script would relocate rather than remove its cost.

## Acceptance criteria

- CI still mounts current in-repository checkout tarballs and detects a broken build; release never substitutes workspace artifacts after a registry miss.
- Calls without a supplied family directory leave packed dependencies intact and visibly report registry intent; a missing published dependency fails installation.
- Supplied directories stay read-only; missing local workspace tarballs fail, external satellite dependencies retain registry specs, and nested/cyclic family graphs retain the current correct behavior.
- Delete auto-only exports, probe/packer tests and pack-only state; retain recursive copy/rewrite, platform-tar and scratch-safety tests. Do not add a duplicate CI pack stage for local convenience.
- Update the smoke contract and owning notes only where behavior changes; pass `pnpm test:scripts` and baseline gates, then exercise both intents in isolated owned scratch homes against the supported host.

## Risks

Local users who relied on transparent publication-window fallback must now choose checkout artifacts explicitly or wait for registry publication. Network/projection lag becomes a visible registry failure, which is the intended release verdict. Nested supplied-tarball recursion still needs reservation and cleanup; deleting its lifecycle under the label of auto-mode cleanup would be incorrect. This is a behavior-narrowing proposal, not implementation authorization.
