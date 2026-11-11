// @vitest-environment node
/**
 * The analyzeSeal result memo (seal-analyzeseal-cache-1110): an unchanged
 * transcript is served from memory (mtime + size key), an append invalidates
 * it so the verdict recomputes, and warm repeated calls stay inside the
 * p95 <= 200 ms acceptance bound. Contract C1 keeps one implementation, so the
 * memo shared here is the one the seal-check endpoint and the archive gate
 * both read.
 * @module tests/seal-memo.spec
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { beforeEach, describe, expect, it } from 'vitest'
import { analyzeSeal, clearSealMemo, sealMemoStats } from '../src/host/seal.ts'
import { assistantMsg, createFakeHost, userMsg, writeTranscript, type FakeHost } from './fixtures.ts'

const CLEAN_REPLY = '这是最后一条普通回复，不含任何保存信号。'
const PENDING_REPLY = '还有两步没收口。\n\nSAVE_STATUS=PENDING(2)'

function dirOf(host: FakeHost, id: string): string {
  return join(host.home, 'sessions', '--Users-demo--', id.startsWith('session-') ? id.slice('session-'.length) : id)
}

beforeEach(() => {
  clearSealMemo()
})

describe('seal result memo (seal-analyzeseal-cache-1110)', () => {
  it('operator gets the memoized verdict when the transcript is unchanged', () => {
    // Given a transcript already analysed once
    const host = createFakeHost()
    writeTranscript(host, 'session-a', [userMsg('hi'), assistantMsg(CLEAN_REPLY)])
    const dir = dirOf(host, 'session-a')
    const first = analyzeSeal('session-a', dir)
    expect(first).toEqual({ id: 'session-a', verdict: 'NEUTRAL', detail: 'no-save-trace' })
    expect(sealMemoStats()).toEqual({ hits: 0, misses: 1, size: 1 })

    // When the same unchanged transcript is analysed again
    const second = analyzeSeal('session-a', dir)

    // Then the verdict comes from the memo (one derivation, one hit)
    expect(second).toEqual(first)
    expect(sealMemoStats()).toEqual({ hits: 1, misses: 1, size: 1 })
  })

  it('operator gets the recomputed verdict after an append flips the transcript', () => {
    // Given a green NEUTRAL transcript already memoized
    const host = createFakeHost()
    const file = writeTranscript(host, 'session-a', [userMsg('hi'), assistantMsg(CLEAN_REPLY)])
    const dir = dirOf(host, 'session-a')
    expect(analyzeSeal('session-a', dir).verdict).toBe('NEUTRAL')
    expect(sealMemoStats()).toEqual({ hits: 0, misses: 1, size: 1 })

    // When the transcript gains a new frame whose last assistant message ends
    // in a PENDING sentinel (the append pattern real transcripts use)
    const frame = zstdCompressSync(Buffer.from(`${JSON.stringify(assistantMsg(PENDING_REPLY))}\n`, 'utf8'))
    appendFileSync(file, frame)

    // Then the memo key (mtime + size) no longer matches and the verdict
    // recomputes to the appended truth — never the stale green reading.
    expect(analyzeSeal('session-a', dir)).toEqual({ id: 'session-a', verdict: 'UNSEALED', detail: 'sentinel-pending' })
    expect(sealMemoStats()).toEqual({ hits: 0, misses: 2, size: 1 })
  })

  it('operator gets the requested id when a memo hit re-stamps the record', () => {
    // Given one transcript analysed under one id
    const host = createFakeHost()
    writeTranscript(host, 'session-a', [userMsg('hi'), assistantMsg(CLEAN_REPLY)])
    const dir = dirOf(host, 'session-a')
    const first = analyzeSeal('session-a', dir)

    // When the same file is asked for under another id spelling
    const second = analyzeSeal('session-b', dir)

    // Then the memo hit carries the requested id and the same judgement
    expect(second).toEqual({ id: 'session-b', verdict: first.verdict, detail: first.detail })
    expect(sealMemoStats()).toEqual({ hits: 1, misses: 1, size: 1 })
  })

  it('operator gets warm seal reads inside the p95 200 ms bound', () => {
    // Given a memoized verdict (the archive gate / seal-check repeat shape)
    const host = createFakeHost()
    writeTranscript(host, 'session-a', [userMsg('hi'), assistantMsg(CLEAN_REPLY)])
    const dir = dirOf(host, 'session-a')
    analyzeSeal('session-a', dir)

    // When the same transcript is read 30 more times
    const durations: number[] = []
    for (let i = 0; i < 30; i++) {
      const at = performance.now()
      analyzeSeal('session-a', dir)
      durations.push(performance.now() - at)
    }

    // Then every warm call lands inside the acceptance bound (p95 <= 200 ms)
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.ceil(0.95 * durations.length) - 1]
    expect(p95).toBeLessThanOrEqual(200)
    expect(sealMemoStats().hits).toBe(30)
  })
})
