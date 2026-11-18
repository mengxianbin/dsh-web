import { describe, expect, it } from 'vitest'
import { PROBE_MAX_INTERVAL_MS, PROBE_MIN_INTERVAL_MS } from '../src/v2-probe.ts'
import {
  SETTINGS_READ_TTL_MS,
  WAKE_RETRY_FLOOR_MS,
  makeTtlReader,
  planProbeTimer,
  wakeDelayFor,
} from '../src/v2-timers.ts'

describe('wakeDelayFor', () => {
  it('uses the exact delay for a future deadline', () => {
    expect(wakeDelayFor(10_000, 4_000)).toBe(6_000)
    expect(wakeDelayFor(10_000, 9_999)).toBe(1)
  })

  it('floors an overdue deadline instead of re-arming at 0 ms', () => {
    expect(wakeDelayFor(10_000, 10_000)).toBe(WAKE_RETRY_FLOOR_MS)
    expect(wakeDelayFor(10_000, 25_000)).toBe(WAKE_RETRY_FLOOR_MS)
    expect(WAKE_RETRY_FLOOR_MS).toBeGreaterThan(0)
  })
})

describe('planProbeTimer', () => {
  const now = { immediate: false }
  const urgent = { immediate: true }

  it('clears the timer when no session needs a probe', () => {
    expect(planProbeTimer({ immediate: false }, [])).toEqual({ action: 'clear' })
    expect(planProbeTimer({ immediate: true }, [])).toEqual({ action: 'clear' })
    expect(planProbeTimer(undefined, [])).toEqual({ action: 'keep' })
  })

  it('arms immediately when a route has no cached result', () => {
    expect(planProbeTimer(undefined, [urgent])).toEqual({ action: 'arm', delay: 0 })
    expect(planProbeTimer(undefined, [now, urgent])).toEqual({ action: 'arm', delay: 0 })
  })

  it('arms the randomised cadence when every result is fresh', () => {
    const plan = planProbeTimer(undefined, [now, now], () => 0.5)
    expect(plan.action).toBe('arm')
    if (plan.action !== 'arm') throw new Error('unreachable')
    expect(plan.delay).toBeGreaterThanOrEqual(PROBE_MIN_INTERVAL_MS)
    expect(plan.delay).toBeLessThanOrEqual(PROBE_MAX_INTERVAL_MS)
  })

  it('keeps a pending cadence timer instead of restarting its countdown', () => {
    // Every state change re-arms the loop; resetting the 60-120s countdown on
    // each pass is the starvation that kept the route unprobed forever.
    expect(planProbeTimer({ immediate: false }, [now])).toEqual({ action: 'keep' })
    expect(planProbeTimer({ immediate: false }, [now, now])).toEqual({ action: 'keep' })
  })

  it('keeps a due-now timer rather than clearing it behind the wake timer', () => {
    expect(planProbeTimer({ immediate: true }, [urgent])).toEqual({ action: 'keep' })
    expect(planProbeTimer({ immediate: true }, [now])).toEqual({ action: 'keep' })
  })

  it('promotes a cadence timer to immediate when a route loses its cache', () => {
    expect(planProbeTimer({ immediate: false }, [now, urgent])).toEqual({ action: 'arm', delay: 0 })
  })
})

describe('makeTtlReader', () => {
  it('reads once per TTL and serves the cached value inside it', () => {
    let at = 0
    let reads = 0
    const read = (): number => {
      reads += 1
      return reads
    }
    const reader = makeTtlReader(1_000, read, () => at)

    expect(reader()).toBe(1)
    at = 999
    expect(reader()).toBe(1)
    expect(reads).toBe(1)
    at = 1_000
    expect(reader()).toBe(2)
    expect(reads).toBe(2)
  })

  it('caches an undefined result too, so a settings hiccup costs one TTL', () => {
    let at = 0
    let reads = 0
    const reader = makeTtlReader(SETTINGS_READ_TTL_MS, () => {
      reads += 1
      return undefined
    }, () => at)

    expect(reader()).toBeUndefined()
    at = SETTINGS_READ_TTL_MS - 1
    expect(reader()).toBeUndefined()
    expect(reads).toBe(1)
    at = SETTINGS_READ_TTL_MS
    expect(reader()).toBeUndefined()
    expect(reads).toBe(2)
  })
})
