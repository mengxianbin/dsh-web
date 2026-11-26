/**
 * E8 acceptance two-state route fixture (判据② of fsm-e1-dispatch-1124): the
 * REAL /api/task-fsm/transition handler over a REAL FsmStore on a scratch
 * file. Green readings land `done` (board `[x]`) with the E8 history entry
 * persisted; red readings answer 409 and leave the store file byte-identical
 * — 机检红不写终态, `[x]` written only through the acceptance-gate writer.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeTaskFsmRoutes } from '../src/host/routes.ts'
import { FsmStore } from '../src/host/store.ts'

const TASK_REF = 'content/tech/ai/dsh/tasks.md#e8-route-fixture'
const SCOPE = 'content/tech/ai/dsh'

interface TransitionBody {
  ok?: boolean
  kind?: string
  guard?: string
  detail?: string
  record?: { state?: string; history?: { event: string }[] }
}

interface FakeRes {
  status: number
  body: string
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Buffer): void
}

function fakeRes(): FakeRes {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      if (body !== undefined) this.body = body.toString()
    },
  }
}

function post(url: string, payload: unknown): IncomingMessage {
  // Buffer chunk: readBoundedJson concats chunks — string chunks would throw
  // inside the route's body reader and surface as a spurious 400.
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]), {
    method: 'POST',
    url,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage
}

type Route = ReturnType<typeof makeTaskFsmRoutes>[number]

async function call(route: Route, payload: unknown): Promise<{ status: number; body: TransitionBody }> {
  const res = fakeRes()
  await route.handler(post(route.path, payload), res as unknown as ServerResponse)
  return { status: res.status, body: res.body === '' ? {} : JSON.parse(res.body) as TransitionBody }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-e8-route-'))
  const file = join(dir, 'task-fsm-state.json')
  const store = new FsmStore(file)
  const routes = makeTaskFsmRoutes({ store, dshHome: dir, maxRedisp: 3 })
  const byPath = (p: string): Route => {
    const route = routes.find((r) => r.path === p)
    if (route === undefined) throw new Error(`route missing: ${p}`)
    return route
  }
  return {
    file,
    store,
    scope: byPath('/api/task-fsm/scope'),
    create: byPath('/api/task-fsm/create'),
    transition: byPath('/api/task-fsm/transition'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** scope → create → E1: land the record in `active` the way dispatch does. */
async function seedActive(t: ReturnType<typeof setup>): Promise<void> {
  const sc = await call(t.scope, { key: SCOPE, prio: 'red', intent: 'dsh 板（E8 路由两态夹具）' })
  expect(sc.status).toBe(200)
  const cr = await call(t.create, {
    taskRef: TASK_REF,
    worktreePlan: '开 worktree .wt/e8-route-fixture 再动手（worktree 预案）',
    scope: SCOPE,
    title: 'E8 路由两态夹具',
  })
  expect(cr.status).toBe(200)
  const e1 = await call(t.transition, { taskRef: TASK_REF, event: 'E1' })
  expect(e1.status).toBe(200)
  expect(e1.body.record?.state).toBe('active')
}

/**
 * scope → create a backlog record, optionally injecting a session node
 * directly (G2 夹具: the session must exist BEFORE E1 fires, so it cannot
 * come from E1 itself).
 */
async function seedBacklog(
  t: ReturnType<typeof setup>,
  session?: { id: string; mode: 'active' | 'frozen' | 'locked'; reason: string },
): Promise<void> {
  const sc = await call(t.scope, { key: SCOPE, prio: 'red', intent: 'dsh 板（G2 改读夹具）' })
  expect(sc.status).toBe(200)
  const cr = await call(t.create, {
    taskRef: TASK_REF,
    worktreePlan: '开 worktree .wt/g2-route-fixture 再动手（worktree 预案）',
    scope: SCOPE,
    title: 'G2 改读夹具',
  })
  expect(cr.status).toBe(200)
  if (session !== undefined) {
    const file = t.store.load()
    file.tasks[TASK_REF]!.session = session
    t.store.save(file)
  }
}

describe('G2 route reads FSM state (fsm-rebind-1126 改读)', () => {
  it('operator sees E1 refused 409 G2 when the FSM record already holds an active session', async () => {
    const t = setup()
    try {
      // Given a backlog record whose FSM session is already bound (切单后 B 的形态)
      await seedBacklog(t, { id: 'session-g2', mode: 'active', reason: '' })
      const before = readFileSync(t.file, 'utf8')
      // When E1 fires for that taskRef
      const e1 = await call(t.transition, { taskRef: TASK_REF, event: 'E1', payload: { sessionId: 'session-g2' } })
      // Then it refuses with guard G2 (FSM 记录有 active 会话) and the store file stays byte-identical
      expect(e1.status).toBe(409)
      expect(e1.body.ok).toBe(false)
      expect(e1.body.guard).toBe('G2')
      expect(e1.body.detail).toContain('FSM 记录有 active 会话')
      expect(readFileSync(t.file, 'utf8')).toBe(before)
      expect(t.store.load().tasks[TASK_REF]?.state).toBe('backlog')
    } finally {
      t.cleanup()
    }
  })

  it('operator sees E1 pass when the bound session id is empty (session.id 空 → 活口径不命中)', async () => {
    const t = setup()
    try {
      // Given a backlog record whose session node carries an empty id
      await seedBacklog(t, { id: '', mode: 'active', reason: '' })
      // When E1 fires for that taskRef
      const e1 = await call(t.transition, { taskRef: TASK_REF, event: 'E1' })
      // Then G2 passes and the record lands active
      expect(e1.status).toBe(200)
      expect(e1.body.record?.state).toBe('active')
    } finally {
      t.cleanup()
    }
  })
})

describe('E8 acceptance gate route two-state (green lands done / red refuses without writing)', () => {
  it('red readings answer 409 G4 and leave the store file byte-identical (机检红不写)', async () => {
    const t = setup()
    try {
      await seedActive(t)
      const before = readFileSync(t.file, 'utf8')
      const red = await call(t.transition, {
        taskRef: TASK_REF,
        event: 'E8',
        evidence: { readings: [{ name: 'oxlint', ok: false }, { name: 'vitest', ok: true }], writer: 'acceptance-gate' },
      })
      expect(red.status).toBe(409)
      expect(red.body.ok).toBe(false)
      expect(red.body.guard).toBe('G4')
      expect(readFileSync(t.file, 'utf8')).toBe(before)
      expect(t.store.load().tasks[TASK_REF]?.state).toBe('active')
    } finally {
      t.cleanup()
    }
  })

  it('a non-gate writer answers 409 G6 even with all-green readings (终态写只许 acceptance-gate)', async () => {
    const t = setup()
    try {
      await seedActive(t)
      const before = readFileSync(t.file, 'utf8')
      const wrong = await call(t.transition, {
        taskRef: TASK_REF,
        event: 'E8',
        evidence: { readings: [{ name: 'vitest', ok: true }], writer: 'human' },
      })
      expect(wrong.status).toBe(409)
      expect(wrong.body.guard).toBe('G6')
      expect(readFileSync(t.file, 'utf8')).toBe(before)
    } finally {
      t.cleanup()
    }
  })

  it('all-green readings through acceptance-gate land done ([x]) with the E8 history persisted', async () => {
    const t = setup()
    try {
      await seedActive(t)
      const green = await call(t.transition, {
        taskRef: TASK_REF,
        event: 'E8',
        evidence: { readings: [{ name: 'vitest', ok: true }, { name: 'typecheck', ok: true }], writer: 'acceptance-gate' },
      })
      expect(green.status).toBe(200)
      expect(green.body.ok).toBe(true)
      expect(green.body.record?.state).toBe('done')
      const reloaded = t.store.load().tasks[TASK_REF]
      expect(reloaded?.state).toBe('done')
      expect(reloaded?.history.some((h) => h.event === 'E8')).toBe(true)
      const onDisk = JSON.parse(readFileSync(t.file, 'utf8')) as { tasks: Record<string, { state: string }> }
      expect(onDisk.tasks[TASK_REF]?.state).toBe('done')
    } finally {
      t.cleanup()
    }
  })
})
