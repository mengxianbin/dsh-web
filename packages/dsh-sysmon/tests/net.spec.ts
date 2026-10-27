/** NetMonitor windowing/format: connection-segment settle, failure counting, stale pruning, warn flag. */
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

const empty: SysmonNet = { connMs: null, connAt: null, connVia: null, ttftMs: null, failures: 0, provider: null, warn: false }

describe('NetMonitor', () => {
  it('settles the pending attempt into a connection reading at secureConnect', () => {
    const h = harness()
    h.monitor.noteStart('s:1', 'deepseek')
    h.advance(42)
    h.monitor.noteConnect(42, 'direct')
    expect(h.monitor.snapshot()).toMatchObject({
      connMs: 42, connVia: 'direct', failures: 0, provider: 'deepseek', warn: false, ttftMs: null,
    })
    expect(h.monitor.snapshot().connAt).toBe(h.now)
  })

  it('ignores connection segments while no attempt is pending (background traffic filter)', () => {
    const h = harness()
    h.monitor.noteConnect(15, 'proxy')
    expect(h.monitor.snapshot()).toEqual(empty)
    // A chunk already closed the window: a connection landing afterwards stays out.
    h.monitor.noteStart('s:1', 'deepseek')
    h.monitor.noteChunk('s:1')
    h.advance(50)
    h.monitor.noteConnect(9, 'direct')
    expect(h.monitor.snapshot().connMs).toBeNull()
  })

  it('attributes segments to the oldest pending attempt, FIFO, and consumes it', () => {
    const h = harness()
    h.monitor.noteStart('s:1', 'deepseek')
    h.monitor.noteStart('s:2', 'pi-ai')
    h.monitor.noteConnect(30, 'direct')
    expect(h.monitor.snapshot()).toMatchObject({ connMs: 30, provider: 'deepseek' })
    h.monitor.noteConnect(75, 'proxy')
    expect(h.monitor.snapshot()).toMatchObject({ connMs: 75, connVia: 'proxy', provider: 'pi-ai' })
    // Both consumed: a third segment has nothing to attribute to.
    h.monitor.noteConnect(99, 'direct')
    expect(h.monitor.snapshot().connMs).toBe(75)
  })

  it('drops an attempt whose end frame arrives before any connection', () => {
    const h = harness()
    h.monitor.noteStart('s:1', null)
    h.monitor.noteEnd('s:1')
    h.monitor.noteConnect(40, 'direct')
    expect(h.monitor.snapshot()).toEqual(empty)
    // The consumed pair leaves nothing behind: later frames find no start.
    h.monitor.noteChunk('s:1')
    expect(h.monitor.snapshot()).toEqual(empty)
  })

  it('keeps the newest connection across attempts and clamps negative spans', () => {
    const h = harness()
    h.monitor.noteStart('s:1', null)
    h.monitor.noteConnect(300, 'direct')
    h.monitor.noteStart('s:2', null)
    h.monitor.noteConnect(-5, 'direct')
    expect(h.monitor.snapshot().connMs).toBe(0)
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
    h.monitor.noteConnect(50, 'direct')
    h.monitor.noteFailure('deepseek', 'TIMEOUT')
    // Orphan a start whose end frame never arrives, inside the window.
    h.monitor.noteStart('s:2', 'deepseek')
    h.advance(600_001)
    expect(h.monitor.snapshot()).toEqual(empty)
    // The orphaned start aged out too: its late segment stays unheard.
    h.monitor.noteConnect(60, 'direct')
    expect(h.monitor.snapshot()).toEqual(empty)
  })

  it('evicts the oldest pending start beyond the cap', () => {
    const h = harness()
    for (let i = 0; i < 65; i += 1) h.monitor.noteStart(`s:${String(i)}`, `p${String(i)}`)
    h.advance(10)
    // s:0 was evicted, so the next segment attributes to s:1.
    h.monitor.noteConnect(10, 'direct')
    expect(h.monitor.snapshot()).toMatchObject({ connMs: 10, provider: 'p1' })
  })
})

describe('formatNetValue', () => {
  it('reads dash for an empty window', () => {
    expect(formatNetValue(empty)).toBe('—')
  })

  it('formats latency only, failures only, and both', () => {
    expect(formatNetValue({ ...empty, connMs: 128.4 })).toBe('128ms')
    expect(formatNetValue({ ...empty, failures: 3 })).toBe('⚠3')
    expect(formatNetValue({ ...empty, connMs: 128.4, failures: 3 })).toBe('128ms ⚠3')
  })

  it('keeps the badge without warn when failures sit below the threshold', () => {
    // The badge is a count, the red state is the threshold's decision — a
    // threshold of 5 shows ⚠2 unreddened.
    expect(formatNetValue({ ...empty, failures: 2 })).toBe('⚠2')
  })

  it('degrades to the dash when a pre-revision host serves no connMs', () => {
    // Reverse of v4's optional-`net` degradation: new client, old host.
    const oldHost = { ...empty, connMs: undefined } as unknown as SysmonNet
    expect(formatNetValue(oldHost)).toBe('—')
    expect(formatNetValue({ ...oldHost, failures: 2 })).toBe('⚠2')
  })
})
