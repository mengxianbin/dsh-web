/** NetMonitor windowing/format: probe-RTT recording + staleness, failure counting, warn flag. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_NET_WARN_FAILURES, NET_FAILURE_CODES, RTT_STALE_MS, NetMonitor, formatNetValue } from '../src/core/net.ts'
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

const empty: SysmonNet = { rttMs: null, rttAt: null, probe: null, connMs: null, connAt: null, connVia: null, ttftMs: null, failures: 0, provider: null, warn: false }

describe('NetMonitor', () => {
  it('records a probe round trip with the stub fields retired to null', () => {
    const h = harness({ probe: 'api.deepseek.com' })
    h.monitor.noteRtt(19)
    expect(h.monitor.snapshot()).toMatchObject({
      rttMs: 19, rttAt: h.now, probe: 'api.deepseek.com', failures: 0, provider: null, warn: false,
      connMs: null, connAt: null, connVia: null, ttftMs: null,
    })
  })

  it('records nothing for a failed probe — the last good reading stands', () => {
    const h = harness()
    h.monitor.noteRtt(23)
    h.advance(60_000)
    h.monitor.noteRtt(null)
    expect(h.monitor.snapshot().rttMs).toBe(23)
    // A failure before any success never invents a value.
    const fresh = harness()
    fresh.monitor.noteRtt(null)
    expect(fresh.monitor.snapshot().rttMs).toBeNull()
  })

  it('ages the reading out past the staleness bound — no stale RTT', () => {
    const h = harness()
    h.monitor.noteRtt(19)
    h.advance(RTT_STALE_MS - 1)
    expect(h.monitor.snapshot().rttMs).toBe(19)
    h.advance(2)
    expect(h.monitor.snapshot().rttMs).toBeNull()
    expect(h.monitor.snapshot().rttAt).toBeNull()
  })

  it('clamps a negative span', () => {
    const h = harness()
    h.monitor.noteRtt(-5)
    expect(h.monitor.snapshot().rttMs).toBe(0)
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

  it('keeps the route label bound to counted failures: a probe round never invents or extends it', () => {
    const h = harness()
    h.monitor.noteFailure('deepseek', 'TIMEOUT')
    h.advance(600_001)
    // The failure aged out of the window: label gone even though a fresh
    // probe round just landed (the probe has no provider route).
    h.monitor.noteRtt(19)
    expect(h.monitor.snapshot()).toMatchObject({ rttMs: 19, failures: 0, provider: null })
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

  it('ages failures out of the window — no stale counts or labels', () => {
    const h = harness()
    h.monitor.noteFailure('deepseek', 'TIMEOUT')
    h.advance(600_001)
    expect(h.monitor.snapshot()).toEqual(empty)
  })
})

describe('formatNetValue', () => {
  it('reads dash for an empty reading', () => {
    expect(formatNetValue(empty)).toBe('—')
  })

  it('formats rtt only, failures only, and both', () => {
    expect(formatNetValue({ ...empty, rttMs: 19.4 })).toBe('19ms')
    expect(formatNetValue({ ...empty, failures: 3 })).toBe('⚠3')
    expect(formatNetValue({ ...empty, rttMs: 19.6, failures: 3 })).toBe('20ms ⚠3')
  })

  it('keeps the badge without warn when failures sit below the threshold', () => {
    // The badge is a count, the red state is the threshold's decision — a
    // threshold of 5 shows ⚠2 unreddened.
    expect(formatNetValue({ ...empty, failures: 2 })).toBe('⚠2')
  })

  it('degrades to the dash when a pre-A-case host serves no rttMs', () => {
    // Reverse window of the A-case wire change: new client, old host — the
    // payload still carries the retired connMs reading, no rttMs.
    const oldHost = { ...empty, rttMs: undefined, connMs: 477 } as unknown as SysmonNet
    expect(formatNetValue(oldHost)).toBe('—')
    expect(formatNetValue({ ...oldHost, failures: 2 })).toBe('⚠2')
  })
})
