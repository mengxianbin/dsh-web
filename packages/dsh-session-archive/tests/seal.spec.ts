// @vitest-environment node
/**
 * The six-value seal grouping (contract C1) against real multi-frame zstd
 * transcripts: criteria vocabulary copied from the m-note preflight scanner
 * `scripts/dsh/session-sentinel-scan.mjs`, decode per session-forensics
 * 场景十六, transcript selection = highest generation in the session dir.
 * @module tests/seal.spec
 */

import { mkdirSync, writeFileSync } from 'node:fs'
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

describe('seal grouping — green tier', () => {
  it('DONE sentinel in the last assistant message reads DONE', () => {
    const host = createFakeHost()
    withTranscript(host, 'session-a', [
      userMsg('收口'),
      assistantMsg(SAVE_DONE),
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
    withTranscript(host, 'session-a', [
      { type: 'session', data: { id: 'session-a' } },
      assistantMsg(SAVE_DONE),
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
