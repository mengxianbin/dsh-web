import { describe, expect, it } from 'vitest'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'
import { reusableSessionId } from '../src/core/session-reuse.ts'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'Scheduled', description: '', prompt: 'run' }, 1, 'task-a'),
    ...overrides,
  }
}

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'exec-1',
    sessionId: 'session-a',
    startedAt: 10,
    endedAt: 20,
    result: 'succeeded',
    error: undefined,
    ...overrides,
  }
}

describe('reusableSessionId (#1419)', () => {
  it('continues in the settled session when the task opted in and the session is idle', () => {
    expect(reusableSessionId(task({ reuseSession: true, executions: [execution()] }), new Set(['session-a']))).toBe('session-a')
  })

  it('mints a fresh session when the task did not opt in', () => {
    expect(reusableSessionId(task({ executions: [execution()] }), new Set(['session-a']))).toBeUndefined()
    expect(reusableSessionId(task({ reuseSession: false, executions: [execution()] }), new Set(['session-a']))).toBeUndefined()
  })

  it('never reuses while the roster is unknown', () => {
    expect(reusableSessionId(task({ reuseSession: true, executions: [execution()] }), undefined)).toBeUndefined()
  })

  it('mints a fresh session when the previous session is running or gone', () => {
    const opted = task({ reuseSession: true, executions: [execution()] })
    expect(reusableSessionId(opted, new Set(['session-b']))).toBeUndefined()
    expect(reusableSessionId(opted, new Set())).toBeUndefined()
  })

  it('mints a fresh session when the newest execution is still open or has no session', () => {
    const open = task({ reuseSession: true, executions: [execution({ endedAt: undefined, result: undefined })] })
    expect(reusableSessionId(open, new Set(['session-a']))).toBeUndefined()
    const noSession = task({ reuseSession: true, executions: [execution({ sessionId: undefined })] })
    expect(reusableSessionId(noSession, new Set(['session-a']))).toBeUndefined()
    expect(reusableSessionId(task({ reuseSession: true }), new Set(['session-a']))).toBeUndefined()
  })

  it('follows the newest execution after a reuse chain', () => {
    const chained = task({
      reuseSession: true,
      executions: [execution({ id: 'exec-1' }), execution({ id: 'exec-2', sessionId: 'session-a', startedAt: 30, endedAt: 40 })],
    })
    expect(reusableSessionId(chained, new Set(['session-a']))).toBe('session-a')
    expect(reusableSessionId(chained, new Set(['session-old']))).toBeUndefined()
  })

  it('mints a fresh session when the roster omits the last session (row-cut list shape)', () => {
    // Server row-cut (f5-list-thin-1029): the default session/list no longer
    // returns archived (or subagent) rows, so a previously executed session
    // that has since been archived is simply absent from the roster — reuse
    // must fail closed into a fresh session instead of prompting into a
    // session the host gate would refuse to run.
    const opted = task({ reuseSession: true, executions: [execution({ sessionId: 'session-archived' })] })
    expect(reusableSessionId(opted, new Set(['session-idle-other']))).toBeUndefined()
  })
})
