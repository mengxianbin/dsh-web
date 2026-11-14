#!/usr/bin/env bash
# Pre-push guard: a satellites/ gitlink may not pin content that is not pushed.
#
# The market build reads the commit each satellites/<repo> gitlink records, and
# a fresh clone or CI materializes it through the tarball fallback, which
# addresses the commit by SHA on the satellite's remote. A gitlink that pins a
# commit living only in this checkout therefore works here and 404s everywhere
# else: the local market:fetch copies the submodule working tree, the local
# market:check stays green, and the failure first appears on a clone that never
# saw the commit. This guard is the only place that fails before the pin ships.
#
# Install into a checkout beside the origin guard. A checkout that already runs
# scripts/git-pre-push-guard.sh as .git/hooks/pre-push chains both, because git
# runs one hook file per event:
#   cp scripts/git-pre-push-guard.sh   .git/hooks/pre-push-origin
#   cp scripts/git-pre-push-gitlinks.sh .git/hooks/pre-push-gitlinks
#   printf '%s\n' '#!/usr/bin/env bash' \
#     'dir="$(git rev-parse --git-common-dir)/hooks"' \
#     'bash "$dir/pre-push-origin" "$@" || exit 1' \
#     'exec bash "$dir/pre-push-gitlinks" "$@"' > .git/hooks/pre-push
# A checkout without the origin guard installs this hook alone:
#   ln -sf ../../scripts/git-pre-push-gitlinks.sh .git/hooks/pre-push
#
# It is a diagnostic, not a gate: when it cannot prove the pin is broken - no
# git, a submodule directory that is not a checkout, no reachable remote - it
# stays silent and lets the push through rather than blocking on a guess.
#
# Hook arguments (git pre-push): <remote name> <remote URL>
set -uo pipefail

remote="${1:-}"
[ -n "$remote" ] || exit 0

node - "$remote" <<'JS'
const { spawnSync } = require('node:child_process')

const remote = process.argv[2]

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error !== undefined && result.error !== null) return null
  if (result.status !== 0) return null
  return result.stdout.trim()
}

const root = git(['rev-parse', '--show-toplevel'], process.cwd())
if (root === null) process.exit(0)

const modules = git(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], root)
if (modules === null || modules === '') process.exit(0)

const problems = []
for (const line of modules.split('\n')) {
  const match = /^submodule\.(.+)\.path (.+)$/.exec(line)
  if (match === null) continue
  const name = match[1]
  const submodule = match[2].trim()
  const dir = `${root}/${submodule}`
  if (git(['rev-parse', '--git-dir'], dir) === null) continue

  const pinned = git(['ls-tree', 'HEAD', '--', submodule], root)
  const pinMatch = /^160000 commit ([0-9a-f]{40})\t/.exec(pinned ?? '')
  if (pinMatch === null) continue
  const pin = pinMatch[1]

  const unpushed = git(['branch', '-r', '--contains', pin], dir)
  if (unpushed === null) continue
  if (unpushed !== '') continue

  // The submodule's own origin carries the content the pin names; .gitmodules
  // is the fallback for a checkout that renamed or dropped that remote.
  const configured = git(['config', '--file', '.gitmodules', '--get', `submodule.${name}.url`], root) ?? ''
  const url = git(['remote', 'get-url', 'origin'], dir) ?? configured
  const pushed = git(['ls-remote', '--heads', url, pin], dir)
  if (pushed !== null && pushed.includes(pin)) continue

  problems.push({ submodule, pin, url })
}

if (problems.length === 0) process.exit(0)

const lines = []
for (const problem of problems) {
  lines.push(`pre-push: BLOCKED - ${problem.submodule} pins ${problem.pin.slice(0, 9)}, which ${problem.url || 'its remote'} does not have.`)
}
lines.push('pre-push: The market build reads the pinned commit by SHA from the satellite')
lines.push('pre-push: remote, so a commit that exists only here builds locally and 404s on')
lines.push('pre-push: every fresh clone and in CI. Push the submodule first, then the pin:')
for (const problem of problems) {
  lines.push(`pre-push:   git -C ${problem.submodule} push origin main`)
}
process.stderr.write(`${lines.join('\n')}\n`)
process.exit(1)
JS
