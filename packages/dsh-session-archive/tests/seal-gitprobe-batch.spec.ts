// @vitest-environment node
/**
 * archive-seal-gitprobe-1117 ③ 批量化 — 探针次数断言 + 沙箱 seal-check 尖峰口径:
 * ① 绿路径 N hash 的 git spawn 恒为 2（1 次 `cat-file --batch-check` + 1 次
 *    `rev-list --count … --not --remotes`；原路 = 至多 3N 次 `-e` + N 次
 *    `branch -r --contains`）——证明快路真的短路、且只短路全绿；
 * ② 死 hash 落回原路后 warn 仍是「恰好 6 条 `git cat-file -e`」原文（2 轮当场
 *    重试 × 3 个候选仓）——快路自身零告警，falsered-1116 语义逐字节不变；
 * ③ 沙箱 seal-check 冷判 21 轮：p95 ≤500ms、单轮 ≤1000ms（>1s 尖峰归零；
 *    板行基线 1002–3312ms）。探针目标 = m-note 真仓**只读**（无 m-note 整组跳过）。
 * @module tests/seal-gitprobe-batch.spec
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeSeal, clearSealMemo } from '../src/host/seal.ts'
import { assistantMsg, createFakeHost, userMsg, writeTranscript, type FakeHost } from './fixtures.ts'

/** git spawn 计数（只数 execFileSync('git', …)；夹具建仓的 git 也在内 → 断言前清零）。 */
const gitSpawns = vi.hoisted(() => ({ n: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: ((...args: unknown[]) => {
      if (args[0] === 'git') gitSpawns.n += 1
      return (actual.execFileSync as (...argv: unknown[]) => unknown)(...args)
    }) as typeof actual.execFileSync,
  }
})

function dirOf(host: FakeHost, id: string): string {
  return join(host.home, 'sessions', '--Users-demo--', id.startsWith('session-') ? id.slice('session-'.length) : id)
}

/** Transcript root event carrying the session cwd — the real transcript shape. */
function sessionRoot(id: string, cwd: string): Record<string, unknown> {
  return { type: 'session', version: 4, id, cwd }
}

/** The endorsement tail save-status.py prints after DONE (背书行形态). */
function endorsedTail(count: number): string {
  return ` commits=${count}/${count} pushedBranch=${count}/${count} merged=${count}/${count} pushedMain=${count}/${count} auditCleaned=yes dirty=0`
}

/** A DONE report whose endorsement line carries the declared list (seal-declare-verify-1107 形态). */
function declaredDone(hashes: readonly string[]): string {
  return `落点头已声明。\n\nSAVE_STATUS=DONE${endorsedTail(hashes.length)} hashes=${hashes.join(',')}`
}

interface BatchRepo {
  dir: string
  hashes: string[]
}

let repoCache: BatchRepo | undefined

/** 3-commit repo whose every commit sits on origin/main's ancestry (hermetic green fixture). */
function batchRepo(): BatchRepo {
  if (repoCache !== undefined) return repoCache
  const dir = mkdtempSync(join(tmpdir(), 'seal-batch-'))
  const run = (args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  run(['init', '-q'])
  run(['config', 'user.email', 'seal@test'])
  run(['config', 'user.name', 'seal'])
  const hashes: string[] = []
  for (const name of ['seed1.txt', 'seed2.txt', 'seed3.txt']) {
    writeFileSync(join(dir, name), `${name}\n`)
    run(['add', '.'])
    run(['commit', '-q', '-m', name])
    hashes.push(run(['rev-parse', 'HEAD']).trim())
  }
  run(['update-ref', 'refs/remotes/origin/main', hashes[hashes.length - 1] ?? ''])
  repoCache = { dir, hashes }
  return repoCache
}

beforeEach(() => {
  clearSealMemo()
})

describe('批量化快路 — 探针次数断言（archive-seal-gitprobe-1117 ③）', () => {
  it('绿路径 3 hash 只打 2 个 git spawn（1 次 batch-check + 1 次 rev-list）', () => {
    const host = createFakeHost()
    const repo = batchRepo()
    writeTranscript(host, 'session-batch', [
      sessionRoot('session-batch', repo.dir),
      userMsg('收口'),
      assistantMsg(declaredDone(repo.hashes)),
    ])
    gitSpawns.n = 0
    const result = analyzeSeal('session-batch', dirOf(host, 'session-batch'))
    // Then the verdict stays green …
    expect(result.verdict).toBe('DONE')
    // … and the whole judgment cost exactly the two batched probes
    // (原路同形态 = 3 次 `cat-file -e` + 3 次 `branch -r --contains` = 6 spawn)
    expect(gitSpawns.n).toBe(2)
  })

  it('死 hash 落回原路：恰好 6 条 `git cat-file -e` warn + 判红（快路零告警）', () => {
    const host = createFakeHost()
    const repo = batchRepo()
    const dead = 'e'.repeat(40)
    writeTranscript(host, 'session-fallback', [
      sessionRoot('session-fallback', repo.dir),
      userMsg('收口'),
      assistantMsg(declaredDone([repo.hashes[0] ?? '', dead])),
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    gitSpawns.n = 0
    const result = analyzeSeal('session-fallback', dirOf(host, 'session-fallback'))
    const lines = warn.mock.calls.map((call) => String(call[0] ?? ''))
    warn.mockRestore()
    // Then the endorsement fails closed to the scanner's red …
    expect(result).toEqual({ id: 'session-fallback', verdict: 'UNSEALED', detail: 'no-endorsement', lastLine: expect.any(String) })
    // … the retry ran (2 rounds × 3 candidate repos) …
    expect(lines).toHaveLength(6)
    // … and every warn is the canonical per-hash `-e` line — the batched fast
    // path never warns itself, so falsered-1116 的失败留痕行文一字未变。
    for (const line of lines) {
      expect(line).toContain('[seal-git]')
      expect(line).toContain('git cat-file -e')
    }
  })
})

const MNOTE = 'D:/tech/m-note'

describe.runIf(existsSync(join(MNOTE, '.git')))('沙箱 seal-check 尖峰（m-note 真仓只读探针）', () => {
  it('冷判 21 轮 p95 ≤500ms 且单轮 ≤1000ms（板行基线 1002–3312ms → >1s 归零）', () => {
    const host = createFakeHost()
    // 5 个由 `rev-list --remotes` 直接取出的 hash —— 构造上必然被 remote-tracking ref 包含
    const hashes = execFileSync('git', ['-C', MNOTE, 'rev-list', '-5', '--remotes'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f]{7,40}$/.test(line))
    expect(hashes).toHaveLength(5)
    writeTranscript(host, 'session-spike', [
      sessionRoot('session-spike', MNOTE),
      userMsg('收口'),
      assistantMsg(declaredDone(hashes)),
    ])
    const dir = dirOf(host, 'session-spike')
    const samples: number[] = []
    for (let round = 0; round < 21; round++) {
      clearSealMemo() // 每轮清 memo → 强制全探针（冷判口径，等价重启后首判）
      const started = performance.now()
      const result = analyzeSeal('session-spike', dir)
      samples.push(performance.now() - started)
      expect(result.verdict).toBe('DONE')
    }
    const sorted = [...samples].sort((a, b) => a - b)
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0
    const max = sorted[sorted.length - 1] ?? 0
    // 先落数字再断言：改造前基线跑（stash 掉 seal.ts 改动）也要能读到 p95/max
    console.log(
      `[seal-batch] sandbox seal-check n=${samples.length} p50=${sorted[Math.floor(samples.length / 2)]?.toFixed(0)}ms p95=${p95.toFixed(0)}ms max=${max.toFixed(0)}ms`,
    )
    // Then p95 stays under the 500ms acceptance line and no single round
    // crosses the old >1s spike threshold (archive-lag 基线 1002–3312ms)
    expect(p95).toBeLessThanOrEqual(500)
    expect(max).toBeLessThanOrEqual(1000)
  })
})
