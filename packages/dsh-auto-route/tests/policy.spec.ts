import { describe, expect, it } from 'vitest'
import { decide, initialPolicyState, type PolicyState } from '../src/policy.ts'
import { resolveConfig } from '../src/config.ts'
import type { MeterReading, WindowKey } from '../src/meters.ts'

/** Build a reading from plain ratios (used=ratio*100, limit=100). */
function reading(ratios: Partial<Record<WindowKey, number>>, at = 1_000): MeterReading {
  const windows: MeterReading['windows'] = {}
  for (const [key, ratio] of Object.entries(ratios)) {
    if (ratio === undefined) continue
    windows[key as WindowKey] = { key: key as WindowKey, used: ratio * 100, limit: 100, ratio }
  }
  return { at, windows }
}

const config = resolveConfig({}) // ruling defaults: trigger 0.99, restore <0.70, dwell 0.

describe('initialPolicyState', () => {
  it('starts on the baseline side named after the restore target', () => {
    const state = initialPolicyState('opencode-go', 42)
    expect(state).toEqual({ phase: 'baseline', effectiveSource: 'opencode-go', phaseSince: 42 })
  })
})

describe('decide — trigger edge (any window >= 0.99, unrounded)', () => {
  it('holds while every window is below the line and carries the reading over', () => {
    const state = initialPolicyState('opencode-go', 0)
    const decision = decide(state, reading({ fiveHour: 0.02, week: 0.6, month: 0.5 }), config, 10)
    expect(decision.action).toBe('hold')
    expect(decision.state.phase).toBe('baseline')
    expect(decision.state.lastReading?.windows.week?.ratio).toBe(0.6)
  })

  it('triggers exactly at 0.99 (>= semantics on the unrounded ratio)', () => {
    const state = initialPolicyState('opencode-go', 0)
    const decision = decide(state, reading({ week: 0.99 }), config, 10)
    expect(decision.action).toBe('switch')
    expect(decision.state.phase).toBe('triggered')
    expect(decision.state.effectiveSource).toBe('mimo')
    expect(decision.state.lastDecision).toBe('trigger')
    expect(decision.state.lastDecisionAt).toBe(10)
    expect(decision.state.phaseSince).toBe(10)
    expect(decision.state.lastTrigger?.ratios.week).toBe(0.99)
    expect(decision.state.lastTrigger?.switched).toBe(0) // counts are stamped by the controller
  })

  it('holds a hair below the line (0.989999 never rounds up into the trigger)', () => {
    const state = initialPolicyState('opencode-go', 0)
    const decision = decide(state, reading({ week: 0.989999 }), config, 10)
    expect(decision.action).toBe('hold')
    expect(decision.state.phase).toBe('baseline')
  })

  it('triggers on any single window even when the others are absent', () => {
    const state = initialPolicyState('opencode-go', 0)
    const decision = decide(state, reading({ month: 0.9900001 }), config, 10)
    expect(decision.action).toBe('switch')
    expect(decision.state.lastTrigger?.ratios).toEqual({ month: 0.9900001 })
  })

  it('does not re-trigger while already triggered (no edge, no action)', () => {
    const first = decide(initialPolicyState('opencode-go', 0), reading({ week: 0.99 }), config, 10)
    const second = decide(first.state, reading({ week: 0.995 }), config, 20)
    expect(second.action).toBe('hold')
    expect(second.state.phase).toBe('triggered')
    expect(second.state.effectiveSource).toBe('mimo')
  })

  it('never mutates the input state', () => {
    const state = initialPolicyState('opencode-go', 0)
    const snapshot = JSON.parse(JSON.stringify(state))
    decide(state, reading({ week: 0.99 }), config, 10)
    expect(state).toEqual(snapshot)
  })
})

describe('decide — restore edge (all three windows < 0.70)', () => {
  const triggered = (at = 100): PolicyState => ({
    phase: 'triggered',
    effectiveSource: 'mimo',
    phaseSince: at,
    lastDecision: 'trigger',
    lastDecisionAt: at,
  })

  it('restores when every window is strictly below the hysteresis line', () => {
    const decision = decide(triggered(), reading({ fiveHour: 0.02, week: 0.3, month: 0.5 }), config, 1_000)
    expect(decision.action).toBe('restore')
    expect(decision.state.phase).toBe('baseline')
    expect(decision.state.effectiveSource).toBe('opencode-go')
    expect(decision.state.lastDecision).toBe('restore')
    expect(decision.state.lastRestore?.ratios.week).toBe(0.3)
  })

  it('holds at exactly 0.70 (strict < semantics)', () => {
    const decision = decide(triggered(), reading({ fiveHour: 0.02, week: 0.7, month: 0.5 }), config, 1_000)
    expect(decision.action).toBe('hold')
    expect(decision.state.phase).toBe('triggered')
    expect(decision.reason).toContain('at or above')
  })

  it('holds while any window is still high (hysteresis)', () => {
    const decision = decide(triggered(), reading({ fiveHour: 0.69, week: 0.99, month: 0.69 }), config, 1_000)
    expect(decision.action).toBe('hold')
    expect(decision.state.phase).toBe('triggered')
  })

  it('cannot assert recovery from an incomplete reading (missing window = stay)', () => {
    const decision = decide(triggered(), reading({ fiveHour: 0.02, week: 0.02 }), config, 1_000)
    expect(decision.action).toBe('hold')
    expect(decision.reason).toContain('month')
    expect(decision.state.phase).toBe('triggered')
  })

  it('honors the minimum dwell (0 = off by default)', () => {
    const fast = resolveConfig({ minDwellMs: 60_000 })
    const base = triggered(100)
    const early = decide(base, reading({ fiveHour: 0, week: 0, month: 0 }), fast, 100 + 30_000)
    expect(early.action).toBe('hold')
    expect(early.reason).toContain('dwell')
    const late = decide(base, reading({ fiveHour: 0, week: 0, month: 0 }), fast, 100 + 60_000)
    expect(late.action).toBe('restore')
    const zero = decide(base, reading({ fiveHour: 0, week: 0, month: 0 }), config, 101)
    expect(zero.action).toBe('restore') // ruling: dwell off
  })
})
