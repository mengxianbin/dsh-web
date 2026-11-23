/**
 * Queue-tier judgment table (§4.1 红/黄/不入三分) + hover four-piece
 * derivation (§4.2). Red purity pins the §4.3 gap-H stance: 主动中止 /
 * 可修机检红 / 配额排队 never enter red or yellow.
 */
import { describe, expect, it } from 'vitest'
import { deriveQueue, queueTier } from '../src/core/queue.ts'
import { deriveSubReasons } from '../src/core/subreason.ts'
import type { TaskRecord } from '../src/core/schema.ts'
import type { State } from '../src/core/table.ts'

function record(state: State, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    taskRef: 'content/tech/ai/dsh/tasks.md#demo',
    scope: 'content/tech/ai/dsh',
    state,
    queue: 'none',
    attempts: { redisp: 0, autofix: 0 },
    history: [{ event: 'E1', from: 'backlog', to: 'active', at: '2026-11-23T12:00:00.000Z' }],
    ...extra,
  }
}

describe('红档 (熔断 · 真异常)', () => {
  it('autofix blowout / irreversible / unknown block cause → red', () => {
    expect(deriveQueue(record('blocked', { cause: 'autofix-blowout' })).tier).toBe('red')
    expect(deriveQueue(record('blocked', { cause: 'irreversible' })).tier).toBe('red')
    expect(deriveQueue(record('blocked', { cause: undefined })).tier).toBe('red')
  })
})

describe('黄档 (缺前置未裁 · 根终态待查收)', () => {
  it('deferred prereq → yellow; done + pendingAck → yellow', () => {
    expect(deriveQueue(record('deferred', { cause: 'prereq-unruled' })).tier).toBe('yellow')
    expect(deriveQueue(record('done', { pendingAck: true })).tier).toBe('yellow')
    expect(deriveQueue(record('done', { pendingAck: true })).reason).toBe('awaiting-ack')
  })
  it('criterion dispute → yellow (判据本体只归用户)', () => {
    expect(deriveQueue(record('blocked', { cause: 'criterion-dispute' })).tier).toBe('yellow')
  })
})

describe('不入 (等外部 · 轮换 · 可修机检红 · 主动中止)', () => {
  it('quota wait stays off the tiers (走冻结行)', () => {
    expect(deriveQueue(record('active', { cause: 'quota-wait' })).tier).toBe('none')
  })
  it('autofix running (可修机检红) stays off the tiers', () => {
    expect(deriveQueue(record('active', { attempts: { redisp: 0, autofix: 2 } })).tier).toBe('none')
  })
  it('chain-dead (机械重派中, 可修) stays off the tiers until the N-cap', () => {
    expect(deriveQueue(record('blocked', { cause: 'chain-dead' })).tier).toBe('none')
  })
  it('cancelled 主动中止 and plain done never queue', () => {
    expect(deriveQueue(record('cancelled', { cause: 'human-abort' })).tier).toBe('none')
    expect(deriveQueue(record('done')).tier).toBe('none')
  })
  it('plain backlog/active idle never queues', () => {
    expect(deriveQueue(record('backlog')).tier).toBe('none')
    expect(deriveQueue(record('active')).tier).toBe('none')
  })
})

describe('queueTier convenience', () => {
  it('matches deriveQueue().tier', () => {
    expect(queueTier(record('blocked', { cause: 'irreversible' }))).toBe('red')
    expect(queueTier(record('deferred', { cause: 'prereq-unruled' }))).toBe('yellow')
  })
})

describe('hover 子原因四件 (§4.2)', () => {
  it('answers 等什么 / 为什么 / 谁 / 下一步 for a yellow deferred row', () => {
    const sub = deriveSubReasons(record('deferred', { cause: 'prereq-unruled' }))
    expect(sub.what).toContain('前置')
    expect(sub.why).toContain('黄档')
    expect(sub.why).toContain('E1')
    expect(sub.who).toBe('人')
    expect(sub.next).not.toBe('')
  })

  it('red blocked rows point at the human with the stop-handling next step', () => {
    const sub = deriveSubReasons(record('blocked', { cause: 'autofix-blowout' }))
    expect(sub.who).toBe('人')
    expect(sub.next).toContain('裁定')
    expect(sub.what).toContain('熔断')
  })

  it('active rows name the worker as owner', () => {
    expect(deriveSubReasons(record('active')).who).toBe('worker')
  })

  it('every answer is non-empty (four-piece never holes)', () => {
    for (const state of ['backlog', 'active', 'deferred', 'blocked', 'done', 'cancelled'] as const) {
      const sub = deriveSubReasons(record(state, { cause: 'prereq-unruled', pendingAck: true }))
      for (const value of [sub.what, sub.why, sub.next]) expect(value, state).not.toBe('')
      expect(['人', 'worker', 'host', '—']).toContain(sub.who)
    }
  })
})
