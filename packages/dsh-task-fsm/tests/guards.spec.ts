/**
 * G1–G6 guard specs (design §2.4) — one green + one red case per guard,
 * plus the fail-closed contract: a throwing dependency denies, never passes.
 * G2 reads FSM state (fsm-rebind-1126): its three liveness states are
 * asserted through the real `makeHostDeps` source, not a fake counter.
 */
import { describe, expect, it } from 'vitest'
import {
  g1WorktreePlan, g2TaskRef409, g3ScopeRegistered, g4AcceptanceGate,
  g5Heartbeat, g6TerminalWrite, runGuard, type GuardDeps,
} from '../src/core/guards.ts'
import { makeHostDeps } from '../src/host/sources.ts'
import type { FsmFile, TaskRecord } from '../src/core/schema.ts'
import type { State } from '../src/core/table.ts'

function deps(overrides: Partial<GuardDeps> = {}): GuardDeps {
  return {
    taskbookHasWorktreePlan: () => true,
    liveTaskSessions: () => 0,
    scopeRegistered: () => true,
    acceptanceReadings: () => [{ name: 'vitest', ok: true }],
    heartbeat: () => ({ stalled: false, redisp: 0, maxRedisp: 3 }),
    writer: () => 'acceptance-gate',
    ...overrides,
  }
}

/** One-record fsm file wired through the REAL G2 source (fsm-rebind-1126). */
function fileWith(taskRef: string, state: State, session?: TaskRecord['session']): FsmFile {
  const record: TaskRecord = {
    version: 1,
    taskRef,
    scope: 'content/tech/ai/dsh',
    state,
    queue: 'none',
    attempts: { redisp: 0, autofix: 0 },
    history: [],
    ...(session === undefined ? {} : { session }),
  }
  return { version: 1, scopes: {}, tasks: { [taskRef]: record } }
}

function g2OnFile(file: FsmFile, taskRef: string): ReturnType<typeof g2TaskRef409> {
  return g2TaskRef409(makeHostDeps({ dshHome: '', file, evidence: {}, maxRedisp: 3, redisp: 0 }), taskRef)
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

describe('G2 taskRef 409 (fsm-rebind-1126 改读 FSM state)', () => {
  it('operator sees G2 deny when the counter reports a live session and pass at zero', () => {
    // Given G2 wired with a source that counts one live session for the ref
    // When the guard runs against that dep
    // Then it denies; at zero live sessions it passes
    expect(g2TaskRef409(deps({ liveTaskSessions: () => 1 }), 'ref').ok).toBe(false)
    expect(g2TaskRef409(deps(), 'ref').ok).toBe(true)
  })
  it('operator sees G2 fail closed when the state read returns NaN (unreadable)', () => {
    // Given G2 wired with an unreadable-state source (NaN, 照现形)
    // When the guard runs
    // Then it denies with the fail-closed wording, never passes
    const result = g2TaskRef409(deps({ liveTaskSessions: () => Number.NaN }), 'ref')
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('fail-closed')
  })
  it('operator sees the three liveness states read off the fsm file itself', () => {
    // Given one fsm file per state: active+bound session / backlog no session /
    //      done+bound session / active+empty session id
    // When G2 runs through the real makeHostDeps source over each file
    // Then only active+bound-session denies; backlog, terminal and empty-id pass
    const bound = { id: 'session-1', mode: 'active' as const, reason: '' }
    const emptyId = { id: '', mode: 'active' as const, reason: '' }
    const active = g2OnFile(fileWith('ref', 'active', bound), 'ref')
    expect(active.ok).toBe(false)
    expect(active.detail).toBe('FSM 记录有 active 会话（409 防双跑）')
    expect(g2OnFile(fileWith('ref', 'backlog'), 'ref').ok).toBe(true)
    expect(g2OnFile(fileWith('ref', 'done', bound), 'ref').ok).toBe(true)
    expect(g2OnFile(fileWith('ref', 'active', emptyId), 'ref').ok).toBe(true)
    // Given a record whose state cannot be read at all (corrupt value)
    // When G2 runs over that file
    // Then it fails closed (NaN → deny), never waves the dispatch through
    const corrupt = fileWith('ref', 'active')
    corrupt.tasks.ref!.state = 42 as unknown as State
    const unreadable = g2OnFile(corrupt, 'ref')
    expect(unreadable.ok).toBe(false)
    expect(unreadable.detail).toContain('fail-closed')
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
