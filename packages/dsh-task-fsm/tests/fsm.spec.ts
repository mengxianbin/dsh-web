/**
 * Transition applier specs (§2.3/§2.5): happy paths per design row, guard
 * refusals, structured refusals for forbid/na cells, D-axis freeze effects,
 * counter bumps, E18/E19 ack sub-notes, and the E21 dynamic ruling target.
 */
import { describe, expect, it } from 'vitest'
import { applyTransition, type TransitionPayload } from '../src/core/fsm.ts'
import type { GuardDeps } from '../src/core/guards.ts'
import type { TaskRecord } from '../src/core/schema.ts'
import type { EventId, State } from '../src/core/table.ts'

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

function record(state: State, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    taskRef: 'content/tech/ai/dsh/tasks.md#demo',
    scope: 'content/tech/ai/dsh',
    state,
    queue: 'none',
    attempts: { redisp: 0, autofix: 0 },
    history: [],
    ...extra,
  }
}

const at = '2026-11-23T12:00:00.000Z'
const payload: TransitionPayload = { at }

describe('E1 dispatch (预立行, §3.1)', () => {
  it('backlog → active with a frozen queue-position mark carrying the reason', () => {
    const result = applyTransition(record('backlog'), 'E1', deps(), { ...payload, sessionId: 'session-abc' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.state).toBe('active')
    expect(result.record.session).toEqual({ id: 'session-abc', mode: 'frozen', reason: '排队位：等待开工核验' })
    expect(result.record.history).toHaveLength(1)
  })

  it('refuses when G2 sees a live binding (409 防双跑)', () => {
    const result = applyTransition(record('backlog'), 'E1', deps({ liveBindings: () => 2 }), payload)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('guard-refused')
    expect(result.guard).toBe('G2')
  })

  it('refuses when G1 sees no worktree 预案', () => {
    const result = applyTransition(record('backlog'), 'E1', deps({ taskbookHasWorktreePlan: () => false }), payload)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.guard).toBe('G1')
  })

  it('refuses when G3 scope is unregistered (开 scope 归人)', () => {
    const result = applyTransition(record('backlog'), 'E1', deps({ scopeRegistered: () => false }), payload)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.guard).toBe('G3')
  })
})

describe('active lifecycle rows', () => {
  it('E3 plan-missing rolls back to backlog with the mark cleared', () => {
    const started = record('active', { session: { id: 's1', mode: 'active', reason: '' } })
    const result = applyTransition(started, 'E3', deps(), payload)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.state).toBe('backlog')
    expect(result.record.session).toEqual({ id: 's1', mode: 'active', reason: '' })
    expect(result.record.cause).toBe('plan-missing')
  })

  it('E4 步进 keeps state and marks the session active (quota-wait wake path)', () => {
    const queued = record('active', {
      session: { id: 's1', mode: 'frozen', reason: '等配额' }, cause: 'quota-wait',
    })
    const result = applyTransition(queued, 'E4', deps(), payload)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.state).toBe('active')
    expect(result.record.session?.mode).toBe('active')
    expect(result.record.cause).toBe('quota-wait') // wake releases the mark, cause clears on next transition
  })

  it('E5 缺前置 freezes into deferred with the prereq cause (queue = yellow)', () => {
    const result = applyTransition(record('active', { session: { id: 's1', mode: 'active', reason: '' } }), 'E5', deps(), payload)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.state).toBe('deferred')
    expect(result.record.session?.mode).toBe('frozen')
    expect(result.record.cause).toBe('prereq-unruled')
    expect(result.record.queue).toBe('yellow')
  })

  it('E8 验收过 runs G4+G6 and lands done with queue none', () => {
    const ok = applyTransition(record('active'), 'E8', deps(), payload)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.record.state).toBe('done')
      expect(ok.record.queue).toBe('none')
    }
    const red = applyTransition(record('active'), 'E8', deps({ acceptanceReadings: () => [{ name: 'oxlint', ok: false }] }), payload)
    expect(red.ok).toBe(false)
    const wrongWriter = applyTransition(record('active'), 'E8', deps({ writer: () => 'human' }), payload)
    expect(wrongWriter.ok).toBe(false)
  })

  it('E9 bumps the autofix counter and stays active (可修机检红 不入队)', () => {
    const result = applyTransition(record('active'), 'E9', deps(), payload)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.attempts.autofix).toBe(1)
    expect(result.record.queue).toBe('none')
  })

  it('E10 熔断 → blocked with red queue; E11 争议 → yellow; E12 不可逆 → red', () => {
    const e10 = applyTransition(record('active'), 'E10', deps(), payload)
    expect(e10.ok && e10.record.queue).toBe('red')
    const e11 = applyTransition(record('active'), 'E11', deps(), payload)
    expect(e11.ok && e11.record.queue).toBe('yellow')
    const e12 = applyTransition(record('active'), 'E12', deps(), payload)
    expect(e12.ok && e12.record.queue).toBe('red')
  })

  it('E15 人中止 requires human writer and lands cancelled', () => {
    const asHuman = applyTransition(record('active'), 'E15', deps({ writer: () => 'human' }), payload)
    expect(asHuman.ok).toBe(true)
    if (asHuman.ok) expect(asHuman.record.state).toBe('cancelled')
    const asGate = applyTransition(record('active'), 'E15', deps({ writer: () => 'acceptance-gate' }), payload)
    expect(asGate.ok).toBe(false)
  })
})

describe('blocked / waiting rows', () => {
  it('E13 断链 bumps redisp and lands blocked; G5 blows the cap at N', () => {
    const alive = applyTransition(record('active'), 'E13', deps(), payload)
    expect(alive.ok).toBe(true)
    if (alive.ok) {
      expect(alive.record.state).toBe('blocked')
      expect(alive.record.attempts.redisp).toBe(1)
    }
    const blown = applyTransition(record('active'), 'E13', deps({ heartbeat: () => ({ stalled: false, redisp: 3, maxRedisp: 3 }) }), payload)
    expect(blown.ok).toBe(false)
    if (!blown.ok) expect(blown.guard).toBe('G5')
  })

  it('E14 机械重派 unblocks when 409+breaker clear, refuses at the cap', () => {
    const blocked = record('blocked', { cause: 'chain-dead' })
    const ok = applyTransition(blocked, 'E14', deps(), payload)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.record.state).toBe('active')
      expect(ok.record.cause).toBeUndefined()
    }
    const cap = applyTransition(blocked, 'E14', deps({ heartbeat: () => ({ stalled: false, redisp: 3, maxRedisp: 3 }) }), payload)
    expect(cap.ok).toBe(false)
    const dual = applyTransition(blocked, 'E14', deps({ liveBindings: () => 1 }), payload)
    expect(dual.ok).toBe(false)
  })

  it('E6 前置终态 releases the freeze back to active (wake trigger 1)', () => {
    const waiting = record('deferred', {
      cause: 'prereq-unruled', session: { id: 's1', mode: 'frozen', reason: '等前置' },
    })
    const result = applyTransition(waiting, 'E6', deps(), payload)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.state).toBe('active')
    expect(result.record.session?.mode).toBe('active')
    expect(result.record.cause).toBeUndefined()
  })

  it('E20 等待开始 re-freezes deferred with no residency (不驻留)', () => {
    const result = applyTransition(record('deferred'), 'E20', deps(), { ...payload, reason: '等前置' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.state).toBe('deferred')
    expect(result.record.session?.mode).toBe('frozen')
  })

  it('E21 needs the ruling receipt and resolves the dynamic target', () => {
    const blocked = record('blocked', { cause: 'criterion-dispute' })
    const noReceipt = applyTransition(blocked, 'E21', deps(), payload)
    expect(noReceipt.ok).toBe(false)
    if (!noReceipt.ok) expect(noReceipt.kind).toBe('token-refused')
    const ruled = applyTransition(blocked, 'E21', deps(), { ...payload, rulingReceipt: true, to: 'active' })
    expect(ruled.ok).toBe(true)
    if (ruled.ok) {
      expect(ruled.record.state).toBe('active')
      expect(ruled.record.cause).toBeUndefined()
    }
    const missingTarget = applyTransition(blocked, 'E21', deps(), { ...payload, rulingReceipt: true })
    expect(missingTarget.ok).toBe(false)
  })
})

describe('terminal rows (§5 终态通知 + §6.2 走闸)', () => {
  it('E18 marks pendingAck + yellow; E19 clears it only with a human receipt', () => {
    const done = record('done')
    const notify = applyTransition(done, 'E18', deps(), payload)
    expect(notify.ok).toBe(true)
    if (!notify.ok) return
    expect(notify.record.pendingAck).toBe(true)
    expect(notify.record.queue).toBe('yellow')

    const early = applyTransition(notify.record, 'E19', deps(), payload) // ack token present but writer human — ok
    expect(early.ok).toBe(true)

    const noAck = applyTransition(done, 'E19', deps(), payload)
    expect(noAck.ok).toBe(false)
    if (!noAck.ok) expect(noAck.kind).toBe('token-refused')

    const wrongWriter = applyTransition(notify.record, 'E19', deps({ writer: () => 'other' }), payload)
    expect(wrongWriter.ok).toBe(false)
  })

  it('E17 save on a terminal row runs G6 and keeps the state', () => {
    const result = applyTransition(record('done'), 'E17', deps({ writer: () => 'human' }), payload)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.state).toBe('done')
    const denied = applyTransition(record('done'), 'E17', deps({ writer: () => 'other' }), payload)
    expect(denied.ok).toBe(false)
  })
})

describe('structured refusals (never silent)', () => {
  it('forbidden cell → kind forbidden with the table reason', () => {
    const result = applyTransition(record('active'), 'E1', deps(), payload)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('forbidden')
      expect(result.detail).toContain('409')
    }
  })

  it('na cell → kind not-applicable', () => {
    const result: ReturnType<typeof applyTransition> = applyTransition(record('done'), 'E4', deps(), payload)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('not-applicable')
  })

  it('every accepted transition appends history and re-derives the queue', () => {
    const events: { state: State; event: EventId }[] = [
      { state: 'backlog', event: 'E1' },
      { state: 'active', event: 'E10' },
      { state: 'blocked', event: 'E16' },
    ]
    for (const step of events) {
      // human writer: E16 runs G6 ([-] 恒人触发 §6.2); E1/G10 writers irrelevant.
      const result = applyTransition(record(step.state), step.event, deps({ writer: () => 'human' }), { ...payload, sessionId: 's', to: 'active', rulingReceipt: true })
      expect(result.ok, `${step.state} × ${step.event}`).toBe(true)
      if (result.ok) {
        const last = result.record.history[result.record.history.length - 1]
        expect(last).toMatchObject({ event: step.event, from: step.state, at })
        expect(['none', 'red', 'yellow']).toContain(result.record.queue)
      }
    }
  })
})
