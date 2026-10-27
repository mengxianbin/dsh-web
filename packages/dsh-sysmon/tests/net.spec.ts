/** NetMonitor windowing/format: TTFT settle, failure counting, stale pruning, warn flag. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_NET_WARN_FAILURES, NET_FAILURE_CODES, NetMonitor, formatNetValue } from '../src/core/net.ts'
import type { SysmonNet } from '../src/core/types.ts'

/** A monitor on a hand-cranked clock. */
function harness(options: ConstructorParameters<typeof NetMonitor>[0] = {}) {
  let now = 1_761_000_000_000
  const monitor = new NetMonitor({ ...options, deps: { now: () => now } })
  return {
    monitor,
    advance(ms: number) { now += ms },
    get now() { return now },
  }
}

const empty: SysmonNet = { ttftMs: null, ttftAt: null, failures: 0, provider: null, warn: false }

describe('NetMonitor', () => {
  it('settles an attempt into a TTFT reading at its first chunk', () => {
    const h = harness()
    h.monitor.noteStart('s:1', 'deepseek')
    h.advance(128)
    h.monitor.noteChunk('s:1')
    expect(h.monitor.snapshot()).toMatchObject({ ttftMs: 128, failures: 0, provider: 'deepseek', warn: false })
    expect(h.monitor.snapshot().ttftAt).toBe(h.now)
  })

  it('ignores chunks after the first and attempts with no start frame', () => {
    const h = harness()
    h.monitor.noteStart('s:1', null)
    h.advance(100)
    h.monitor.noteChunk('s:1')
    h.advance(5_000)
    h.monitor.noteChunk('s:1') // late chunk must not move the reading
    expect(h.monitor.snapshot().ttftMs).toBe(100)
    h.monitor.noteChunk('never-started')
    expect(h.monitor.snapshot().ttftMs).toBe(100)
  })

  it('drops an attempt whose end frame arrives without a chunk', () => {
    const h = harness()
    h.monitor.noteStart('s:1', null)
    h.monitor.noteEnd('s:1')
    h.advance(9_000)
    h.monitor.noteChunk('s:1') // settled after end: no start to pair with
    expect(h.monitor.snapshot()).toEqual(empty)
  })

  it('keeps the newest TTFT across attempts', () => {
    const h = harness()
    h.monitor.noteStart('s:1', null)
    h.advance(300)
    h.monitor.noteChunk('s:1')
    h.monitor.noteStart('s:2', null)
    h.advance(90)
    h.monitor.noteChunk('s:2')
    expect(h.monitor.snapshot().ttftMs).toBe(90)
  })

  it('counts only network-class failure codes', () => {
    const h = harness()
    expect(NET_FAILURE_CODES).toEqual(['TIMEOUT', 'TRANSPORT'])
    h.monitor.noteFailure('deepseek', 'TIMEOUT')
    h.monitor.noteFailure('deepseek', 'TRANSPORT')
    h.monitor.noteFailure('deepseek', 'RATE_LIMIT')
    h.monitor.noteFailure('deepseek', 'CONTEXT_WINDOW_EXCEEDED')
    h.monitor.noteFailure('deepseek', 'ABORTED')
    const snap = h.monitor.snapshot()
    expect(snap.failures).toBe(2)
    expect(snap.warn).toBe(true)
    expect(snap.provider).toBe('deepseek')
  })

  it('reddens at the configured threshold and honours 0 as disabled', () => {
    const strict = harness({ warnFailures: 3 })
    strict.monitor.noteFailure(null, 'TIMEOUT')
    strict.monitor.noteFailure(null, 'TIMEOUT')
    expect(strict.monitor.snapshot().warn).toBe(false)
    strict.monitor.noteFailure(null, 'TRANSPORT')
    expect(strict.monitor.snapshot().warn).toBe(true)

    const off = harness({ warnFailures: 0 })
    off.monitor.noteFailure(null, 'TIMEOUT')
    expect(off.monitor.snapshot().warn).toBe(false)
    expect(off.monitor.snapshot().failures).toBe(1)
    expect(DEFAULT_NET_WARN_FAILURES).toBe(1)
  })

  it('ages everything out of the window — no stale readings', () => {
    const h = harness()
    h.monitor.noteStart('s:1', 'deepseek')
    h.advance(50)
    h.monitor.noteChunk('s:1')
    h.monitor.noteFailure('deepseek', 'TIMEOUT')
    // Orphan a start whose end frame never arrives, inside the window.
    h.monitor.noteStart('s:2', 'deepseek')
    h.advance(600_001)
    expect(h.monitor.snapshot()).toEqual(empty)
    // The orphaned start aged out too: a late chunk stays unheard.
    h.monitor.noteChunk('s:2')
    expect(h.monitor.snapshot()).toEqual(empty)
  })

  it('evicts the oldest pending start beyond the cap', () => {
    const h = harness()
    for (let i = 0; i < 65; i += 1) h.monitor.noteStart(`s:${String(i)}`, null)
    h.advance(10)
    h.monitor.noteChunk('s:0') // evicted first-in
    expect(h.monitor.snapshot().ttftMs).toBeNull()
    h.monitor.noteChunk('s:64')
    expect(h.monitor.snapshot().ttftMs).toBe(10)
  })
})

describe('formatNetValue', () => {
  it('reads dash for an empty window', () => {
    expect(formatNetValue(empty)).toBe('—')
  })

  it('formats latency only, failures only, and both', () => {
    expect(formatNetValue({ ...empty, ttftMs: 128.4 })).toBe('128ms')
    expect(formatNetValue({ ...empty, failures: 3 })).toBe('⚠3')
    expect(formatNetValue({ ...empty, ttftMs: 128.4, failures: 3 })).toBe('128ms ⚠3')
  })

  it('keeps the badge without warn when failures sit below the threshold', () => {
    // The badge is a count, the red state is the threshold's decision — a
    // threshold of 5 shows ⚠2 unreddened.
    expect(formatNetValue({ ...empty, failures: 2 })).toBe('⚠2')
  })
})
