# Agent Note: A gitlink may not pin satellite content that is not pushed

Status: implemented

## Problem

The market build reads the commit each `satellites/<repo>` gitlink records, and a checkout that never initialized the submodules materializes that commit through the tarball fallback, which addresses it by SHA on the satellite's remote. A gitlink that pins a commit living only in the local checkout therefore builds correctly here and fails everywhere else: `pnpm market:fetch` copies the submodule working tree whenever it sits on the pinned commit, `pnpm market:check` reports the committed `market/dist` consistent, and the first failure appears on a fresh clone or in CI as an `HTTP 404` for a commit that remote never received. [CONTRIBUTING.md](../../../../CONTRIBUTING.md) names pushing the satellite commit as step 2 of the three-step pin flow and calls it the most hidden omission; nothing failed locally when it was skipped, so a review had to notice it by reading the pin.

## Decision

`scripts/git-pre-push-gitlinks.sh` runs as a pre-push hook and blocks a push whose staged `satellites/` gitlink pins a commit the satellite's remote does not carry.

- It reads the pin from `git ls-tree HEAD`, so a bump committed but not yet pushed is judged on what the push will actually carry.
- A pin already reachable from a remote-tracking ref is accepted without a network call; anything else is confirmed with one `git ls-remote --heads <url> <sha>` against the submodule's own `origin`.
- A failure names the submodule, the abbreviated pin and the remote, and prints the command that fixes it: `git -C satellites/<repo> push origin main`.
- The hook is a diagnostic, not a gate. When it cannot prove the pin is broken — no `node`, a submodule directory that is not a checkout, no resolvable URL — it stays silent and lets the push through rather than blocking on a guess.

## Alternatives considered

**Extend `scripts/git-pre-push-guard.sh`, which already runs as `.git/hooks/pre-push`.** Rejected: that guard answers one question — does `origin` still resolve to the canonical repository — and its failure mode is a wrong repository. Folding a network probe into it would make the cheap structural check depend on the expensive one, and a checkout that only wants the origin guard would have to accept both. The new hook chains beside it instead.

**A `pnpm` script run by hand before pushing.** Rejected: the failure it prevents is an omission, and a check a maintainer must remember to run is omitted in exactly the case it exists for. The same reasoning rules out documenting the step harder: the three-step flow is already written down and still produced this gap.

**Judge the pin against the local remote-tracking refs only, with no network call.** Rejected: it misses the case that matters most, a satellite commit pushed from a different clone. It stays as the fast path that skips the network when the answer is already known.

**Make it a hard gate that blocks when git or the submodule is unavailable.** Rejected: a pre-push hook that cannot run would then block every push from a checkout that never initialized the submodules, which is the supported default. A check that cannot see the state has no business blocking on it.

## Consequences

- The gap CONTRIBUTING.md describes is now caught locally, before the pin reaches `dev`. The documentation keeps the step; the hook is what fails when it is skipped.
- Pushing a satellite commit and then the pin in one session costs one extra `git ls-remote` round trip. A pin whose commit is already on the remote costs none.
- The hook needs `node` on `PATH`. It inherits the environment of whoever runs `git push`, and the repository's other tooling already requires the same runtime.
- Installing it is opt-in per checkout, like the origin guard: `ln -sf ../../scripts/git-pre-push-gitlinks.sh .git/hooks/pre-push`, or chain both guards as the script header shows. A fresh clone without the hook behaves as before.
- Verification: `node --test scripts/git-pre-push-gitlinks.test.mjs` covers the blocked pin, the accepted pin and a checkout with no submodules against throwaway repositories; the hook was also run against this checkout with a real pin moved to a local-only commit, where it blocked, and again after the pin was restored, where it passed silently.
