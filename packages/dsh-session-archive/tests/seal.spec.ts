// @vitest-environment node
/**
 * The six-value seal grouping (contract C1) against real multi-frame zstd
 * transcripts: criteria vocabulary copied from the m-note preflight scanner
 * `scripts/dsh/session-sentinel-scan.mjs`, decode per session-forensics
 * 场景十六, transcript selection = highest generation in the session dir.
 * @module tests/seal.spec
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeSeal, isGreenSeal, isStaleSeal, latestTranscriptPath, sealMarker } from '../src/host/seal.ts'
import { SENTINEL_ERA_START } from '../src/host/seal.ts'
import { assistantMsg, createFakeHost, userMsg, writeTranscript, type FakeHost } from './fixtures.ts'

function dirOf(host: FakeHost, id: string): string {
  return join(host.home, 'sessions', '--Users-demo--', id.startsWith('session-') ? id.slice('session-'.length) : id)
}

function withTranscript(host: FakeHost, id: string, events: readonly Record<string, unknown>[], options?: Parameters<typeof writeTranscript>[3]): string {
  return writeTranscript(host, id, events, options)
}

const SAVE_DONE = '三刀全落（`a1` / `b2` / `c3`），status 干净。\n\n## ✅ 执行完成\nSAVE_STATUS=DONE'
const SAVE_NA = '本轮确认无产出。\n\n## ✅ 执行完成\nSAVE_STATUS=N_A'
const SAVE_PENDING = '还有两步没收口。\n\n## ✅ 执行完成\nSAVE_STATUS=PENDING(2)'
const SAVE_TAIL = '## ✅ 执行完成\n保存状态：执行中，稍后继续'
const CLEAN_REPLY = '这是最后一条普通回复，不含任何保存信号。'

/** The endorsement tail save-status.py prints after DONE (背书行形态). */
function endorsedTail(count: number): string {
  return ` commits=${count}/${count} pushedBranch=${count}/${count} merged=${count}/${count} pushedMain=${count}/${count} auditCleaned=yes dirty=0`
}

interface EndorsedRepo {
  dir: string
  hash: string
}

let repoCache: EndorsedRepo | undefined

/** A real git repo whose single commit sits behind an origin remote-tracking ref (hermetic endorsement fixture). */
function endorsedRepo(): EndorsedRepo {
  if (repoCache !== undefined) return repoCache
  const dir = mkdtempSync(join(tmpdir(), 'seal-endorse-'))
  const run = (args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  run(['init', '-q'])
  run(['config', 'user.email', 'seal@test'])
  run(['config', 'user.name', 'seal'])
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'seed'])
  const hash = run(['rev-parse', 'HEAD']).trim()
  run(['update-ref', 'refs/remotes/origin/main', hash])
  repoCache = { dir, hash }
  return repoCache
}

/** Transcript root event carrying the session cwd — the real transcript shape. */
function sessionRoot(id: string, cwd: string): Record<string, unknown> {
  return { type: 'session', version: 4, id, cwd }
}

/** An endorsed DONE report: 落点头 hashes earlier in the message, the endorsement line last. */
function endorsedDone(count: number, hashes: readonly string[]): string {
  const listed = hashes.map((hash) => `\`${hash}\``).join(' + ')
  return `落点头 ${listed} 已推 origin。\n\nSAVE_STATUS=DONE${endorsedTail(count)}`
}

/** The endorsement tail with save-status.py's `hashes=` declared list (seal-declare-verify-1107 新格式). */
function declaredTail(hashes: readonly string[], count = hashes.length): string {
  return `${endorsedTail(count)} hashes=${hashes.join(',')}`
}

/** A DONE report whose endorsement line carries the declared list; prose hashes ride outside it. */
function declaredDone(hashes: readonly string[], proseHashes: readonly string[] = []): string {
  const prose = proseHashes.map((hash) => `\`${hash}\``).join(' + ')
  const lead = prose === '' ? '落点头已声明。' : `正文另提 ${prose}（清单外散文）。`
  return `${lead}\n\nSAVE_STATUS=DONE${declaredTail(hashes)}`
}

describe('seal grouping — green tier', () => {
  it('endorsed DONE sentinel in the last assistant message reads DONE', () => {
    const host = createFakeHost()
    const repo = endorsedRepo()
    withTranscript(host, 'session-a', [
      sessionRoot('session-a', repo.dir),
      userMsg('收口'),
      assistantMsg(endorsedDone(1, [repo.hash])),
    ])
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result).toEqual({ id: 'session-a', verdict: 'DONE', detail: 'sentinel-ok' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it('N_A sentinel in the last assistant message reads N_A', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [assistantMsg(SAVE_NA)])
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result.verdict).toBe('N_A')
    expect(result.detail).toBe('no-artifacts-by-design')
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it('no sentinel and no save trace anywhere reads NEUTRAL', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [userMsg('hello'), assistantMsg(CLEAN_REPLY)])
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result).toEqual({ id: 'session-a', verdict: 'NEUTRAL', detail: 'no-save-trace' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it('work traces without sentinel or save read UNSEALED work-trace-no-sentinel (补法 2026-11-05)', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [
      userMsg('收口了吗'),
      assistantMsg('落点头 = `03a153a0`（修 batch），任务回填进 tasks.md#some-anchor。'),
    ])
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'work-trace-no-sentinel' })
    expect(isGreenSeal(result.verdict)).toBe(false)
  })
})

describe('seal grouping — unsealed tier', () => {
  it('PENDING sentinel in the last assistant message reads sentinel-pending (machine code, no annotation)', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [assistantMsg(SAVE_PENDING)])
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'sentinel-pending' })
  })

  it('save flow stopped in the last assistant message reads save-tail-no-sentinel', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [userMsg('保存'), assistantMsg(SAVE_TAIL)])
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'save-tail-no-sentinel' })
  })

  it('save traces earlier but no sentinel anywhere reads save-trace-no-sentinel', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [
      userMsg('save 进行中：commit 验证已跑'),
      assistantMsg('收到，等验证结果。'),
      assistantMsg(CLEAN_REPLY),
    ])
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'save-trace-no-sentinel' })
  })

  it('sentinel in an earlier message with a continued conversation reads sentinel-stale with followUpCount', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [
      userMsg('save'), // 1
      assistantMsg(SAVE_DONE), // 2 — sentinel lands here
      userMsg('再帮我查一个东西'), // 3
      assistantMsg(CLEAN_REPLY), // 4
    ])
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    // Chat messages strictly after the sentinel-bearing message = 2.
    expect(result).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'sentinel-stale', followUpCount: 2 })
    expect(isStaleSeal(result)).toBe(true)
    expect(isGreenSeal(result.verdict)).toBe(false)
  })
})

describe('seal grouping — legacy cut', () => {
  it('unsealed save session last written before 2026-10-26 reads LEGACY, not UNSEALED', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [assistantMsg(SAVE_TAIL)], { mtimeMs: SENTINEL_ERA_START - 86_400_000 })
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result).toEqual({ id: 'session-a', verdict: 'LEGACY', detail: 'legacy-save-no-sentinel' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it('legacy save sessions with an earlier sentinel also read LEGACY', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [
      assistantMsg(SAVE_DONE),
      assistantMsg(CLEAN_REPLY),
    ], { mtimeMs: SENTINEL_ERA_START - 86_400_000 })
    expect(analyzeSeal('session-a', dirOf(host, 'session-a')).verdict).toBe('LEGACY')
  })

  it('a pre-cut transcript without any save signal still reads NEUTRAL (the cut only downgrades unsealed)', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [userMsg('hi'), assistantMsg('yo')], { mtimeMs: SENTINEL_ERA_START - 86_400_000 })
    expect(analyzeSeal('session-a', dirOf(host, 'session-a')).verdict).toBe('NEUTRAL')
  })
})

describe('seal grouping — unknown tier (解不出/找不到)', () => {
  it('a session with no directory reads UNKNOWN transcript-not-found', () => {
    const host = createFakeHost()
    const result = analyzeSeal('session-missing', dirOf(host, 'session-missing'))
    expect(result).toEqual({ id: 'session-missing', verdict: 'UNKNOWN', detail: 'transcript-not-found' })
  })

  it('a directory without any transcript file reads UNKNOWN transcript-not-found', () => {
    const host = createFakeHost()
    const dir = dirOf(host, 'session-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'no transcript here')
    expect(analyzeSeal('session-a', dir).detail).toBe('transcript-not-found')
  })

  it('an undecodable transcript reads UNKNOWN empty-transcript, never a silent pass', () => {
    const host = createFakeHost()
    // Bytes no zstd frame begins with, under a transcript name.
    const dirA = dirOf(host, 'session-a')
    mkdirSync(dirA, { recursive: true })
    writeFileSync(join(dirA, 'session.jsonl.zstd'), Buffer.alloc(64, 7))
    expect(analyzeSeal('session-a', dirA)).toEqual({ id: 'session-a', verdict: 'UNKNOWN', detail: 'empty-transcript' })
    // Plain text that parses to no events is "解不出" too.
    const dirB = dirOf(host, 'session-b')
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(dirB, 'session.jsonl'), 'this is not jsonl at all')
    expect(analyzeSeal('session-b', dirB)).toEqual({ id: 'session-b', verdict: 'UNKNOWN', detail: 'empty-transcript' })
  })
})

describe('transcript selection — highest generation wins', () => {
  it('the numerically highest generation file carries the verdict', () => {
    const host = createFakeHost()
    // Generation 0 still holds an unfinished save; the migrated generation holds the full history.
    withTranscript(host, 'session-a', [assistantMsg(SAVE_TAIL)], { version: 0 })
    const repo = endorsedRepo()
    withTranscript(host, 'session-a', [
      sessionRoot('session-a', repo.dir),
      assistantMsg(endorsedDone(1, [repo.hash])),
    ], { version: 4 })
    expect(latestTranscriptPath(dirOf(host, 'session-a'))).toBe(join(dirOf(host, 'session-a'), 'session.v4.jsonl.zstd'))
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result.verdict).toBe('DONE')
  })

  it('same generation prefers the compressed spelling', () => {
    const host = createFakeHost()
    const dir = dirOf(host, 'session-a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v2.jsonl'), '')
    writeFileSync(join(dir, 'session.v2.jsonl.zstd'), Buffer.alloc(4, 1))
    expect(latestTranscriptPath(dir)).toBe(join(dir, 'session.v2.jsonl.zstd'))
  })
})

describe('decode — multi-frame transcripts', () => {
  it('a transcript split across two zstd frames still judges as one', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [
      userMsg('开跑'),
      assistantMsg(SAVE_DONE),
      assistantMsg('（帧尾追加）'),
    ], { frames: 2 })
    // The trailing frame appended AFTER the sentinel makes the last assistant message continue.
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result.verdict).toBe('UNSEALED')
    expect(result.detail).toBe('sentinel-stale')
  })
})

describe('seal markers (ledger encoding)', () => {
  it('stale keeps the pinned marker, every other verdict records VERDICT:detail', () => {
    expect(sealMarker({ verdict: 'UNSEALED', detail: 'sentinel-stale' })).toBe('stale')
    expect(sealMarker({ verdict: 'UNSEALED', detail: 'save-tail-no-sentinel' })).toBe('UNSEALED:save-tail-no-sentinel')
    expect(sealMarker({ verdict: 'DONE', detail: 'sentinel-ok' })).toBe('DONE:sentinel-ok')
    expect(sealMarker({ verdict: 'UNKNOWN', detail: 'transcript-not-found' })).toBe('UNKNOWN:transcript-not-found')
  })
})

describe('endorsement recheck — a bare DONE never stays green (seal-noendorse-green-1106)', () => {
  it('operator sees a bare DONE line without commits= demote to UNSEALED no-endorsement', () => {
    // Given a last assistant message asserting DONE with no script endorsement
    const host = createFakeHost()
    const repo = endorsedRepo()
    withTranscript(host, 'session-a', [
      sessionRoot('session-a', repo.dir),
      assistantMsg('收口完成。\n\nSAVE_STATUS=DONE'),
    ])
    // When the seal is judged
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    // Then it leaves the green tier with the scanner's no-endorsement reading
    expect(result).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement' })
    expect(isGreenSeal(result.verdict)).toBe(false)
    expect(sealMarker(result)).toBe('UNSEALED:no-endorsement')
  })

  it('operator keeps DONE green when the endorsed hashes reach a remote-tracking ref', () => {
    // Given a save report whose 落点头 hash sits earlier in the message than the endorsement line
    const host = createFakeHost()
    const repo = endorsedRepo()
    withTranscript(host, 'session-a', [
      sessionRoot('session-a', repo.dir),
      assistantMsg(endorsedDone(1, [repo.hash])),
    ])
    // When the seal is judged, the endorsement recheck finds the hash and its remote ref
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    // Then the DONE verdict stays in the green tier
    expect(result).toEqual({ id: 'session-a', verdict: 'DONE', detail: 'sentinel-ok' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it('operator gets non-green when commits= names a hash no candidate repo holds', () => {
    // Given a line claiming commits=1/1 over a hash no candidate repo holds
    const host = createFakeHost()
    const repo = endorsedRepo()
    withTranscript(host, 'session-a', [
      sessionRoot('session-a', repo.dir),
      assistantMsg(endorsedDone(1, ['f'.repeat(40)])),
    ])
    // When the seal is judged, the endorsement recheck misses the hash
    // Then the endorsement fails and the verdict leaves the green tier
    expect(analyzeSeal('session-a', dirOf(host, 'session-a'))).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement' })
  })

  it('operator gets non-green when one of two endorsed hashes is unreachable', () => {
    // Given commits=2/2 where only one of the two hashes exists in a candidate repo
    const host = createFakeHost()
    const repo = endorsedRepo()
    withTranscript(host, 'session-a', [
      sessionRoot('session-a', repo.dir),
      assistantMsg(endorsedDone(2, [repo.hash, 'e'.repeat(40)])),
    ])
    // When the seal is judged, the recheck walks every hash in the message
    // Then the whole endorsement fails
    expect(analyzeSeal('session-a', dirOf(host, 'session-a'))).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement' })
  })

  it('operator gets non-green when commits= names no backticked hash at all', () => {
    // Given a full endorsement tail that never names a hash to verify
    const host = createFakeHost()
    withTranscript(host, 'session-a', [
      assistantMsg(`收口完成。\n\nSAVE_STATUS=DONE${endorsedTail(1)}`),
    ])
    // When the seal is judged, there is nothing to recheck
    // Then it cannot stay green
    expect(analyzeSeal('session-a', dirOf(host, 'session-a'))).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement' })
  })

  it('operator keeps N_A green without any endorsement recheck', () => {
    // Given a zero-output verdict whose message carries no usable endorsement
    const host = createFakeHost()
    withTranscript(host, 'session-a', [
      assistantMsg(`零产出，无须背书。\`${'d'.repeat(40)}\`\n\nSAVE_STATUS=N_A`),
    ])
    // When the seal is judged, N_A never runs the recheck
    // Then it keeps its green tier
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    expect(result).toEqual({ id: 'session-a', verdict: 'N_A', detail: 'no-artifacts-by-design' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })
})

describe('declared-list endorsement — 核验与声明同源 (seal-declare-verify-1107)', () => {
  it('operator keeps DONE green when a dead hash outside the declared list is prose only', () => {
    // Given an endorsement line declaring one live hash while prose names a dead one
    const host = createFakeHost()
    const repo = endorsedRepo()
    withTranscript(host, 'session-a', [
      sessionRoot('session-a', repo.dir),
      assistantMsg(declaredDone([repo.hash], ['f'.repeat(40)])),
    ])
    // When the seal is judged, only the declared list is verified
    const result = analyzeSeal('session-a', dirOf(host, 'session-a'))
    // Then the DONE verdict stays green — 清单外散文 hash 一概不核
    expect(result).toEqual({ id: 'session-a', verdict: 'DONE', detail: 'sentinel-ok' })
    expect(isGreenSeal(result.verdict)).toBe(true)
  })

  it('operator gets non-green when the declared list itself names a dead hash', () => {
    // Given an endorsement line whose declared list contains a hash no repo holds
    const host = createFakeHost()
    withTranscript(host, 'session-a', [
      assistantMsg(declaredDone(['f'.repeat(40)])),
    ])
    // When the seal is judged, the declared hash fails verification
    // Then the endorsement fails and the verdict leaves the green tier
    expect(analyzeSeal('session-a', dirOf(host, 'session-a'))).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement' })
  })

  it('operator gets non-green when commits= length disagrees with the declared list', () => {
    // Given commits=2/2 while the declared list carries only one hash (篡改/贴错)
    const host = createFakeHost()
    const repo = endorsedRepo()
    withTranscript(host, 'session-a', [
      sessionRoot('session-a', repo.dir),
      assistantMsg(`落点头已声明。\n\nSAVE_STATUS=DONE${declaredTail([repo.hash], 2)}`),
    ])
    // When the seal is judged, the list cannot back the claimed commits count
    // Then the endorsement fails (防伪：commits 与清单长度不符仍红)
    expect(analyzeSeal('session-a', dirOf(host, 'session-a'))).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement' })
  })

  it('operator keeps the legacy message-wide scan when the tail declares no list', () => {
    // Given a legacy tail (no hashes=) whose prose holds a dead hash
    const host = createFakeHost()
    const repo = endorsedRepo()
    withTranscript(host, 'session-a', [
      sessionRoot('session-a', repo.dir),
      assistantMsg(`落点头 \`${repo.hash}\` 已推，另提死 hash \`${'b'.repeat(40)}\`。\n\nSAVE_STATUS=DONE${endorsedTail(1)}`),
    ])
    // When the seal is judged, the legacy path still scans the whole message
    // Then the dead prose hash fails the endorsement exactly as before
    expect(analyzeSeal('session-a', dirOf(host, 'session-a'))).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'no-endorsement' })
  })
})
