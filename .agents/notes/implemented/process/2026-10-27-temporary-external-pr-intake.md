# Agent Note: Temporary external PR intake window

Status: implemented

## Problem

This repository closes every external pull request. `.github/workflows/reject-non-content-pr.yml` closes PRs outside the accepted content scope and redirects the four migrated content categories — skins / Skin Center, new pet listings, new preset listings, and community plugin index entries — to the satellite repository that owns each one, and `.github/workflows/reject-docs-pr.yml` closes documentation-only PRs. Both workflows act unconditionally for every author who is not a collaborator, so a maintainer cannot accept a well-formed outside submission without first disabling automation. The maintainer needs a bounded window in which external contributions are accepted while the standard policy, its ownership boundary, and its evidence gates stay exactly as they are.

## Decision

- Both closing workflows carry one explicit top-level switch, `ACCEPT_EXTERNAL_PRS`, read by each workflow from its own file; the window sets it to `'true'` and starts on 2026-10-27, and the maintainer closes it by hand.
- While the switch is `'true'`, both workflows leave a non-content external PR untouched: no comment, no close, no `setFailed`. A documentation-only PR is likewise left open.
- The four content contributions are unaffected by the switch: such a PR is still commented on, closed, and redirected to its satellite repository.
- The evidence gate `.github/workflows/pr-contribution-rules.yml` is unchanged, so a PR missing its template evidence is still commented on and asked to fill it in; it is not closed.
- Recovery is the switch back to `'false'`: both workflows then behave exactly as they did before the window, because the original interception logic is kept intact rather than replaced.
- Documentation states only the temporary status and the recovery step. The standard policy keeps its home in [the preset center satellite repository note](../architecture/2026-09-24-preset-center-satellite-repository.md) and is never reworded into "this repository now accepts external PRs".

## Alternatives considered

**Opening the repository permanently.** Rejected: the maintainer asked for a temporary window only, and the standard policy — content contributions in their own repositories, no direct external PRs here — is not meant to change. A permanent opening would rewrite the policy instead of suspending its automation.

**Deleting the two closing workflow files for the duration.** Rejected: restoring them means reverting commits, so the end of the window becomes a history operation instead of a two-line edit, and content-contribution redirection disappears for the whole window.

**A repository variable or an expiry date that restores the behaviour automatically.** Rejected: the maintainer account has no admin rights, so it cannot create a repository or organization variable, and an expiry date needs extra date logic in both workflows plus a reminder that is itself manual work.

## Consequences

- Recovery costs two edits: one switch line per closing workflow. Nothing else has to be reverted.
- After recovery this note moves to `.agents/notes/archived/`, because the shipped decision is finished once the window closes.
- PR volume rises during the window, and the maintainer triages it with `scripts/pr-review.mjs` and the required checks exactly as before.
