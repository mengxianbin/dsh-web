/**
 * Archive layering + terminal notification specs (design §5): 子 worker 父归,
 * 根 worker 留人归, 根终态入队待查收通知（黄档）.
 */
import { describe, expect, it } from 'vitest'
import { archivePlan, childrenOf, pendingReceipts } from '../src/core/archive.ts'
import { emptyFsmFile, type FsmFile, type TaskRecord } from '../src/core/schema.ts'

function task(taskRef: string, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    taskRef,
    scope: 'content/tech/ai/dsh',
    state: 'active',
    queue: 'none',
    attempts: { redisp: 0, autofix: 0 },
    history: [],
    ...extra,
  }
}

function fileWith(tasks: TaskRecord[]): FsmFile {
  const file = emptyFsmFile()
  for (const record of tasks) file.tasks[record.taskRef] = record
  return file
}

describe('§5 归档分层', () => {
  it('a parent sees its children (父归面) with their session ids', () => {
    const file = fileWith([
      task('tasks.md#parent', { root: true, state: 'done', pendingAck: true }),
      task('tasks.md#child-a', { parent: 'tasks.md#parent', session: { id: 'session-a', mode: 'active', reason: '' } }),
      task('tasks.md#child-b', { parent: 'tasks.md#parent', session: { id: 'session-b', mode: 'active', reason: '' } }),
      task('tasks.md#other', { parent: 'tasks.md#unrelated' }),
    ])
    expect(childrenOf(file, 'tasks.md#parent').map((r) => r.taskRef)).toEqual(['tasks.md#child-a', 'tasks.md#child-b'])
    const plan = archivePlan(file, 'tasks.md#parent')
    expect(plan.root).toBe(true)
    expect(plan.children).toHaveLength(2)
    expect(plan.childSessions).toEqual(['session-a', 'session-b'])
  })

  it('a root terminal awaiting receipt → notify (黄档) + 留人归', () => {
    const file = fileWith([task('tasks.md#root', { root: true, state: 'done', pendingAck: true })])
    const plan = archivePlan(file, 'tasks.md#root')
    expect(plan.notify).toBe(true)
    expect(plan.leaveToHuman).toBe(true)
  })

  it('a root without pendingAck → no notify (E18 not yet fired)', () => {
    const file = fileWith([task('tasks.md#root', { root: true, state: 'done' })])
    expect(archivePlan(file, 'tasks.md#root').notify).toBe(false)
  })

  it('a sub worker terminal never notifies (根终态才通知, §5)', () => {
    const file = fileWith([task('tasks.md#sub', { parent: 'tasks.md#root', state: 'done', pendingAck: true })])
    const plan = archivePlan(file, 'tasks.md#sub')
    expect(plan.root).toBe(false)
    expect(plan.notify).toBe(false)
    expect(plan.leaveToHuman).toBe(false)
  })

  it('cancelled roots do not notify (通知只对 [x])', () => {
    const file = fileWith([task('tasks.md#root', { root: true, state: 'cancelled', pendingAck: true })])
    expect(archivePlan(file, 'tasks.md#root').notify).toBe(false)
  })

  it('unknown taskRef yields an inert plan (no crash, no archive)', () => {
    expect(archivePlan(emptyFsmFile(), 'tasks.md#ghost')).toEqual({
      taskRef: 'tasks.md#ghost', root: true, children: [], childSessions: [], leaveToHuman: false, notify: false,
    })
  })
})

describe('§5 终态通知队列 (E18 → E19)', () => {
  it('pendingReceipts lists exactly the [x] 待查收 rows, taskRef-ordered', () => {
    const file = fileWith([
      task('tasks.md#z', { root: true, state: 'done', pendingAck: true }),
      task('tasks.md#a', { root: true, state: 'done', pendingAck: true }),
      task('tasks.md#m', { root: true, state: 'done' }),
      task('tasks.md#c', { root: true, state: 'cancelled', pendingAck: true }),
    ])
    expect(pendingReceipts(file).map((r) => r.taskRef)).toEqual(['tasks.md#a', 'tasks.md#z'])
  })
})
