/**
 * POST /api/task-fsm/session/attach route fixture (e1-burn-fix-1127 验收 §6-3):
 * the REAL handler over a REAL FsmStore on a scratch file.
 *
 * Contract under test:
 *  ① 200 attaches `sessionId` to a non-terminal record whose session node is missing
 *     (§6.5 拆冻结副作用后 E1 无 payload 的产物：active ∧ session 缺位) — seeds born-active
 *     {mode:'active', reason:''}, **history byte-identical** (structure field ≠ transition;
 *     HistoryEventSchema is a whitelist, an invented event would fail-close the WHOLE ledger).
 *  ①b legacy victim shape (hook-burned active ∧ session.id='' with frozen/排队位) still
 *     attaches by filling only the id — mode/reason preserved (存量 frozen 不回退).
 *  ② idempotent: same sessionId re-POST → 200 with zero drift (tasks byte-equal).
 *  ③ 非法拒零写: a different bound session → 409 conflict; terminal → 409 forbidden
 *     (终态完整性, 协调方回函 2026-11-27 裁定维持 — 受害单 taskbook-gate 已 done →
 *     不挂、非残留); backlog → 409 forbidden (backlog walks E1, attach never substitutes E1);
 *     404 unknown (+hint) / 400 bad body / 405 non-POST / 403 non-loopback.
 *  ④ the attached id actually drives archive layering: archive-plan?taskRef=<parent>
 *     surfaces childSessions once the child is attached (验收 §6-5 读数面).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeTaskFsmRoutes } from '../src/host/routes.ts'
import { FsmStore } from '../src/host/store.ts'
import { archivePlan } from '../src/core/archive.ts'
import type { HistoryEntry, TaskRecord } from '../src/core/schema.ts'

const SCOPE = 'content/tech/ai/dsh'
const PARENT_REF = 'content/tech/ai/dsh/tasks.md#attach-route-parent'
const CHILD_REF = 'content/tech/ai/dsh/tasks.md#attach-route-child'
const UNKNOWN_REF = 'content/tech/ai/dsh/tasks.md#attach-route-unknown'
const SESSION_A = 'session-attach-fixture-aaaa'
const SESSION_B = 'session-fixture-bbbb'

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

type Route = ReturnType<typeof makeTaskFsmRoutes>[number]

async function call(
  route: Route,
  req: IncomingMessage,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = fakeRes()
  await route.handler(req, res as unknown as ServerResponse)
  return { status: res.status, body: res.body === '' ? {} : JSON.parse(res.body) as Record<string, unknown> }
}

async function post(route: Route, payload: unknown, host = '127.0.0.1:3080'): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]), {
    method: 'POST',
    url: route.path,
    headers: { host, 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage
  return call(route, req)
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-session-attach-'))
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
    attach: byPath('/api/task-fsm/session/attach'),
    archive: byPath('/api/task-fsm/archive-plan'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** scope → create → E1(no payload): §6.5 后 E1 不播种 session 节点 — active ∧ session 缺位。 */
async function seed(t: ReturnType<typeof setup>, taskRef: string, title: string): Promise<void> {
  const sc = await post(t.scope, { key: SCOPE, prio: 'yellow', intent: 'dsh 板（attach 路由夹具）' })
  expect([200, 409]).toContain(sc.status)
  const cr = await post(t.create, {
    taskRef,
    worktreePlan: '开 worktree .wt/attach-route-fixture 再动手（worktree 预案）',
    scope: SCOPE,
    title,
  })
  expect(cr.status).toBe(200)
  const e1 = await post(t.transition, { taskRef, event: 'E1' })
  expect(e1.status).toBe(200)
}

/** Direct fixture surgery for shapes events alone cannot reach (terminal seed / legacy victim). */
function surgery(t: ReturnType<typeof setup>, taskRef: string, mutate: (record: TaskRecord) => void): void {
  const file = t.store.load()
  const record = file.tasks[taskRef]
  if (record === undefined) throw new Error(`fixture missing: ${taskRef}`)
  mutate(record)
  t.store.save(file)
}

function forceState(t: ReturnType<typeof setup>, taskRef: string, state: string): void {
  surgery(t, taskRef, (record) => {
    record.state = state as typeof record.state
  })
}

describe('POST /api/task-fsm/session/attach (session 挂载口)', () => {
  it('attaches a session-less active record, seeding born-active (§6.5), without any history entry', async () => {
    const t = setup()
    try {
      await seed(t, CHILD_REF, 'attach 夹具·子')
      const before = t.store.load()
      expect(before.tasks[CHILD_REF]?.state).toBe('active')
      // §6.5：E1 不再播种 frozen/排队位——节点生而 active，只是 id 尚空（attach 补绑）。
      expect(before.tasks[CHILD_REF]?.session?.id).toBe('')
      expect(before.tasks[CHILD_REF]?.session?.mode).toBe('active')
      const beforeHistory: HistoryEntry[] = [...(before.tasks[CHILD_REF]?.history ?? [])]

      const hit = await post(t.attach, { taskRef: CHILD_REF, sessionId: SESSION_A })
      expect(hit.status).toBe(200)
      expect(hit.body.ok).toBe(true)

      const after = t.store.load()
      expect(after.tasks[CHILD_REF]?.session?.id).toBe(SESSION_A)
      // 节点缺位才播种：生而 active（冻结只由 watcher/宣告面显式驱动，§6.5）。
      expect(after.tasks[CHILD_REF]?.session?.mode).toBe('active')
      expect(after.tasks[CHILD_REF]?.session?.reason).toBe('')
      // ⛔ 不写 history：挂载 = 结构字段回写，不是状态转移。
      expect(after.tasks[CHILD_REF]?.history).toEqual(beforeHistory)
      expect(after.tasks[CHILD_REF]?.state).toBe('active')
    } finally {
      t.cleanup()
    }
  })

  it('attaches the legacy victim shape (frozen/排队位) by filling only the id (存量 frozen 不回退)', async () => {
    const t = setup()
    try {
      await seed(t, CHILD_REF, 'attach 夹具·子（存量形态）')
      // 存量 hook-burned 形态：E1 旧正形播种的 {id:'', frozen, 排队位}。
      surgery(t, CHILD_REF, (record) => {
        record.session = { id: '', mode: 'frozen', reason: '排队位：等待开工核验' }
      })
      const beforeHistory: HistoryEntry[] = [...(t.store.load().tasks[CHILD_REF]?.history ?? [])]

      const hit = await post(t.attach, { taskRef: CHILD_REF, sessionId: SESSION_A })
      expect(hit.status).toBe(200)

      const after = t.store.load()
      expect(after.tasks[CHILD_REF]?.session?.id).toBe(SESSION_A)
      // D 轴不动：存量 mode/reason 原样保留，只补 id。
      expect(after.tasks[CHILD_REF]?.session?.mode).toBe('frozen')
      expect(after.tasks[CHILD_REF]?.session?.reason).toBe('排队位：等待开工核验')
      expect(after.tasks[CHILD_REF]?.history).toEqual(beforeHistory)
    } finally {
      t.cleanup()
    }
  })

  it('is idempotent: same sessionId re-POST answers 200 with zero drift', async () => {
    const t = setup()
    try {
      await seed(t, CHILD_REF, 'attach 夹具·子')
      expect((await post(t.attach, { taskRef: CHILD_REF, sessionId: SESSION_A })).status).toBe(200)
      const once = t.store.load()
      const again = await post(t.attach, { taskRef: CHILD_REF, sessionId: SESSION_A })
      expect(again.status).toBe(200)
      const twice = t.store.load()
      expect(JSON.stringify(twice.tasks)).toBe(JSON.stringify(once.tasks))
    } finally {
      t.cleanup()
    }
  })

  it('refuses a different bound session (409 conflict) with zero write', async () => {
    const t = setup()
    try {
      await seed(t, CHILD_REF, 'attach 夹具·子')
      expect((await post(t.attach, { taskRef: CHILD_REF, sessionId: SESSION_A })).status).toBe(200)
      const before = JSON.stringify(t.store.load().tasks)
      const hit = await post(t.attach, { taskRef: CHILD_REF, sessionId: SESSION_B })
      expect(hit.status).toBe(409)
      expect(hit.body.ok).toBe(false)
      expect(hit.body.kind).toBe('conflict')
      expect(String(hit.body.detail)).toContain(SESSION_A)
      expect(JSON.stringify(t.store.load().tasks)).toBe(before)
    } finally {
      t.cleanup()
    }
  })

  it('refuses terminal records (409 forbidden, 终态完整性) with zero write', async () => {
    const t = setup()
    try {
      await seed(t, CHILD_REF, 'attach 夹具·子')
      forceState(t, CHILD_REF, 'done')
      const before = JSON.stringify(t.store.load().tasks)
      const hit = await post(t.attach, { taskRef: CHILD_REF, sessionId: SESSION_A })
      expect(hit.status).toBe(409)
      expect(hit.body.kind).toBe('forbidden')
      expect(String(hit.body.detail)).toContain('终态')
      expect(JSON.stringify(t.store.load().tasks)).toBe(before)
    } finally {
      t.cleanup()
    }
  })

  it('refuses backlog records (409 forbidden, 走 E1) with zero write', async () => {
    const t = setup()
    try {
      const sc = await post(t.scope, { key: SCOPE, prio: 'yellow', intent: 'dsh 板（attach 路由夹具）' })
      expect([200, 409]).toContain(sc.status)
      await post(t.create, {
        taskRef: CHILD_REF,
        worktreePlan: '开 worktree .wt/attach-route-fixture 再动手（worktree 预案）',
        scope: SCOPE,
        title: 'attach 夹具·backlog',
      })
      const before = JSON.stringify(t.store.load().tasks)
      const hit = await post(t.attach, { taskRef: CHILD_REF, sessionId: SESSION_A })
      expect(hit.status).toBe(409)
      expect(hit.body.kind).toBe('forbidden')
      expect(String(hit.body.detail)).toContain('E1')
      expect(JSON.stringify(t.store.load().tasks)).toBe(before)
    } finally {
      t.cleanup()
    }
  })

  it('an unknown taskRef answers 404 with the dispatch hint', async () => {
    const t = setup()
    try {
      const miss = await post(t.attach, { taskRef: UNKNOWN_REF, sessionId: SESSION_A })
      expect(miss.status).toBe(404)
      expect(miss.body.ok).toBe(false)
      expect(String(miss.body.hint ?? '')).toContain('POST /api/task-fsm/create')
    } finally {
      t.cleanup()
    }
  })

  it('rejects a malformed body (400), a non-POST (405), and a non-loopback caller (403) — zero write', async () => {
    const t = setup()
    try {
      await seed(t, CHILD_REF, 'attach 夹具·子')
      const before = JSON.stringify(t.store.load().tasks)
      expect((await post(t.attach, { taskRef: CHILD_REF })).status).toBe(400)
      expect((await post(t.attach, { sessionId: SESSION_A })).status).toBe(400)
      expect((await post(t.attach, { taskRef: CHILD_REF, sessionId: '' })).status).toBe(400)

      const getReq = Object.assign(Readable.from([]), {
        method: 'GET',
        url: t.attach.path,
        headers: { host: '127.0.0.1:3080' },
        socket: { remoteAddress: '127.0.0.1' },
      }) as unknown as IncomingMessage
      expect((await call(t.attach, getReq)).status).toBe(405)

      const remote = await post(t.attach, { taskRef: CHILD_REF, sessionId: SESSION_A }, '10.0.0.5:9999')
      expect(remote.status).toBe(403)
      expect(JSON.stringify(t.store.load().tasks)).toBe(before)
    } finally {
      t.cleanup()
    }
  })

  it('drives archive layering: archive-plan childSessions surfaces the attached id', async () => {
    const t = setup()
    try {
      await seed(t, PARENT_REF, 'attach 夹具·父')
      await seed(t, CHILD_REF, 'attach 夹具·子')
      // 父记录挂 parent 边（parent 路由既有语义）→ 子记录归入 children。
      const parentRoute = makeTaskFsmRoutes({ store: t.store, dshHome: '', maxRedisp: 3 })
        .find((r) => r.path === '/api/task-fsm/parent')
      if (parentRoute === undefined) throw new Error('parent route missing')
      expect((await post(parentRoute, { taskRef: CHILD_REF, parent: PARENT_REF })).status).toBe(200)

      // 挂载前：childSessions 空（子 session.id=''）。
      const before = await call(t.archive, Object.assign(Readable.from([]), {
        method: 'GET',
        url: `/api/task-fsm/archive-plan?taskRef=${encodeURIComponent(PARENT_REF)}`,
        headers: { host: '127.0.0.1:3080' },
        socket: { remoteAddress: '127.0.0.1' },
      }) as unknown as IncomingMessage)
      expect(before.status).toBe(200)
      expect((before.body.plan as { childSessions: string[] }).childSessions).toEqual([])

      // 挂载后：childSessions 出现对应会话（验收 §6-5 读数面）。
      expect((await post(t.attach, { taskRef: CHILD_REF, sessionId: SESSION_A })).status).toBe(200)
      const after = await call(t.archive, Object.assign(Readable.from([]), {
        method: 'GET',
        url: `/api/task-fsm/archive-plan?taskRef=${encodeURIComponent(PARENT_REF)}`,
        headers: { host: '127.0.0.1:3080' },
        socket: { remoteAddress: '127.0.0.1' },
      }) as unknown as IncomingMessage)
      expect(after.status).toBe(200)
      expect((after.body.plan as { childSessions: string[] }).childSessions).toContain(SESSION_A)
      expect(archivePlan(t.store.load(), PARENT_REF).childSessions).toContain(SESSION_A)
    } finally {
      t.cleanup()
    }
  })
})
