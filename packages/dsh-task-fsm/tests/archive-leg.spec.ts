/**
 * S2 archive execution leg (fsm-seam-archive-build-1125, 判据②): real
 * transition/ack handlers over a real FsmStore, with the leg's fetch injected
 * so every archive POST is observable —
 *   触发① 根落 done → E18 自动补发（pendingAck + 黄档，通知面断头接通）
 *   触发② 父落 done → archive POST 带非空 childSessions（父收口即归子）
 *   触发③ ack E19 成功 → 归根会话（ids 非空、actor=渠道名 fsm-host、无 force）
 * 失败面 = 留痕不回滚 + 连续 3 败降级只留痕 + seal 红逐 id 跳过不计败。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeTaskFsmRoutes } from '../src/host/routes.ts'
import { FsmStore } from '../src/host/store.ts'
import { ArchiveLeg, ARCHIVE_ACTOR, type ArchiveFetch } from '../src/host/archive-leg.ts'

const SCOPE = 'content/tech/ai/dsh'
const ROOT_REF = 'content/tech/ai/dsh/tasks.md#archive-leg-root'
const PARENT_REF = 'content/tech/ai/dsh/tasks.md#archive-leg-parent'
const CHILD_REFS = [
  'content/tech/ai/dsh/tasks.md#archive-leg-child-1',
  'content/tech/ai/dsh/tasks.md#archive-leg-child-2',
] as const
const PLAN = 'worktree 预案 = 开 .wt/archive-leg 夹具后动手'

interface RouteBody {
  ok?: boolean
  error?: string
  kind?: string
  guard?: string
  record?: {
    state?: string
    queue?: string
    pendingAck?: boolean
    session?: { id?: string; mode?: string }
    history?: { event: string }[]
  }
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

interface ArchiveCall {
  url: string
  body: { ids: string[]; actor: string; force?: unknown }
}

/** A leg whose POSTs are captured; every id answers `ok` unless overridden. */
function capturingLeg(override?: { status: number; json: unknown }): { leg: ArchiveLeg; calls: ArchiveCall[] } {
  const calls: ArchiveCall[] = []
  const fetchImpl: ArchiveFetch = async (url, init) => {
    const body = JSON.parse(init.body) as ArchiveCall['body']
    calls.push({ url, body })
    const payload = override ?? {
      status: 200,
      json: { results: body.ids.map((id) => ({ id, status: 'ok' })) },
    }
    return { status: payload.status, json: async () => payload.json }
  }
  return { leg: new ArchiveLeg({ fetchImpl }), calls }
}

function setup(leg?: ArchiveLeg) {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-archive-leg-'))
  const store = new FsmStore(join(dir, 'task-fsm-state.json'))
  const routes = makeTaskFsmRoutes({ store, dshHome: dir, maxRedisp: 3, ...(leg === undefined ? {} : { leg }) })
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
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

async function seedScope(t: ReturnType<typeof setup>): Promise<void> {
  const sc = await call(t.scope, { key: SCOPE, prio: 'red', intent: '归档腿夹具' })
  expect(sc.status).toBe(200)
}

/** create + E1(with sessionId): land one record in `active` carrying its session id. */
async function seedActive(
  t: ReturnType<typeof setup>,
  taskRef: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const cr = await call(t.create, { taskRef, worktreePlan: PLAN, scope: SCOPE, title: taskRef.split('#')[1], ...extra })
  expect(cr.status).toBe(200)
  const e1 = await call(t.transition, { taskRef, event: 'E1', payload: { sessionId } })
  expect(e1.status).toBe(200)
  expect(e1.body.record?.session?.id).toBe(sessionId)
}

const GREEN_E8 = { evidence: { readings: [{ name: 'vitest', ok: true }, { name: 'typecheck', ok: true }], writer: 'acceptance-gate' } }

describe('S2 archive execution leg (event-driven triggers → POST /archive)', () => {
  it('判据②: 根 done → E18 pendingAck → ack E19 → archive POST ids 非空 + actor=fsm-host + 无 force', async () => {
    const { leg, calls } = capturingLeg()
    const t = setup(leg)
    try {
      await seedScope(t)
      await seedActive(t, ROOT_REF, 'session-root-1')

      const e8 = await call(t.transition, { taskRef: ROOT_REF, event: 'E8', ...GREEN_E8 })
      expect(e8.status).toBe(200)
      // 触发①: 根落 done 自动补 E18（同笔原子写；生产零调用方的断头根因接通）。
      expect(e8.body.record?.state).toBe('done')
      expect(e8.body.record?.pendingAck).toBe(true)
      expect(e8.body.record?.history?.some((h) => h.event === 'E18')).toBe(true)
      expect(t.store.load().tasks[ROOT_REF]?.queue).toBe('yellow')
      expect(calls).toHaveLength(0) // 根留人归：回执前不归

      const ack = await call(t.ack, { taskRef: ROOT_REF })
      expect(ack.status).toBe(200)
      expect(ack.body.record?.pendingAck).toBe(false)
      await leg.idle()

      // 触发③: E19 收据后归根会话。
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toContain('/api/dsh-session-archive/archive')
      expect(calls[0].body.ids).toEqual(['session-root-1'])
      expect(calls[0].body.ids.length).toBeGreaterThan(0)
      expect(calls[0].body.actor).toBe(ARCHIVE_ACTOR)
      expect(calls[0].body.actor).not.toMatch(/^session-/) // 反例：actor 不得是会话 id（identity-denied 必现）
      expect(calls[0].body.force).toBeUndefined() // seal 红不 force
    } finally {
      t.cleanup()
    }
  })

  it('判据②: 父归 childSessions 非空路径在场（父落 done → POST ids = 子会话，父自身不入）', async () => {
    const { leg, calls } = capturingLeg()
    const t = setup(leg)
    try {
      await seedScope(t)
      await seedActive(t, PARENT_REF, 'session-parent-1')
      await seedActive(t, CHILD_REFS[0], 'session-child-1', { parent: PARENT_REF })
      await seedActive(t, CHILD_REFS[1], 'session-child-2', { parent: PARENT_REF })

      const e8 = await call(t.transition, { taskRef: PARENT_REF, event: 'E8', ...GREEN_E8 })
      expect(e8.status).toBe(200)
      await leg.idle()

      expect(calls).toHaveLength(1)
      expect(calls[0].body.ids.length).toBeGreaterThan(0)
      expect([...calls[0].body.ids].sort()).toEqual(['session-child-1', 'session-child-2'])
      expect(calls[0].body.ids).not.toContain('session-parent-1') // 父自身等 E19（触发③）
      expect(calls[0].body.actor).toBe(ARCHIVE_ACTOR)
      expect(calls[0].body.force).toBeUndefined()
    } finally {
      t.cleanup()
    }
  })

  it('归档失败 = 留痕 warn + 不回滚 FSM（fail-open：done/pendingAck 照写）', async () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')) })
    const leg = new ArchiveLeg({ fetchImpl: async () => { throw new Error('archive endpoint down') } })
    const t = setup(leg)
    try {
      await seedScope(t)
      await seedActive(t, ROOT_REF, 'session-root-1')
      expect((await call(t.transition, { taskRef: ROOT_REF, event: 'E8', ...GREEN_E8 })).status).toBe(200)
      expect((await call(t.ack, { taskRef: ROOT_REF })).status).toBe(200)
      await leg.idle()

      expect(leg.consecutiveFailures(ROOT_REF)).toBe(1)
      expect(warns.some((w) => w.includes('FAILED') && w.includes(ROOT_REF) && w.includes('不回滚'))).toBe(true)
      const record = t.store.load().tasks[ROOT_REF]
      expect(record?.state).toBe('done') // FSM 转移不回滚
      expect(record?.pendingAck).toBe(false) // E19 回执不因归档失败撤销
      expect(record?.history?.some((h) => h.event === 'E18')).toBe(true)
    } finally {
      spy.mockRestore()
      t.cleanup()
    }
  })

  it('连续 3 败该 taskRef → 降级只留痕（第 4 次不再打 POST）', async () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')) })
    let fetchCount = 0
    try {
      const leg = new ArchiveLeg({ fetchImpl: async () => { fetchCount += 1; throw new Error('down') } })
      await leg.archive('content/tech/ai/dsh/tasks.md#degrade-fixture', ['session-a'], 'http://127.0.0.1:3080')
      await leg.archive('content/tech/ai/dsh/tasks.md#degrade-fixture', ['session-b'], 'http://127.0.0.1:3080')
      await leg.archive('content/tech/ai/dsh/tasks.md#degrade-fixture', ['session-c'], 'http://127.0.0.1:3080')
      expect(fetchCount).toBe(3)
      expect(leg.consecutiveFailures('content/tech/ai/dsh/tasks.md#degrade-fixture')).toBe(3)
      await leg.archive('content/tech/ai/dsh/tasks.md#degrade-fixture', ['session-d'], 'http://127.0.0.1:3080')
      expect(fetchCount).toBe(3) // 降级：不再打 POST
      expect(warns.some((w) => w.includes('DEGRADED') && w.includes('只留痕'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('seal 红/UNKNOWN 逐 id 跳过（200 内 seal-required）→ SKIP 留痕、不计败、不 force', async () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')) })
    const calls: ArchiveCall[] = []
    try {
      const leg = new ArchiveLeg({
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(init.body) as ArchiveCall['body']
          calls.push({ url: 'x', body })
          return {
            status: 200,
            json: async () => ({
              results: [
                { id: 'session-green', status: 'ok' },
                { id: 'session-red', status: 'skipped', reason: 'seal-required', seal: { verdict: 'red' } },
                { id: 'session-unknown', status: 'skipped', reason: 'seal-required', seal: { verdict: 'unknown' } },
              ],
            }),
          }
        },
      })
      await leg.archive('content/tech/ai/dsh/tasks.md#seal-fixture', ['session-green', 'session-red', 'session-unknown'], 'http://127.0.0.1:3080')
      expect(calls[0].body.force).toBeUndefined() // 从不带 force（seal 红不 force）
      expect(leg.consecutiveFailures('content/tech/ai/dsh/tasks.md#seal-fixture')).toBe(0) // 跳过不是失败
      expect(warns.some((w) => w.includes('SKIP') && w.includes('seal-required'))).toBe(true)
      expect(warns.some((w) => w.includes('FAILED'))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})
