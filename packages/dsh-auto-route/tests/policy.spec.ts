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

// Ruling defaults after the 2026-10-27 revision: trigger 0.99 (in-flight),
// default line 0.95 (default leg), restore <0.95 (shared), dwell 0.
const config = resolveConfig({})

describe('initialPolicyState', () => {
  it('starts with both legs on the baseline side named after the restore target', () => {
    const state = initialPolicyState('opencode-go', 42)
    expect(state).toEqual({
      phase: 'baseline',
      effectiveSource: 'opencode-go',
      defaultsPhase: 'baseline',
      defaultsSource: 'opencode-go',
      phaseSince: 42,
      defaultsSince: 42,
    })
  })
})

describe('decide — in-flight trigger edge (any window >= 0.99, unrounded)', () => {
  it('holds while every window is below both lines and carries the reading over', () => {
    const state = initialPolicyState('opencode-go', 0)
    const decision = decide(state, reading({ fiveHour: 0.02, week: 0.6, month: 0.5 }), config, 10)
    expect(decision.action).toBe('hold')
    expect(decision.state.phase).toBe('baseline')
    expect(decision.state.lastReading?.windows.week?.ratio).toBe(0.6)
  })

  it('triggers exactly at 0.99 and implies the default leg in the same edge', () => {
    const state = initialPolicyState('opencode-go', 0)
    const decision = decide(state, reading({ week: 0.99 }), config, 10)
    expect(decision.action).toBe('switch')
    expect(decision.state.phase).toBe('triggered')
    expect(decision.state.effectiveSource).toBe('mimo')
    expect(decision.state.defaultsPhase).toBe('triggered')
    expect(decision.state.defaultsSource).toBe('mimo')
    expect(decision.state.defaultsSince).toBe(10)
    expect(decision.state.lastDecision).toBe('trigger')
    expect(decision.state.lastDecisionAt).toBe(10)
    expect(decision.state.phaseSince).toBe(10)
    expect(decision.state.lastTrigger?.ratios.week).toBe(0.99)
    expect(decision.state.lastTrigger?.switched).toBe(0) // counts are stamped by the controller
  })

  it('does not trigger at 0.989999 once the default leg is already up (dead zone)', () => {
    const first = decide(initialPolicyState('opencode-go', 0), reading({ week: 0.95 }), config, 10)
    expect(first.action).toBe('default-switch')
    const second = decide(first.state, reading({ week: 0.989999 }), config, 20)
    expect(second.action).toBe('hold')
    expect(second.state.phase).toBe('baseline')
    expect(second.state.defaultsPhase).toBe('triggered')
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

describe('decide — default-switch edge (any window >= 0.95, default leg only)', () => {
  it('flips only the global default at exactly 0.95 — in-flight stays baseline', () => {
    const state = initialPolicyState('opencode-go', 0)
    const decision = decide(state, reading({ week: 0.95 }), config, 10)
    expect(decision.action).toBe('default-switch')
    expect(decision.state.defaultsPhase).toBe('triggered')
    expect(decision.state.defaultsSource).toBe('mimo')
    expect(decision.state.defaultsSince).toBe(10)
    expect(decision.state.phase).toBe('baseline') // active set untouched
    expect(decision.state.effectiveSource).toBe('opencode-go') // badge still renders Go
    expect(decision.state.lastDecision).toBe('default-switch')
    expect(decision.state.lastDecisionAt).toBe(10)
    expect(decision.state.lastDefaultSwitch?.ratios.week).toBe(0.95)
    expect(decision.state.lastDefaultSwitch?.switched).toBe(0) // counts are stamped by the controller
  })

  it('holds a hair below the default line (0.949999 never rounds up)', () => {
    const state = initialPolicyState('opencode-go', 0)
    const decision = decide(state, reading({ week: 0.949999 }), config, 10)
    expect(decision.action).toBe('hold')
    expect(decision.state.defaultsPhase).toBe('baseline')
    expect(decision.state.defaultsSource).toBe('opencode-go')
  })

  it('does not re-fire while the default leg is already up', () => {
    const first = decide(initialPolicyState('opencode-go', 0), reading({ week: 0.96 }), config, 10)
    expect(first.action).toBe('default-switch')
    const second = decide(first.state, reading({ week: 0.96 }), config, 20)
    expect(second.action).toBe('hold')
    expect(second.state.defaultsPhase).toBe('triggered')
    expect(second.state.defaultsSince).toBe(10) // the engagement timestamp does not slide
    expect(second.state.lastDecision).toBe('default-switch')
  })

  it('an in-flight trigger from a clean baseline engages both legs in one edge', () => {
    const state = initialPolicyState('opencode-go', 0)
    const decision = decide(state, reading({ week: 0.995 }), config, 10)
    expect(decision.action).toBe('switch')
    expect(decision.state.phase).toBe('triggered')
    expect(decision.state.defaultsPhase).toBe('triggered')
    expect(decision.state.defaultsSource).toBe('mimo')
  })

  it('default-only restore brings the default home without ever engaging in-flight', () => {
    const first = decide(initialPolicyState('opencode-go', 0), reading({ week: 0.96 }), config, 10)
    expect(first.action).toBe('default-switch')
    const back = decide(first.state, reading({ fiveHour: 0.05, week: 0.3, month: 0.4 }), config, 1_000)
    expect(back.action).toBe('restore')
    expect(back.state.phase).toBe('baseline')
    expect(back.state.defaultsPhase).toBe('baseline')
    expect(back.state.defaultsSource).toBe('opencode-go')
    expect(back.state.effectiveSource).toBe('opencode-go')
    expect(back.state.lastDecision).toBe('restore')
  })
})

describe('decide — shared restore edge (all three windows < 0.95)', () => {
  const triggered = (at = 100): PolicyState => ({
    phase: 'triggered',
    effectiveSource: 'mimo',
    defaultsPhase: 'triggered',
    defaultsSource: 'mimo',
    phaseSince: at,
    defaultsSince: at,
    lastDecision: 'trigger',
    lastDecisionAt: at,
  })

  it('restores when every window is strictly below the hysteresis line', () => {
    const decision = decide(triggered(), reading({ fiveHour: 0.02, week: 0.3, month: 0.5 }), config, 1_000)
    expect(decision.action).toBe('restore')
    expect(decision.state.phase).toBe('baseline')
    expect(decision.state.defaultsPhase).toBe('baseline')
    expect(decision.state.effectiveSource).toBe('opencode-go')
    expect(decision.state.defaultsSource).toBe('opencode-go')
    expect(decision.state.lastDecision).toBe('restore')
    expect(decision.state.lastRestore?.ratios.week).toBe(0.3)
  })

  it('holds at exactly 0.95 (strict < semantics)', () => {
    const decision = decide(triggered(), reading({ fiveHour: 0.02, week: 0.95, month: 0.5 }), config, 1_000)
    expect(decision.action).toBe('hold')
    expect(decision.state.phase).toBe('triggered')
    expect(decision.reason).toContain('at or above')
  })

  it('holds while a window sits in the 95–99 dead zone (hysteresis)', () => {
    const decision = decide(triggered(), reading({ fiveHour: 0.96, week: 0.5, month: 0.5 }), config, 1_000)
    expect(decision.action).toBe('hold')
    expect(decision.state.phase).toBe('triggered')
    expect(decision.state.defaultsPhase).toBe('triggered')
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
