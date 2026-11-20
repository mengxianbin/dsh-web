/**
 * GG-1: the status plumbing runs three spawns instead of five, and the new
 * porcelain-v2 source must be field-equivalent to the porcelain-v1 parser it
 * replaces.
 *
 * The equivalence matrix reads REAL command output captured from real
 * repositories (`fixtures/status-porcelain/`, provenance in its README): for
 * every case the counts `parseStatusV2` derives from
 * `git status --porcelain=v2 --branch` must equal the counts `parsePorcelain`
 * derives from `git status --porcelain` for the same repository state, and the
 * branch `parseStatusV2` reports must equal what the previous
 * `git rev-parse --abbrev-ref HEAD` source produced (with its `HEAD` -> `''`
 * mapping).
 *
 * The spawn-plan tests are deterministic: an injected runner records argv, so
 * the assertion is a count, not a timing budget. The legacy sequence is
 * spelled out below as data; the new implementation fails that test, which is
 * what makes it a regression guard for the 5 -> 3 change.
 * @module tests/status-porcelain-v2
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GitRunResult, GitRunner, WorkspaceGate } from '../src/host/git-service.ts'
import { GitService, gitSpawnArgv } from '../src/host/git-service.ts'
import { parsePorcelain } from '../src/core/types.ts'
import { parseStatusV2, rootAndHeadArgv, statusV2BranchArgv } from '../src/host/status-porcelain.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/status-porcelain/', import.meta.url))
const manifest = readFileSync(join(FIXTURES, 'manifest.tsv'), 'utf8').trim().split('\n').map(line => {
  const [name, v1Exit, v2Exit, branchExit] = line.split('\t')
  return { name: name!, v1Exit: Number(v1Exit), v2Exit: Number(v2Exit), branchExit: Number(branchExit) }
})
const read = (name: string, suffix: string): string => readFileSync(join(FIXTURES, `${name}.${suffix}.txt`), 'utf8')

/**
 * The pre-change spawn sequence for one `git status`, as data: one root probe,
 * one branch probe, the porcelain-v1 scan, one combined marker probe and one
 * short-head probe. It is the baseline the count assertion reports against and
 * it deliberately does not reference the live argv builders: this describes
 * history, not current production code.
 */
const LEGACY_STATUS_ARGV: readonly (readonly string[])[] = [
  ['rev-parse', '--show-toplevel'],
  ['rev-parse', '--abbrev-ref', 'HEAD'],
  ['status', '--porcelain'],
  ['rev-parse', ...['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer'].flatMap(marker => ['--git-path', marker])],
  ['rev-parse', '--short', 'HEAD'],
]

const allowGate = (canonical: string): WorkspaceGate => async () => ({ ok: true, canonical })

describe('porcelain=v2 equivalence on real command output', () => {
  it('operator gets one capture per case as a v1/v2/branch trio', () => {
    // Given the captured fixture directory shipped beside this spec
    const files = readdirSync(FIXTURES)

    // When every manifest row is checked against the files on disk
    const missing = manifest.flatMap(({ name }) => ['v1', 'v2', 'branch']
      .filter(suffix => !files.includes(`${name}.${suffix}.txt`))
      .map(suffix => `${name}.${suffix}.txt`))

    // Then the matrix is complete and carries enough cases to be evidence
    expect(missing).toEqual([])
    expect(manifest.length).toBeGreaterThanOrEqual(18)
  })

  it('operator sees identical counts from porcelain-v1 and porcelain-v2 on every captured case', () => {
    // Given both parsers and one real output pair per case
    const rows = manifest.map(({ name }) => ({
      name,
      fromV1: parsePorcelain(read(name, 'v1')),
      fromV2: parseStatusV2(read(name, 'v2')).counts,
    }))

    // When every pair is compared field by field
    const mismatches = rows
      .filter(({ fromV1, fromV2 }) => JSON.stringify(fromV1) !== JSON.stringify(fromV2))
      .map(({ name }) => name)

    // Then no case disagrees, and the matrix is not eighteen empty verdicts
    expect(mismatches).toEqual([])
    expect(rows.some(({ fromV1 }) => fromV1.dirtyFiles > 0)).toBe(true)
    expect(rows.some(({ fromV1 }) => fromV1.untrackedFiles > 0)).toBe(true)
    expect(rows.some(({ fromV1 }) => fromV1.conflicts > 0)).toBe(true)
    expect(rows.some(({ fromV1 }) => fromV1.conflicts >= 2)).toBe(true)
  })

  it('operator sees the branch the previous rev-parse source reported on every captured case', () => {
    // Given the previous branch source's raw output per case
    const rows = manifest.map(({ name }) => {
      const raw = read(name, 'branch').trim()
      // The pre-change implementation mapped both a detached head and an unborn
      // branch (exit 128) to ''.
      return { name, legacy: raw === 'HEAD' ? '' : raw, next: parseStatusV2(read(name, 'v2')).branch }
    })

    // When the mapped legacy value is compared with the v2 header value
    const mismatches = rows.filter(({ legacy, next }) => legacy !== next).map(({ name }) => name)

    // Then every case agrees, the three sentinel cases are all empty, and at
    // least one case proves a real branch name survives
    expect(mismatches).toEqual([])
    expect(rows.filter(({ legacy }) => legacy === '').map(({ name }) => name).sort())
      .toEqual(['clean-after-changes', 'detached-head', 'unborn'])
    expect(rows.some(({ legacy }) => legacy !== '')).toBe(true)
  })

  it('operator gets the rename, space, untracked-directory and conflict boundaries through porcelain=v2', () => {
    // Given the captured boundary cases
    const rename = parseStatusV2(read('rename-plus-modify', 'v2')).counts
    const spaces = parseStatusV2(read('path-with-spaces-untracked', 'v2')).counts
    const ignored = parseStatusV2(read('ignored-present', 'v2')).counts
    const directory = parseStatusV2(read('untracked-directory', 'v2')).counts
    const conflicts = parseStatusV2(read('conflict-aa', 'v2')).counts
    const bulk = parseStatusV2(read('many-with-untracked-bulk', 'v2')).counts
    const detached = parseStatusV2(read('detached-head', 'v2')).branch
    const unborn = parseStatusV2(read('unborn', 'v2')).branch

    // When each boundary verdict is read from the v2 output alone
    // Then it matches the v1 verdict for the same repository state
    expect(rename).toEqual({ dirtyFiles: 1, untrackedFiles: 0, conflicts: 0 })
    expect(spaces).toEqual({ dirtyFiles: 1, untrackedFiles: 1, conflicts: 0 })
    expect(directory.untrackedFiles).toBe(2)
    expect(ignored).toEqual(parsePorcelain(read('ignored-present', 'v1')))
    expect(conflicts.conflicts).toBe(2)
    expect(detached).toBe('')
    expect(unborn).toBe('')
    expect(bulk).toEqual({ dirtyFiles: 201, untrackedFiles: 4, conflicts: 0 })
  })
})

describe('parseStatusV2 record and header handling', () => {
  it('operator reading an empty or header-only scan gets zero counts and the header branch', () => {
    // Given an empty stdout and a header-only stdout
    // When each is parsed
    // Then both report no entries, and only the header-bearing one names a branch
    expect(parseStatusV2('')).toEqual({ branch: '', counts: { dirtyFiles: 0, untrackedFiles: 0, conflicts: 0 } })
    expect(parseStatusV2('# branch.oid abc\n# branch.head main\n')).toEqual({
      branch: 'main',
      counts: { dirtyFiles: 0, untrackedFiles: 0, conflicts: 0 },
    })
  })

  it('operator gets every v2 header line skipped, including ahead/behind and stash', () => {
    // Given a document whose headers precede one ordinary change record
    const stdout = '# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n# branch.upstream origin/main\n# stash 3\n1 .M N... 100644 100644 100644 a a file.txt\n'

    // When it is parsed
    // Then only the record counts and the branch survives
    expect(parseStatusV2(stdout)).toEqual({ branch: 'main', counts: { dirtyFiles: 1, untrackedFiles: 0, conflicts: 0 } })
  })

  it('operator on a detached, unknown or unborn head sees an empty branch', () => {
    // Given the three sentinels git prints instead of a branch name
    const detached = parseStatusV2('# branch.oid abc\n# branch.head (detached)\n').branch
    const unknown = parseStatusV2('# branch.oid abc\n# branch.head (unknown)\n').branch
    const unborn = parseStatusV2('# branch.oid (initial)\n# branch.head main\n').branch
    const named = parseStatusV2('# branch.head main\n').branch

    // When each header is parsed
    // Then the sentinels map to an empty branch and a real name survives
    expect(detached).toBe('')
    expect(unknown).toBe('')
    expect(unborn).toBe('')
    expect(named).toBe('main')
  })

  it('operator gets rename, untracked, unmerged, ignored and unknown records classified like porcelain-v1', () => {
    // Given one real record shape per class
    const rename = '2 RM N... 100644 100644 100644 65b2df8 65b2df8 R100 src/new name.txt\tsrc/old name.txt'
    const untracked = '? untracked dir/'
    const unmerged = 'u UU N... 100644 100644 100644 100644 a b c conflict.txt'
    const ignored = '! ignored.log'
    const unknown = '9 future record'

    // When each stdout is parsed
    // Then every class lands in the same bucket the v1 parser used
    expect(parseStatusV2(`${rename}\n`).counts).toEqual({ dirtyFiles: 1, untrackedFiles: 0, conflicts: 0 })
    expect(parseStatusV2(`${untracked}\n`).counts).toEqual({ dirtyFiles: 0, untrackedFiles: 1, conflicts: 0 })
    expect(parseStatusV2(`${unmerged}\n`).counts).toEqual({ dirtyFiles: 0, untrackedFiles: 0, conflicts: 1 })
    expect(parseStatusV2(`${ignored}\n`).counts).toEqual({ dirtyFiles: 0, untrackedFiles: 0, conflicts: 0 })
    expect(parseStatusV2(`${unknown}\n`).counts).toEqual({ dirtyFiles: 1, untrackedFiles: 0, conflicts: 0 })
  })

  it('operator sees a quoted multi-line path counted once', () => {
    // Given a record whose path is C-quoted because it contains a newline
    const stdout = '1 .M N... 100644 100644 100644 a a "weird\\nname.txt"\n'

    // When it is parsed
    // Then the entry counts once, not once per display line
    expect(parseStatusV2(stdout).counts.dirtyFiles).toBe(1)
  })
})

describe('status spawn plan', () => {
  /** Runner serving exactly the three-spawn plan, recording every argv. */
  const plannedRunner = (calls: string[][], overrides: Partial<Record<string, GitRunResult>> = {}): GitRunner => ({
    async run(argv: readonly string[]): Promise<GitRunResult> {
      calls.push([...argv])
      const key = argv.join(' ')
      const override = overrides[key]
      if (override !== undefined) return override
      if (key === rootAndHeadArgv().join(' ')) return { exitCode: 0, stdout: '/repo\nabc1234\n', stderr: '' }
      if (argv[0] === 'rev-parse' && argv.includes('--git-path')) {
        return { exitCode: 0, stdout: '.git/MERGE_HEAD\n.git/CHERRY_PICK_HEAD\n.git/REVERT_HEAD\n.git/BISECT_LOG\n.git/rebase-merge\n.git/rebase-apply\n.git/sequencer\n', stderr: '' }
      }
      if (key === statusV2BranchArgv().join(' ')) {
        return { exitCode: 0, stdout: '# branch.oid abc\n# branch.head main\n1 .M N... 100644 100644 100644 a a file.txt\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })

  it('operator pays three spawns for one git status instead of the legacy five', async () => {
    // Given a runner that records every spawn on the three-spawn plan
    const calls: string[][] = []
    const service = new GitService(plannedRunner(calls), allowGate('/repo'))

    // When the status view is opened
    const status = await service.status('/w')

    // Then the verdict is complete and the plan spent three spawns, two fewer
    // than the legacy sequence whose removed members are the standalone branch
    // and short-head probes
    expect(status).toEqual({
      root: '/repo',
      branch: 'main',
      head: 'abc1234',
      dirtyFiles: 1,
      untrackedFiles: 0,
      conflicts: 0,
      operationInProgress: false,
    })
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual(rootAndHeadArgv())
    expect(calls[1]![0]).toBe('rev-parse')
    expect(calls[1]).toContain('--git-path')
    expect(calls[2]).toEqual(statusV2BranchArgv())
    expect(LEGACY_STATUS_ARGV).toHaveLength(5)
    expect(LEGACY_STATUS_ARGV.length - calls.length).toBe(2)
    expect(calls.some((argv) => argv.includes('--abbrev-ref'))).toBe(false)
    expect(calls.filter((argv) => argv.includes('--short'))).toHaveLength(1)
    expect(calls[0]).toContain('--short')
  })

  it('operator opening the branches view pays the same three-spawn plumbing', async () => {
    // Given the same recording runner plus a for-each-ref listing
    const calls: string[][] = []
    const runner = plannedRunner(calls)
    const service = new GitService({
      async run(argv, cwd, signal) {
        if (argv[0] === 'for-each-ref') {
          calls.push([...argv])
          return { exitCode: 0, stdout: 'main\0*\0abc1234\n', stderr: '' }
        }
        return runner.run(argv, cwd, signal)
      },
    }, allowGate('/repo'))

    // When the branches view is opened
    const view = await service.branches('/w')

    // Then the plumbing is the same three spawns plus the ref listing, and no
    // standalone branch probe runs
    expect(view?.branch).toBe('main')
    expect(view?.dirtyFiles).toBe(1)
    expect(calls).toHaveLength(4)
    expect(calls.filter((argv) => argv[0] === 'status')).toHaveLength(1)
    expect(calls.some((argv) => argv.includes('--abbrev-ref'))).toBe(false)
  })

  it('operator with two concurrent readers pays one flight and three spawns', async () => {
    // Given two status readers racing on the same workspace path
    const calls: string[][] = []
    const service = new GitService(plannedRunner(calls), allowGate('/repo'))

    // When both reads are issued before the first settles
    const [first, second] = await Promise.all([service.status('/w'), service.status('/w')])

    // Then both share one verdict and the flight issued three spawns in total
    expect(first).toEqual(second)
    expect(calls).toHaveLength(3)
  })

  it('operator reading a path outside any repository gets null after the first spawn', async () => {
    // Given a root probe that reports no repository
    const calls: string[][] = []
    const service = new GitService(plannedRunner(calls, {
      [rootAndHeadArgv().join(' ')]: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' },
    }), allowGate('/repo'))

    // When the status view is opened
    const status = await service.status('/w')

    // Then the view is null and nothing beyond the root probe was spawned
    expect(status).toBeNull()
    expect(calls).toEqual([rootAndHeadArgv()])
  })

  it('operator keeps the per-marker fallback when the combined marker probe fails', async () => {
    // Given a runner whose combined --git-path probe fails while the single
    // marker probes each succeed without finding a marker file
    const calls: string[][] = []
    const failing = new GitService({
      async run(argv) {
        calls.push([...argv])
        if (argv[0] === 'rev-parse' && argv.filter(arg => arg === '--git-path').length > 1) {
          return { exitCode: 1, stdout: '', stderr: 'fatal: bad revision' }
        }
        if (argv[0] === 'rev-parse' && argv.includes('--git-path')) return { exitCode: 0, stdout: '', stderr: '' }
        if (argv[0] === 'rev-parse' && argv.includes('--short')) return { exitCode: 0, stdout: '/repo\nabc1234\n', stderr: '' }
        return { exitCode: 0, stdout: '# branch.head main\n', stderr: '' }
      },
    }, allowGate('/repo'))

    // When the status view is opened
    const status = await failing.status('/w')

    // Then the verdict still comes from the seven single-marker probes
    expect(status).toMatchObject({ operationInProgress: false })
    expect(calls.filter((argv) => argv[0] === 'rev-parse' && argv.filter(arg => arg === '--git-path').length > 1)).toHaveLength(1)
    expect(calls.filter((argv) => argv[0] === 'rev-parse' && argv.filter(arg => arg === '--git-path').length === 1)).toHaveLength(7)
  })

  it('operator on the win32 lane keeps the git.exe seam for both new command shapes', () => {
    // Given the two argv shapes the status plumbing spawns
    // When each is projected onto the win32 lane and onto a POSIX lane
    // Then both name git.exe on Windows and plain git elsewhere
    expect(gitSpawnArgv('win32', rootAndHeadArgv())).toEqual(['git.exe', 'rev-parse', '--show-toplevel', '--short', 'HEAD'])
    expect(gitSpawnArgv('win32', statusV2BranchArgv())).toEqual(['git.exe', 'status', '--porcelain=v2', '--branch'])
    expect(gitSpawnArgv('darwin', statusV2BranchArgv())).toEqual(['git', 'status', '--porcelain=v2', '--branch'])
  })
})
