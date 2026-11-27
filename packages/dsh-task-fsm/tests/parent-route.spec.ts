/**
 * POST /api/task-fsm/parent route fixture (#fsm-turnend-wire-1126 验收 ④):
 * the REAL handler over a REAL FsmStore on a scratch file.
 *
 * Contract under test:
 *  ① 200 sets `parent`, and **history is byte-identical** — parent is a structural
 *     edge field, not a state transition. HistoryEventSchema is a whitelist, so an
 *     invented event would make parseFsmFile fail-close the WHOLE ledger; the route
 *     therefore writes no history entry (design §1: 边权威在板, FSM 只存 parent/root+state).
 *  ② idempotent: same value re-POST → 200 with zero drift (轮尾对账可无限重跑).
 *  ③ 404 unknown taskRef (+ hint), 400 bad body, 405 non-POST, 403 non-loopback.
 *  ④ the written parent actually drives archive layering (archive.ts childrenOf/root) —
 *     the load-bearing reason 板 deps 永不转父 (work-ledger-structure-ops.md:24): a wrong
 *     parent makes a not-yet-started sibling get archived together with its closer.
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
import type { HistoryEntry } from '../src/core/schema.ts'

const SCOPE = 'content/tech/ai/dsh'
const PARENT_REF = 'content/tech/ai/dsh/tasks.md#parent-route-parent'
const CHILD_REF = 'content/tech/ai/dsh/tasks.md#parent-route-child'
const UNKNOWN_REF = 'content/tech/ai/dsh/tasks.md#parent-route-unknown'

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
  const dir = mkdtempSync(join(tmpdir(), 'fsm-parent-route-'))
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
    parent: byPath('/api/task-fsm/parent'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** scope → create → E1: land a record the way dispatch does (no session bound). */
async function seed(t: ReturnType<typeof setup>, taskRef: string, title: string): Promise<void> {
  const sc = await post(t.scope, { key: SCOPE, prio: 'yellow', intent: 'dsh 板（parent 路由夹具）' })
  expect([200, 409]).toContain(sc.status)
  const cr = await post(t.create, {
    taskRef,
    worktreePlan: '开 worktree .wt/parent-route-fixture 再动手（worktree 预案）',
    scope: SCOPE,
    title,
  })
  expect(cr.status).toBe(200)
  const e1 = await post(t.transition, { taskRef, event: 'E1' })
  expect(e1.status).toBe(200)
}

describe('POST /api/task-fsm/parent (板 → FSM 镜像最小写入口)', () => {
  it('sets parent without writing any history entry, and flips archive layering', async () => {
    const t = setup()
    try {
      await seed(t, PARENT_REF, 'parent 路由夹具·父')
      await seed(t, CHILD_REF, 'parent 路由夹具·子')
      const before = t.store.load()
      const beforeHistory: HistoryEntry[] = [...(before.tasks[CHILD_REF]?.history ?? [])]
      // 父记录起手是 root（无 parent）；子记录尚未挂进 children。
      expect(archivePlan(before, CHILD_REF).root).toBe(true)
      expect(archivePlan(before, PARENT_REF).children).toEqual([])

      const hit = await post(t.parent, { taskRef: CHILD_REF, parent: PARENT_REF })
      expect(hit.status).toBe(200)
      expect(hit.body.ok).toBe(true)

      const after = t.store.load()
      expect(after.tasks[CHILD_REF]?.parent).toBe(PARENT_REF)
      // ⛔ 不写 history：结构边字段 ≠ 状态转移（HistoryEventSchema 白名单会 fail-closed 拒整账）。
      expect(after.tasks[CHILD_REF]?.history).toEqual(beforeHistory)
      expect(after.tasks[PARENT_REF]?.history).toEqual(before.tasks[PARENT_REF]?.history)

      // parent 真的驱动归档分层 —— 这就是「deps 永不转父」公理存在的理由。
      expect(archivePlan(after, PARENT_REF).children).toContain(CHILD_REF)
      expect(archivePlan(after, CHILD_REF).root).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it('is idempotent: same value re-POST answers 200 with zero drift', async () => {
    const t = setup()
    try {
      await seed(t, PARENT_REF, 'parent 路由夹具·父')
      await seed(t, CHILD_REF, 'parent 路由夹具·子')
      expect((await post(t.parent, { taskRef: CHILD_REF, parent: PARENT_REF })).status).toBe(200)
      const once = t.store.load()
      const again = await post(t.parent, { taskRef: CHILD_REF, parent: PARENT_REF })
      expect(again.status).toBe(200)
      const twice = t.store.load()
      expect(twice.tasks[CHILD_REF]?.parent).toBe(PARENT_REF)
      expect(twice.tasks[CHILD_REF]?.history).toEqual(once.tasks[CHILD_REF]?.history)
      // 幂等重跑 diff 空：整份账除时间戳外逐字节等价（本端点不写 updated_at 之外的任何字段）。
      expect(JSON.stringify(twice.tasks)).toBe(JSON.stringify(once.tasks))
    } finally {
      t.cleanup()
    }
  })

  it('an unknown taskRef answers 404 with the dispatch hint', async () => {
    const t = setup()
    try {
      await seed(t, PARENT_REF, 'parent 路由夹具·父')
      const miss = await post(t.parent, { taskRef: UNKNOWN_REF, parent: PARENT_REF })
      expect(miss.status).toBe(404)
      expect(miss.body.ok).toBe(false)
      expect(String(miss.body.hint ?? '')).toContain('POST /api/task-fsm/create')
    } finally {
      t.cleanup()
    }
  })

  it('rejects a malformed body (400) and a non-taskRef parent (400)', async () => {
    const t = setup()
    try {
      await seed(t, CHILD_REF, 'parent 路由夹具·子')
      expect((await post(t.parent, { taskRef: CHILD_REF })).status).toBe(400)
      expect((await post(t.parent, { parent: PARENT_REF })).status).toBe(400)
      // parent 必须是 taskRef 形态（archive.ts 按 taskRef 精确匹配 childrenOf）。
      expect((await post(t.parent, { taskRef: CHILD_REF, parent: 'just-a-slug' })).status).toBe(400)
    } finally {
      t.cleanup()
    }
  })

  it('refuses non-POST (405) and non-loopback callers (403)', async () => {
    const t = setup()
    try {
      await seed(t, CHILD_REF, 'parent 路由夹具·子')
      const getReq = Object.assign(Readable.from([]), {
        method: 'GET',
        url: t.parent.path,
        headers: { host: '127.0.0.1:3080' },
        socket: { remoteAddress: '127.0.0.1' },
      }) as unknown as IncomingMessage
      expect((await call(t.parent, getReq)).status).toBe(405)

      const remote = await post(t.parent, { taskRef: CHILD_REF, parent: PARENT_REF }, '10.0.0.5:9999')
      expect(remote.status).toBe(403)
      expect(remote.body.ok).toBe(false)
      // 拒绝必须零写入（fenced 在 body 读取之前）。
      expect(t.store.load().tasks[CHILD_REF]?.parent).toBeUndefined()
    } finally {
      t.cleanup()
    }
  })
})
