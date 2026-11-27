/**
 * C leg spec (fsm-turnend-wire-1126 §3.3) — the sample family from
 * `seal-state.ts`: an event reaches the subscription, the entry call is
 * idempotent, an unbound session does nothing, and teardown is idempotent.
 *
 * What these assert is the HTTP face, not internal bookkeeping: the fake seam
 * records every loopback call and mutates its own record table the way the
 * real `/create` + `/transition` do, so "入机调用幂等" is proved as
 * *exactly one create + one E1 across two turn ends*, not as a flag.
 *
 * The same-entry-judgment clause (防分裂 with the A leg) is covered by the
 * exemption cases: a synthetic anchor and a `bot-boss` session must reach the
 * seam zero times, exactly as `fsm-seam.planSeam` skips them at dispatch.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createTurnEndFsmSync } from '../src/host/turn-end-fsm.ts'
import type { DispatchFsmSeam, FsmSeamResponse } from '../src/host/fsm-seam.ts'

const TASK_REF = 'content/tech/ai/dsh/tasks.md#turn-end-fsm-fixture'
const SESSION = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ORIGIN = 'http://127.0.0.1:3080'

/** One recorded loopback call. */
interface Recorded {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly body?: unknown
}

/** The record table the fake seam serves (mirrors `/state`'s `file.tasks`). */
type TaskTable = Record<string, { state: string }>

/**
 * A loopback seam double: records every call and applies create/E1 the way the
 * real routes do, so a second turn end sees the state the first one wrote.
 */
function fakeFsm(
  initial: TaskTable = {},
  codes: { readonly create?: number; readonly transition?: number } = {},
): { readonly seam: DispatchFsmSeam; readonly calls: Recorded[]; readonly tasks: TaskTable } {
  const tasks: TaskTable = JSON.parse(JSON.stringify(initial)) as TaskTable
  const calls: Recorded[] = []
  const seam: DispatchFsmSeam = {
    async get(): Promise<FsmSeamResponse> {
      calls.push({ method: 'GET', path: 'state' })
      return { status: 200, json: { ok: true, file: { tasks } } }
    },
    async post(_origin, path, body): Promise<FsmSeamResponse> {
      calls.push({ method: 'POST', path, body })
      const ref = (body as { taskRef?: string }).taskRef ?? ''
      if (path === 'create') {
        const code = codes.create ?? 200
        if (code === 200 && tasks[ref] === undefined) tasks[ref] = { state: 'backlog' }
        return { status: code, json: code === 200 ? { ok: true } : { error: 'stub create refused' } }
      }
      if (path === 'transition') {
        const code = codes.transition ?? 200
        if (code === 200 && tasks[ref] !== undefined) tasks[ref]!.state = 'active'
        return { status: code, json: code === 200 ? { ok: true } : { error: 'stub transition refused' } }
      }
      return { status: 404, json: { error: `unknown path ${path}` } }
    },
  }
  return { seam, calls, tasks }
}

/** A context exposing just the `on` table the sync subscribes through. */
function fakeCtx(): { ctx: Context; emit: (event: string, ...args: unknown[]) => void; listeners: Map<string, Set<(...args: unknown[]) => void>> } {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const ctx = {
    on(event: string, listener: (...args: unknown[]) => void): () => void {
      let set = listeners.get(event)
      if (set === undefined) listeners.set(event, set = new Set())
      set.add(listener)
      return () => { set.delete(listener) }
    },
  } as unknown as Context
  return {
    ctx,
    listeners,
    emit: (event, ...args) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
  }
}

/** Drain the microtask queue the entry chain runs on (fake seam resolves immediately). */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

function posts(calls: Recorded[], path: string): Recorded[] {
  return calls.filter((call) => call.method === 'POST' && call.path === path)
}

describe('C leg turn/end → task-FSM entry (样板同族)', () => {
  it('a bound session enters the FSM once; a second turn end adds no calls (spec ① 幂等)', async () => {
    const { ctx, emit } = fakeCtx()
    const { seam, calls } = fakeFsm()
    const sync = createTurnEndFsmSync(ctx, {
      resolveTaskRef: async (id) => (id === SESSION ? TASK_REF : undefined),
      fsm: seam,
      origin: () => ORIGIN,
    })
    sync.start()

    emit('session/event', { id: SESSION }, { type: 'turn/end' })
    await flush()
    expect(posts(calls, 'create')).toHaveLength(1)
    expect(posts(calls, 'transition')).toHaveLength(1)

    emit('session/event', { id: SESSION }, { type: 'turn/end' })
    await flush()
    // Idempotent: the record now reads `active`, so the second turn end writes nothing.
    expect(posts(calls, 'create')).toHaveLength(1)
    expect(posts(calls, 'transition')).toHaveLength(1)
    sync.stop()
  })

  it('an unbound session reaches the seam zero times (spec ② 零动作)', async () => {
    const { ctx, emit } = fakeCtx()
    const { seam, calls } = fakeFsm()
    const sync = createTurnEndFsmSync(ctx, {
      resolveTaskRef: async () => undefined,
      fsm: seam,
      origin: () => ORIGIN,
    })
    sync.start()

    emit('session/event', { id: SESSION }, { type: 'turn/end' })
    emit('session/event', { id: SESSION }, { type: 'assistant/message' })
    await flush()
    expect(calls).toEqual([])
    sync.stop()
  })

  it('teardown is idempotent: stop twice does not throw, the listener is gone, later events are inert (spec ③)', async () => {
    const { ctx, emit, listeners } = fakeCtx()
    const { seam, calls } = fakeFsm()
    const sync = createTurnEndFsmSync(ctx, {
      resolveTaskRef: async () => TASK_REF,
      fsm: seam,
      origin: () => ORIGIN,
    })
    sync.start()
    expect(listeners.get('session/event')?.size).toBe(1)

    expect(() => { sync.stop() }).not.toThrow()
    expect(() => { sync.stop() }).not.toThrow()
    expect(listeners.get('session/event')?.size).toBe(0)

    emit('session/event', { id: SESSION }, { type: 'turn/end' })
    await flush()
    expect(calls).toEqual([])
    // Re-arming after teardown works and the second start does not double-subscribe.
    sync.start()
    expect(listeners.get('session/event')?.size).toBe(1)
    sync.stop()
  })

  it('a record left in `backlog` is advanced with E1 and never re-created', async () => {
    const { ctx, emit } = fakeCtx()
    const { seam, calls } = fakeFsm({ [TASK_REF]: { state: 'backlog' } })
    const sync = createTurnEndFsmSync(ctx, {
      resolveTaskRef: async () => TASK_REF,
      fsm: seam,
      origin: () => ORIGIN,
    })
    sync.start()

    emit('session/event', { id: SESSION }, { type: 'turn/end' })
    await flush()
    expect(posts(calls, 'create')).toHaveLength(0)
    expect(posts(calls, 'transition')).toHaveLength(1)
    sync.stop()
  })

  it('a record past `backlog` is a settled no-op (idempotent face of spec ①)', async () => {
    const { ctx, emit } = fakeCtx()
    const { seam, calls } = fakeFsm({ [TASK_REF]: { state: 'active' } })
    const sync = createTurnEndFsmSync(ctx, {
      resolveTaskRef: async () => TASK_REF,
      fsm: seam,
      origin: () => ORIGIN,
    })
    sync.start()

    emit('session/event', { id: SESSION }, { type: 'turn/end' })
    await flush()
    expect(posts(calls, 'create')).toHaveLength(0)
    expect(posts(calls, 'transition')).toHaveLength(0)
    expect(calls.map((call) => call.path)).toEqual(['state'])
    sync.stop()
  })

  it('exemptions match the dispatch seam: no `#` anchor and bot-boss never enter (防分裂)', async () => {
    const { ctx, emit } = fakeCtx()
    const synthetic = fakeFsm()
    const boss = fakeFsm()
    const syntheticSync = createTurnEndFsmSync(ctx, {
      resolveTaskRef: async () => 'taskbot-takeover-1124',
      fsm: synthetic.seam,
      origin: () => ORIGIN,
    })
    syntheticSync.start()
    emit('session/event', { id: SESSION }, { type: 'turn/end' })
    await flush()
    expect(synthetic.calls).toEqual([])

    const bossSync = createTurnEndFsmSync(ctx, {
      resolveTaskRef: async () => TASK_REF,
      resolveClass: async () => 'bot-boss',
      fsm: boss.seam,
      origin: () => ORIGIN,
    })
    bossSync.start()
    emit('session/event', { id: SESSION }, { type: 'turn/end' })
    await flush()
    expect(boss.calls).toEqual([])

    syntheticSync.stop()
    bossSync.stop()
  })

  it('an unreadable FSM read fails open: zero writes, nothing thrown', async () => {
    const { ctx, emit } = fakeCtx()
    const calls: Recorded[] = []
    const seam: DispatchFsmSeam = {
      async get() {
        calls.push({ method: 'GET', path: 'state' })
        return { status: 0, json: { error: 'fetch failed' } }
      },
      async post(_origin, path, body) {
        calls.push({ method: 'POST', path, body })
        return { status: 200, json: { ok: true } }
      },
    }
    const sync = createTurnEndFsmSync(ctx, {
      resolveTaskRef: async () => TASK_REF,
      fsm: seam,
      origin: () => ORIGIN,
    })
    sync.start()

    expect(() => {
      emit('session/event', { id: SESSION }, { type: 'turn/end' })
    }).not.toThrow()
    await flush()
    expect(posts(calls, 'create')).toHaveLength(0)
    expect(posts(calls, 'transition')).toHaveLength(0)
    sync.stop()
  })

  it('a refused create warns loudly and never throws (fail-open, no deny path)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ctx, emit } = fakeCtx()
      const { seam, calls } = fakeFsm({}, { create: 500 })
      const sync = createTurnEndFsmSync(ctx, {
        resolveTaskRef: async () => TASK_REF,
        fsm: seam,
        origin: () => ORIGIN,
      })
      sync.start()

      expect(() => {
        emit('session/event', { id: SESSION }, { type: 'turn/end' })
      }).not.toThrow()
      await flush()
      expect(posts(calls, 'transition')).toHaveLength(0)
      const line = warn.mock.calls.map((args) => String(args[0])).join('\n')
      expect(line).toContain('[turn-end-fsm]')
      expect(line).toContain(SESSION)
      expect(line).toContain('create')
      sync.stop()
    } finally {
      warn.mockRestore()
    }
  })

  it('an origin that is not bound yet is a loud no-op, not a crash', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ctx, emit } = fakeCtx()
      const { seam, calls } = fakeFsm()
      const sync = createTurnEndFsmSync(ctx, {
        resolveTaskRef: async () => TASK_REF,
        fsm: seam,
        origin: () => { throw new Error('listener not bound') },
      })
      sync.start()

      expect(() => {
        emit('session/event', { id: SESSION }, { type: 'turn/end' })
      }).not.toThrow()
      await flush()
      expect(calls).toEqual([])
      sync.stop()
    } finally {
      warn.mockRestore()
    }
  })
})
