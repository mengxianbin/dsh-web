/**
 * Pre-push gitlink guard: the pinned submodule commit must exist on the
 * satellite's remote before the pin can ship. A pin whose commit lives only in
 * this checkout builds from the local working tree and 404s on every fresh
 * clone, so the guard is the only place the mistake fails before it lands.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const GUARD = join(import.meta.dirname, 'git-pre-push-gitlinks.sh')
const SUBMODULE = 'satellites/dsh-skins'

/**
 * Git config treats a backslash as an escape character, so a Windows path
 * written into .gitmodules verbatim makes the file unparseable. Every path this
 * fixture hands to git as config or to bash as an argument is written with
 * forward slashes, which git and MSYS both accept.
 */
function slashy(path) {
  return path.replaceAll('\\', '/')
}

/** Run git in a fixture; a fixture that cannot run git is a broken test. */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function commit(dir, message) {
  git(['add', '.'], dir)
  git([
    '-c', 'user.email=fixture@example.com',
    '-c', 'user.name=fixture',
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message,
  ], dir)
  return git(['rev-parse', 'HEAD'], dir)
}

/**
 * A throwaway checkout carrying one submodule that pushed its commit to a
 * bare remote standing in for the satellite repository.
 */
function fixture({ push }) {
  const root = mkdtempSync(join(tmpdir(), 'gitlinks-guard-'))
  const bare = join(root, 'remote.git')
  git(['init', '-q', '--bare', bare], root)
  const inner = join(root, SUBMODULE)
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(inner, 'skin.json'), '{}\n')
  git(['-c', 'init.defaultBranch=main', 'init', '-q'], inner)
  commit(inner, 'pinned')
  git(['remote', 'add', 'origin', bare], inner)
  if (push) git(['push', '-q', 'origin', 'main'], inner)
  const sha = git(['rev-parse', 'HEAD'], inner)

  git(['-c', 'init.defaultBranch=main', 'init', '-q'], root)
  writeFileSync(
    join(root, '.gitmodules'),
    `[submodule "${SUBMODULE}"]\n\tpath = ${SUBMODULE}\n\turl = ${slashy(bare)}\n`,
  )
  git(['update-index', '--add', '--cacheinfo', `160000,${sha},${SUBMODULE}`], root)
  git(['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'pin'], root)
  return { root, inner, sha }
}

function runGuard(cwd) {
  return spawnSync('bash', [slashy(GUARD), 'origin', 'https://github.com/zhu1090093659/dsh-web.git'], { cwd: slashy(cwd), encoding: 'utf8' })
}

test('blocks a push whose gitlink pins a commit the satellite remote does not have', () => {
  const { root, sha } = fixture({ push: false })
  try {
    const result = runGuard(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /BLOCKED/)
    assert.match(result.stderr, new RegExp(`${SUBMODULE} pins ${sha.slice(0, 9)}`))
    assert.match(result.stderr, /git -C satellites\/dsh-skins push origin main/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('allows a push whose gitlink pins a commit the satellite remote already has', () => {
  const { root } = fixture({ push: true })
  try {
    const result = runGuard(root)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /BLOCKED/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stays silent outside a checkout with submodules', () => {
  const root = mkdtempSync(join(tmpdir(), 'gitlinks-guard-empty-'))
  try {
    git(['-c', 'init.defaultBranch=main', 'init', '-q'], root)
    const result = runGuard(root)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr.trim(), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
