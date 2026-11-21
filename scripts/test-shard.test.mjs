/**
 * Specification for the CI shard partition (scripts/test-shard.mjs): the
 * workspace glob parser, the enumeration, and the four properties the unit
 * lane depends on — completeness, disjointness, determinism and balance.
 *
 * Completeness is checked twice on purpose: against a fixture workspace that
 * exercises the weight lookup, and against the package manager's own view of
 * the workspace (`pnpm ls -r --depth -1 --json`), which does not share the
 * glob parser under test and therefore catches a silently dropped package.
 *
 * The end-to-end lane itself is `node scripts/test-shard.mjs <shard> 4`.
 */
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_WEIGHT_SECONDS,
  PACKAGE_WEIGHTS,
  expandWorkspaceGlobs,
  listTestPackages,
  parseWorkspaceGlobs,
  partitionShards,
  shardWeight,
} from './test-shard.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHARD_TOTAL = 4

/** Balance band: every shard stays within a quarter of the mean weight. */
const BALANCE_TOLERANCE = 0.25

function makeFixtureWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-test-shard-'))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'shared'\n  - 'packages/*'\n")
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true, scripts: { test: 'echo root' } }),
  )
  const manifests = [
    ['shared', { name: 'fixture-shared', scripts: { test: 'echo shared' } }],
    // A directory that is in the weight table, so the lookup is exercised.
    ['packages/dsh-ssh', { name: 'fixture-known', scripts: { test: 'echo known' } }],
    // A directory that is not, so the default weight is exercised.
    ['packages/fixture-unknown', { name: 'fixture-unknown', scripts: { test: 'echo unknown' } }],
    // No test script: a workspace member the shards must not carry.
    ['packages/fixture-untested', { name: 'fixture-untested', scripts: { build: 'echo build' } }],
  ]
  for (const [dir, manifest] of manifests) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest))
  }
  // A directory selected by the glob but holding no manifest (the shape of
  // packages/dsh-tool-describe-image in this repository).
  mkdirSync(join(root, 'packages/fixture-manifestless'), { recursive: true })
  return root
}

/** Test-bearing workspace packages, enumerated by pnpm rather than by our parser. */
function workspaceTestDirsViaPnpm() {
  // win32: Node refuses to spawn a .cmd without a shell (EINVAL), so the shim
  // needs both the explicit name and the shell, the same pair
  // scripts/e2e-mount-rewrite uses for `pnpm pack`.
  const listed = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  assert.equal(listed.status, 0, `pnpm ls -r --depth -1 --json must succeed: ${listed.stderr}`)
  const start = listed.stdout.indexOf('[')
  const end = listed.stdout.lastIndexOf(']')
  assert.equal(start >= 0 && end > start, true, `pnpm ls must print a JSON array, got: ${listed.stdout.slice(0, 200)}`)
  const projects = JSON.parse(listed.stdout.slice(start, end + 1))
  const dirs = []
  for (const project of projects) {
    // The workspace root is not a shard member: `pnpm -r test` excludes it, and
    // its own test script is the recursive runner the shards replace.
    if (resolve(project.path) === ROOT) continue
    const manifest = JSON.parse(readFileSync(join(project.path, 'package.json'), 'utf8'))
    if (typeof manifest.scripts?.test !== 'string' || manifest.scripts.test.trim() === '') continue
    dirs.push(relative(ROOT, project.path).split(sep).join('/'))
  }
  return dirs.sort()
}

describe('parseWorkspaceGlobs', () => {
  it('reads the packages list and stops at the next top-level key', () => {
    const yaml = [
      '# leading comment',
      'packages:',
      "  - 'shared'",
      '  - "packages/*"   # every plugin package',
      '',
      '  - tools/*',
      'autoInstallPeers: false',
      '  - not-a-package',
    ].join('\n')
    assert.deepEqual(parseWorkspaceGlobs(yaml), ['shared', 'packages/*', 'tools/*'])
  })

  it('returns nothing when the file declares no packages list', () => {
    assert.deepEqual(parseWorkspaceGlobs('autoInstallPeers: false\n'), [])
  })
})

describe('expandWorkspaceGlobs', () => {
  it('expands the real workspace globs to directories, sorted', (t) => {
    const fixture = makeFixtureWorkspace()
    t.after(() => rmSync(fixture, { recursive: true, force: true }))
    assert.deepEqual(expandWorkspaceGlobs(fixture, ['shared', 'packages/*']), [
      'packages/dsh-ssh',
      'packages/fixture-manifestless',
      'packages/fixture-unknown',
      'packages/fixture-untested',
      'shared',
    ])
  })

  it('refuses a pattern that selects nothing instead of shrinking the workspace', (t) => {
    const fixture = makeFixtureWorkspace()
    t.after(() => rmSync(fixture, { recursive: true, force: true }))
    assert.throws(() => expandWorkspaceGlobs(fixture, ['tools/*']), /selects no directory/)
    assert.throws(() => expandWorkspaceGlobs(fixture, ['packages/missing']), /selects a missing directory/)
    assert.throws(() => expandWorkspaceGlobs(fixture, ['packages/**/nested']), /recursive glob/)
  })
})

describe('listTestPackages', () => {
  it('takes only test-bearing members, weighting the table hits and defaulting the rest', (t) => {
    const fixture = makeFixtureWorkspace()
    t.after(() => rmSync(fixture, { recursive: true, force: true }))
    const packages = listTestPackages(fixture)
    assert.deepEqual(
      packages.map((pkg) => [pkg.dir, pkg.weight]),
      [
        ['packages/dsh-ssh', PACKAGE_WEIGHTS['packages/dsh-ssh']],
        ['packages/fixture-unknown', DEFAULT_WEIGHT_SECONDS],
        ['shared', PACKAGE_WEIGHTS.shared],
      ],
    )
  })

  it('enumerates exactly the workspace members the package manager reports', () => {
    const enumerated = listTestPackages(ROOT).map((pkg) => pkg.dir)
    assert.deepEqual(enumerated, workspaceTestDirsViaPnpm())
  })

  it('carries no weight table entry for a package that no longer declares a test', () => {
    const enumerated = new Set(listTestPackages(ROOT).map((pkg) => pkg.dir))
    const stale = Object.keys(PACKAGE_WEIGHTS).filter((dir) => !enumerated.has(dir))
    assert.deepEqual(stale, [], 'every weight table key must still name a test-bearing workspace package')
  })

  it('gives every enumerated package a positive integer weight', () => {
    const packages = listTestPackages(ROOT)
    const invalid = packages.filter((pkg) => !Number.isInteger(pkg.weight) || pkg.weight < 1)
    assert.deepEqual(invalid.map((pkg) => pkg.dir), [])
  })
})

describe('partitionShards', () => {
  const packages = listTestPackages(ROOT)
  const shards = partitionShards(packages, SHARD_TOTAL)
  const flat = shards.flat()

  it('assigns every test-bearing package exactly once', () => {
    assert.deepEqual(flat.map((pkg) => pkg.dir).sort(), packages.map((pkg) => pkg.dir).sort())
    assert.equal(flat.length, packages.length)
  })

  it('keeps the shards disjoint', () => {
    const seen = new Set()
    const duplicated = []
    for (const pkg of flat) {
      if (seen.has(pkg.dir)) duplicated.push(pkg.dir)
      seen.add(pkg.dir)
    }
    assert.deepEqual(duplicated, [])
    assert.equal(seen.size, packages.length)
  })

  it('produces the same partition whatever order the packages arrive in', () => {
    assert.deepEqual(partitionShards(packages, SHARD_TOTAL), shards)
    assert.deepEqual(partitionShards([...packages].reverse(), SHARD_TOTAL), shards)
  })

  it('keeps every shard within a quarter of the mean weight', () => {
    const weights = shards.map(shardWeight)
    const mean = shardWeight(packages) / SHARD_TOTAL
    const heaviest = Math.max(...weights)
    const lightest = Math.min(...weights)
    assert.equal(
      heaviest <= mean * (1 + BALANCE_TOLERANCE),
      true,
      `heaviest shard ${heaviest}s must stay within ${BALANCE_TOLERANCE * 100}% of the ${mean}s mean`,
    )
    assert.equal(
      lightest >= mean * (1 - BALANCE_TOLERANCE),
      true,
      `lightest shard ${lightest}s must stay within ${BALANCE_TOLERANCE * 100}% of the ${mean}s mean`,
    )
  })

  it('refuses a shard count that cannot hold a partition', () => {
    assert.throws(() => partitionShards(packages, 0), /positive integer/)
    assert.throws(() => partitionShards(packages, 2.5), /positive integer/)
  })
})

describe('test-shard CLI', () => {
  const script = join(ROOT, 'scripts', 'test-shard.mjs')

  function runCli(args) {
    return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' })
  }

  it('prints the whole plan for a shard without executing anything', () => {
    const run = runCli(['3', String(SHARD_TOTAL), '--dry-run'])
    assert.equal(run.status, 0, run.stderr)
    const planLines = run.stdout.split('\n').filter((line) => line.startsWith('test-shard: shard '))
    assert.equal(planLines.length, SHARD_TOTAL)
    const planned = planLines.flatMap((line) =>
      line.slice(line.indexOf(' packages: ') + ' packages: '.length).split(', '),
    )
    assert.deepEqual(planned.slice().sort(), listTestPackages(ROOT).map((pkg) => pkg.dir))
    assert.equal(run.stdout.includes('[shard 3/4] ok'), false, 'a dry run must not run a suite')
    assert.equal(run.stdout.includes('nothing executed'), true)
  })

  it('rejects a shard index outside the requested total', () => {
    const run = runCli(['5', String(SHARD_TOTAL), '--dry-run'])
    assert.equal(run.status, 1)
    assert.equal(run.stderr.includes('outside 1..4'), true, run.stderr)
  })
})
