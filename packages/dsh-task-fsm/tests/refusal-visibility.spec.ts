/**
 * S3 refusal visibility (fsm-seam-archive-build-1125, 判据③): the host
 * refusal branches (only 404/409) now leave a `console.warn` carrying
 * taskRef/event/detail — the previously half-silent host log face — and the
 * 404 body gains a `hint` field while the 404 semantics stay byte-identical
 * (`error` unchanged; hint is additive). Success paths add zero logs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeTaskFsmRoutes } from '../src/host/routes.ts'
import { FsmStore } from '../src/host/store.ts'

const SCOPE = 'content/tech/ai/dsh'
const KNOWN_REF = 'content/tech/ai/dsh/tasks.md#refusal-fixture'
const UNKNOWN_REF = 'content/tech/ai/dsh/tasks.md#refusal-unknown'
const PLAN = 'worktree 预案 = 开 .wt/refusal 夹具后动手'

interface RouteBody {
  ok?: boolean
  error?: string
  hint?: string
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

function req(url: string, payload: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]), {
    method: 'POST',
    url,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage
}

type Route = ReturnType<typeof makeTaskFsmRoutes>[number]

async function call(route: Route, payload: unknown): Promise<{ status: number; body: RouteBody }> {
  const res = fakeRes()
  await route.handler(req(route.path, payload), res as unknown as ServerResponse)
  return { status: res.status, body: res.body === '' ? {} : JSON.parse(res.body) as RouteBody }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-refusal-'))
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
    ack: byPath('/api/task-fsm/ack'),
    wake: byPath('/api/task-fsm/wake'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

let warnSpy: { mockRestore(): void } | undefined
let logSpy: { mockRestore(): void } | undefined
const warns: string[] = []
const logs: string[] = []

function spyOnConsole(): void {
  warns.length = 0
  logs.length = 0
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')) })
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
}

afterEach(() => {
  warnSpy?.mockRestore()
  logSpy?.mockRestore()
})

describe('S3 404/409 visibility (warn 行 + 404 hint + 成功零新增日志)', () => {
  it('transition 404: body gains hint, error semantics unchanged, warn carries taskRef+event', async () => {
    const t = setup()
    spyOnConsole()
    try {
      const r = await call(t.transition, { taskRef: UNKNOWN_REF, event: 'E1' })
      expect(r.status).toBe(404)
      expect(r.body.error).toBe('unknown taskRef') // 404 语义不变
      expect(String(r.body.hint)).toContain('E1 seam') // 只加字段
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('transition REFUSED')
      expect(warns[0]).toContain('status=404')
      expect(warns[0]).toContain(`taskRef=${UNKNOWN_REF}`)
      expect(warns[0]).toContain('event=E1')
    } finally {
      t.cleanup()
    }
  })

  it('transition 409 (guard refuse): warn carries taskRef+event+guard, body unchanged (no hint)', async () => {
    const t = setup()
    spyOnConsole()
    try {
      expect((await call(t.scope, { key: SCOPE, prio: 'red', intent: 'S3 夹具' })).status).toBe(200)
      expect((await call(t.create, { taskRef: KNOWN_REF, worktreePlan: PLAN, scope: SCOPE, title: 'S3' })).status).toBe(200)
      expect((await call(t.transition, { taskRef: KNOWN_REF, event: 'E1' })).status).toBe(200)
      warns.length = 0 // 只看拒绝面

      const dup = await call(t.transition, { taskRef: KNOWN_REF, event: 'E1' })
      expect(dup.status).toBe(409)
      expect(dup.body.kind).toBe('forbidden')
      expect(dup.body.hint).toBeUndefined() // 409 不加 hint（只 404 加）
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('transition REFUSED')
      expect(warns[0]).toContain('status=409')
      expect(warns[0]).toContain(`taskRef=${KNOWN_REF}`)
      expect(warns[0]).toContain('event=E1')
      expect(warns[0]).toContain('kind=forbid')
    } finally {
      t.cleanup()
    }
  })

  it('success path adds zero logs (warn/log spies untouched)', async () => {
    const t = setup()
    spyOnConsole()
    try {
      expect((await call(t.scope, { key: SCOPE, prio: 'red', intent: 'S3 成功面夹具' })).status).toBe(200)
      expect((await call(t.create, { taskRef: KNOWN_REF, worktreePlan: PLAN, scope: SCOPE, title: 'S3 ok' })).status).toBe(200)
      warns.length = 0
      logs.length = 0

      const ok = await call(t.transition, { taskRef: KNOWN_REF, event: 'E1' })
      expect(ok.status).toBe(200)
      expect(warns).toHaveLength(0) // 成功路径零新增日志（判据③反例）
      expect(logs).toHaveLength(0)
    } finally {
      t.cleanup()
    }
  })

  it('ack 404: hint + warn carries taskRef+event=E19', async () => {
    const t = setup()
    spyOnConsole()
    try {
      const r = await call(t.ack, { taskRef: UNKNOWN_REF })
      expect(r.status).toBe(404)
      expect(r.body.error).toBe('unknown taskRef')
      expect(String(r.body.hint)).toContain('E1 seam')
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain(`taskRef=${UNKNOWN_REF}`)
      expect(warns[0]).toContain('event=E19')
    } finally {
      t.cleanup()
    }
  })

  it('wake 404: hint + warn carries taskRef+trigger', async () => {
    const t = setup()
    spyOnConsole()
    try {
      const r = await call(t.wake, { taskRef: UNKNOWN_REF, trigger: 'quota-free' })
      expect(r.status).toBe(404)
      expect(String(r.body.hint)).toContain('E1 seam')
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain(`taskRef=${UNKNOWN_REF}`)
      expect(warns[0]).toContain('trigger=quota-free')
    } finally {
      t.cleanup()
    }
  })
})
