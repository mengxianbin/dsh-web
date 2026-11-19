// @vitest-environment node
/**
 * archive-seal-falsered-1116 三改的 dsh-web 侧用例（派发方验收判据 2 新增用例）:
 * ① gitRun 失败留痕 — 三因（timeout / spawn / exit）可区分 + 真实失败落
 *    `[seal-git]` console.warn 带 stderr 尾（现全吞 → 可诊断）；
 * ② 判红不粘滞（重探路径）— 点击门带 `recheck` 时 memo 里的 no-endorsement
 *    红被重探（git 态痊愈即转绿），灯拉路径照旧吃 memo（频度不变）；
 * ③ git 探针失败当场重试一次再判红（失败路径多一轮探针，板行四问①预批）。
 * 错误形状 = 2026-11-17 本机 node 实测（.tmp/gitrun-error-shape.mjs），不凭记忆。
 * @module tests/seal-recheck.spec
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeSeal, classifyGitRunError, clearSealMemo, sealMemoStats } from '../src/host/seal.ts'
import { assistantMsg, createFakeHost, userMsg, writeTranscript, type FakeHost } from './fixtures.ts'

function dirOf(host: FakeHost, id: string): string {
  return join(host.home, 'sessions', '--Users-demo--', id.startsWith('session-') ? id.slice('session-'.length) : id)
}

/** Transcript root event carrying the session cwd — the real transcript shape. */
function sessionRoot(id: string, cwd: string): Record<string, unknown> {
  return { type: 'session', version: 4, id, cwd }
}

/** An endorsed DONE report: 落点头 hashes earlier in the message, the endorsement line last. */
function endorsedDone(count: number, hashes: readonly string[]): string {
  const listed = hashes.map((hash) => `\`${hash}\``).join(' + ')
  return `落点头 ${listed} 已推 origin。\n\nSAVE_STATUS=DONE commits=${count}/${count} pushedBranch=${count}/${count} merged=${count}/${count} pushedMain=${count}/${count} auditCleaned=yes dirty=0`
}

/** A real git repo with one commit but NO origin remote-tracking ref: the endorsement recheck's clean negative (branch -r --contains is empty). */
function repoWithoutRemote(): { dir: string; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), 'seal-recheck-'))
  const run = (args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  run(['init', '-q'])
  run(['config', 'user.email', 'seal@test'])
  run(['config', 'user.name', 'seal'])
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'seed'])
  const hash = run(['rev-parse', 'HEAD']).trim()
  return { dir, hash }
}

beforeEach(() => {
  clearSealMemo()
})

describe('gitRun 失败留痕（archive-seal-falsered-1116 段1）', () => {
  it('classifies exit / timeout / spawn distinctly, each carrying its stderr tail', () => {
    // Shapes copied from the 2026-11-17 node 实测 run (.tmp/gitrun-error-shape.mjs)
    const exit = classifyGitRunError(Object.assign(new Error('Command failed: git -C … cat-file -e …'), {
      status: 128, signal: null, stderr: 'fatal: Not a valid object name deadbeef^{commit}\n',
    }))
    const timeout = classifyGitRunError(Object.assign(new Error('spawnSync ping ETIMEDOUT'), {
      code: 'ETIMEDOUT', errno: -4039, signal: 'SIGTERM', status: null, stderr: '',
    }))
    const spawn = classifyGitRunError(Object.assign(new Error('spawnSync git ENOENT'), {
      code: 'ENOENT', errno: -4058, syscall: 'spawnSync git', status: null,
    }))

    expect(exit.cause).toBe('exit')
    expect(exit.detail).toContain('exit 128')
    expect(exit.detail).toContain('fatal: Not a valid object name deadbeef^{commit}')
    expect(timeout.cause).toBe('timeout')
    expect(timeout.detail).toContain('SIGTERM')
    expect(spawn.cause).toBe('spawn')
    expect(spawn.detail).toContain('ENOENT')
    // 三因两两可区分（超时 / spawn 失败 / 非零退出）
    expect(new Set([exit.cause, timeout.cause, spawn.cause]).size).toBe(3)
  })

  it('a real failing probe warns `[seal-git]` with the cause, command, repo and stderr tail (never a bare swallow)', () => {
    // Given a DONE whose endorsement probe points at a repo directory that does not exist
    const host = createFakeHost()
    const gone = join(tmpdir(), 'seal-recheck-never-exists')
    writeTranscript(host, 'session-a', [
      sessionRoot('session-a', gone),
      assistantMsg(endorsedDone(1, ['f'.repeat(40)])),
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // When the seal is judged
      const result = analyzeSeal('session-a', dirOf(host, 'session-a'))

      // Then the red still fails closed…
      expect(result).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement', lastLine: expect.any(String) })
      // …and every failed probe left a `[seal-git]` line naming the cause,
      // the exact command, the repo, and the git stderr tail.
      const lines = warn.mock.calls.map((call) => String(call[0] ?? '')).filter((line) => line.startsWith('[seal-git]'))
      expect(lines.length).toBeGreaterThan(0)
      expect(lines[0]).toContain('[seal-git] exit')
      expect(lines[0]).toContain('git cat-file -e')
      expect(lines[0]).toContain(`repo=${gone}`)
      expect(lines[0]).toMatch(/fatal: /)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('no-endorsement 不随转录戳粘滞（archive-seal-falsered-1116 段2 · 重探路径）', () => {
  it('a click-time recheck re-probes the memoized git red and turns green once git heals', () => {
    // Given a DONE whose endorsement reads clean-negative (hash exists, no remote ref yet) — first judgement red, memoized
    const host = createFakeHost()
    const repo = repoWithoutRemote()
    writeTranscript(host, 'session-a', [
      sessionRoot('session-a', repo.dir),
      assistantMsg(endorsedDone(1, [repo.hash])),
    ])
    const dir = dirOf(host, 'session-a')
    expect(analyzeSeal('session-a', dir)).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement', lastLine: expect.any(String) })
    expect(sealMemoStats()).toEqual({ hits: 0, misses: 1, size: 1 })

    // When the same unchanged transcript is read WITHOUT recheck (the lamp-pull path)
    expect(analyzeSeal('session-a', dir)).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement', lastLine: expect.any(String) })
    // Then it still serves the memo — lamp checks keep their zero-cost window (四问②：灯查频度与成本不变)
    expect(sealMemoStats()).toEqual({ hits: 1, misses: 1, size: 1 })

    // And the git state heals while the transcript stamp stays put (the incident shape)
    execFileSync('git', ['-C', repo.dir, 'update-ref', 'refs/remotes/origin/main', repo.hash])

    // When the click gate asks with recheck
    const rechecked = analyzeSeal('session-a', dir, { recheck: true })
    // Then the memoized red is re-derived (git re-probed) and the verdict is green — 判红不粘滞
    expect(rechecked).toEqual({ id: 'session-a', verdict: 'DONE', detail: 'sentinel-ok', lastLine: expect.any(String) })
    expect(sealMemoStats()).toEqual({ hits: 1, misses: 2, size: 1 })

    // And the healed green refills the memo for the lamp path
    expect(analyzeSeal('session-a', dir)).toEqual({ id: 'session-a', verdict: 'DONE', detail: 'sentinel-ok', lastLine: expect.any(String) })
    expect(sealMemoStats()).toEqual({ hits: 2, misses: 2, size: 1 })
  })

  it('recheck leaves transcript-derived reds in their memo window (只重探 git 态的判红)', () => {
    // Given a pending sentinel red (transcript-derived, not git-derived)
    const host = createFakeHost()
    writeTranscript(host, 'session-a', [userMsg('hi'), assistantMsg('还有两步没收口。\n\nSAVE_STATUS=PENDING(2)')])
    const dir = dirOf(host, 'session-a')
    expect(analyzeSeal('session-a', dir)).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'sentinel-pending', lastLine: expect.any(String) })

    // When the click gate asks with recheck
    expect(analyzeSeal('session-a', dir, { recheck: true })).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'sentinel-pending', lastLine: expect.any(String) })

    // Then no re-probe happened: the stamp-keyed verdict still serves (重探只在判红=git 红时触发)
    expect(sealMemoStats()).toEqual({ hits: 1, misses: 1, size: 1 })
  })
})

describe('git 探针失败当场重试一次（archive-seal-falsered-1116 段2b）', () => {
  it('reruns the whole endorsement recheck once when probes fail, logging both passes', () => {
    // Given a declared hash no candidate repo can answer for (every probe fails)
    const host = createFakeHost()
    const gone = join(tmpdir(), 'seal-recheck-gone-cwd')
    writeTranscript(host, 'session-a', [
      sessionRoot('session-a', gone),
      assistantMsg(endorsedDone(1, ['f'.repeat(40)])),
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // When the seal is judged
      const result = analyzeSeal('session-a', dirOf(host, 'session-a'))

      // Then it still fails closed
      expect(result).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement', lastLine: expect.any(String) })
      // And the probe round ran twice: 3 repo candidates × 1 hash × 2 passes
      // (the first pass failed → 当场重试一次) = 6 logged failures — a single
      // pass would log exactly 3.
      const lines = warn.mock.calls.map((call) => String(call[0] ?? '')).filter((line) => line.startsWith('[seal-git]'))
      expect(lines).toHaveLength(6)
      for (const line of lines) {
        expect(line).toContain('[seal-git] exit')
        expect(line).toContain('git cat-file -e')
      }
    } finally {
      warn.mockRestore()
    }
  })
})
