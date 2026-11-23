/**
 * G1–G6 guard specs (design §2.4) — one green + one red case per guard,
 * plus the fail-closed contract: a throwing dependency denies, never passes.
 */
import { describe, expect, it } from 'vitest'
import {
  g1WorktreePlan, g2TaskRef409, g3ScopeRegistered, g4AcceptanceGate,
  g5Heartbeat, g6TerminalWrite, runGuard, type GuardDeps,
} from '../src/core/guards.ts'

function deps(overrides: Partial<GuardDeps> = {}): GuardDeps {
  return {
    taskbookHasWorktreePlan: () => true,
    liveBindings: () => 0,
    scopeRegistered: () => true,
    acceptanceReadings: () => [{ name: 'vitest', ok: true }],
    heartbeat: () => ({ stalled: false, redisp: 0, maxRedisp: 3 }),
    writer: () => 'acceptance-gate',
    ...overrides,
  }
}

describe('G1 worktree 预案闸', () => {
  it('passes with a plan, denies without', () => {
    expect(g1WorktreePlan(deps(), 'ref').ok).toBe(true)
    expect(g1WorktreePlan(deps({ taskbookHasWorktreePlan: () => false }), 'ref').ok).toBe(false)
  })
  it('fails closed when the source throws', () => {
    const result = g1WorktreePlan(deps({ taskbookHasWorktreePlan: () => { throw new Error('boom') } }), 'ref')
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('fail-closed')
  })
})

describe('G2 taskRef 409', () => {
  it('passes at zero live bindings, denies at one', () => {
    expect(g2TaskRef409(deps(), 'ref').ok).toBe(true)
    expect(g2TaskRef409(deps({ liveBindings: () => 1 }), 'ref').ok).toBe(false)
  })
  it('treats NaN (unreadable ledger) as a denial', () => {
    expect(g2TaskRef409(deps({ liveBindings: () => Number.NaN }), 'ref').ok).toBe(false)
  })
})

describe('G3 scope 在册', () => {
  it('passes registered scopes, denies unregistered', () => {
    expect(g3ScopeRegistered(deps(), 'wt/x').ok).toBe(true)
    expect(g3ScopeRegistered(deps({ scopeRegistered: () => false }), 'wt/x').ok).toBe(false)
    expect(g3ScopeRegistered(deps(), '').ok).toBe(true) // empty scope registered by default fake
  })
})

describe('G4 验收闸', () => {
  it('passes all-green readings, denies any red, denies zero readings', () => {
    expect(g4AcceptanceGate(deps()).ok).toBe(true)
    expect(g4AcceptanceGate(deps({ acceptanceReadings: () => [{ name: 'typecheck', ok: true }, { name: 'oxlint', ok: false }] })).ok).toBe(false)
    expect(g4AcceptanceGate(deps({ acceptanceReadings: () => [] })).ok).toBe(false)
  })
})

describe('G5 心跳验活', () => {
  it('passes a live heartbeat under the breaker cap', () => {
    expect(g5Heartbeat(deps()).ok).toBe(true)
  })
  it('denies a stalled heartbeat and a blown redisp cap', () => {
    expect(g5Heartbeat(deps({ heartbeat: () => ({ stalled: true, redisp: 0, maxRedisp: 3 }) })).ok).toBe(false)
    expect(g5Heartbeat(deps({ heartbeat: () => ({ stalled: false, redisp: 3, maxRedisp: 3 }) })).ok).toBe(false)
    expect(g5Heartbeat(deps({ heartbeat: () => ({ stalled: false, redisp: 4, maxRedisp: 3 }) })).ok).toBe(false)
  })
})

describe('G6 终态写权限（§6.2 口径）', () => {
  it('E8 [x] only through acceptance-gate', () => {
    expect(g6TerminalWrite(deps({ writer: () => 'acceptance-gate' }), 'E8').ok).toBe(true)
    expect(g6TerminalWrite(deps({ writer: () => 'human' }), 'E8').ok).toBe(false)
  })
  it('E15/E16 [-] 恒人触发', () => {
    for (const event of ['E15', 'E16'] as const) {
      expect(g6TerminalWrite(deps({ writer: () => 'human' }), event).ok).toBe(true)
      expect(g6TerminalWrite(deps({ writer: () => 'acceptance-gate' }), event).ok).toBe(false)
    }
  })
  it('terminal-row save/ack (E17/E19) accepts both ledger writers, denies others', () => {
    for (const event of ['E17', 'E19'] as const) {
      expect(g6TerminalWrite(deps({ writer: () => 'human' }), event).ok).toBe(true)
      expect(g6TerminalWrite(deps({ writer: () => 'acceptance-gate' }), event).ok).toBe(true)
      expect(g6TerminalWrite(deps({ writer: () => 'other' }), event).ok).toBe(false)
    }
  })
  it('runGuard dispatches every id through the same checks', () => {
    expect(runGuard('G1', deps({ taskbookHasWorktreePlan: () => false }), { taskRef: 'r', scope: 's', event: 'E1' }).ok).toBe(false)
    expect(runGuard('G4', deps(), { taskRef: 'r', scope: 's', event: 'E8' }).ok).toBe(true)
    expect(runGuard('G6', deps({ writer: () => 'human' }), { taskRef: 'r', scope: 's', event: 'E8' }).ok).toBe(false)
  })
})
