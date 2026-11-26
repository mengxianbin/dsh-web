/**
 * Session view route fixture (freeze-bind-button-1126 分期 3, acceptance ④):
 * the REAL GET /api/task-fsm/session handler over a REAL FsmStore on a
 * scratch file. A bound row answers 200 with the frozen view the UI freeze
 * mark renders from; an unknown id answers 404 (the FsmFrozenWatcher stop
 * rule); an empty id never resolves even while session-less records sit in
 * the store — the binding gap's read-side seal.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeTaskFsmRoutes } from '../src/host/routes.ts'
import { FsmStore } from '../src/host/store.ts'

const TASK_REF = 'content/tech/ai/dsh/tasks.md#session-route-fixture'
const UNBOUND_REF = 'content/tech/ai/dsh/tasks.md#session-route-unbound'
const SCOPE = 'content/tech/ai/dsh'
const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'

interface SessionBody {
  ok?: boolean
  found?: boolean
  view?: { session?: { id?: string; mode?: string; reason?: string } }
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

function get(url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage
}

type Route = ReturnType<typeof makeTaskFsmRoutes>[number]

async function call(route: Route, req: IncomingMessage): Promise<{ status: number; body: SessionBody }> {
  const res = fakeRes()
  await route.handler(req, res as unknown as ServerResponse)
  return { status: res.status, body: res.body === '' ? {} : JSON.parse(res.body) as SessionBody }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-session-route-'))
  const store = new FsmStore(join(dir, 'task-fsm-state.json'))
  const routes = makeTaskFsmRoutes({ store, dshHome: dir, maxRedisp: 3 })
  const byPath = (p: string): Route => {
    const route = routes.find((r) => r.path === p)
    if (route === undefined) throw new Error(`route missing: ${p}`)
    return route
  }
  return {
    store,
    scope: byPath('/api/task-fsm/scope'),
    create: byPath('/api/task-fsm/create'),
    transition: byPath('/api/task-fsm/transition'),
    session: byPath('/api/task-fsm/session'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

async function post(route: Route, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]), {
    method: 'POST',
    url: route.path,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage
  const res = fakeRes()
  await route.handler(req, res as unknown as ServerResponse)
  return { status: res.status, body: res.body === '' ? {} : JSON.parse(res.body) as Record<string, unknown> }
}

/** scope → create → E1 (with optional sessionId): land a record the way dispatch does. */
async function seed(t: ReturnType<typeof setup>, taskRef: string, title: string, sessionId?: string): Promise<void> {
  const sc = await post(t.scope, { key: SCOPE, prio: 'yellow', intent: 'dsh 板（session 路由夹具）' })
  // Idempotent re-declare: a second seed in the same store answers 409.
  expect([200, 409]).toContain(sc.status)
  const cr = await post(t.create, {
    taskRef,
    worktreePlan: '开 worktree .wt/session-route-fixture 再动手（worktree 预案）',
    scope: SCOPE,
    title,
  })
  expect(cr.status).toBe(200)
  const payload: Record<string, unknown> = { taskRef, event: 'E1' }
  if (sessionId !== undefined) payload.payload = { sessionId }
  const e1 = await post(t.transition, payload)
  expect(e1.status).toBe(200)
}

describe('GET /api/task-fsm/session (bound 200 / unknown 404 / empty id never resolves)', () => {
  it('a bound record answers 200 with the frozen view the UI mark renders from', async () => {
    const t = setup()
    try {
      await seed(t, TASK_REF, 'session 路由夹具', SESSION_ID)
      // Acceptance ① reading: E1 carried sessionId into the record.
      expect(t.store.load().tasks[TASK_REF]?.session?.id).toBe(SESSION_ID)
      const hit = await call(t.session, get(`/api/task-fsm/session?id=${encodeURIComponent(SESSION_ID)}`))
      expect(hit.status).toBe(200)
      expect(hit.body.ok).toBe(true)
      expect(hit.body.found).toBe(true)
      expect(hit.body.view?.session?.id).toBe(SESSION_ID)
      // E1 queue-position freeze: the mark renders on frozen with a reason.
      expect(hit.body.view?.session?.mode).toBe('frozen')
      expect(hit.body.view?.session?.reason ?? '').not.toBe('')
    } finally {
      t.cleanup()
    }
  })

  it('an unknown session id answers 404 found:false (watcher stop rule)', async () => {
    const t = setup()
    try {
      await seed(t, TASK_REF, 'session 路由夹具', SESSION_ID)
      const miss = await call(t.session, get('/api/task-fsm/session?id=session-unknown'))
      expect(miss.status).toBe(404)
      expect(miss.body.ok).toBe(false)
      expect(miss.body.found).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it('an empty id never resolves even while a session-less record exists', async () => {
    const t = setup()
    try {
      await seed(t, TASK_REF, 'session 路由夹具', SESSION_ID)
      await seed(t, UNBOUND_REF, 'session 路由夹具（未绑）')
      const unbound = t.store.load().tasks[UNBOUND_REF]
      expect(unbound?.session?.id).toBe('')
      const empty = await call(t.session, get('/api/task-fsm/session?id='))
      expect(empty.status).toBe(404)
      expect(empty.body.ok).toBe(false)
      expect(empty.body.found).toBe(false)
    } finally {
      t.cleanup()
    }
  })
})
