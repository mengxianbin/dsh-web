/**
 * E1 dispatch seam integration (fsm-seam-archive-build-1125 S1, 判据①): the
 * REAL dispatch route handler self-calls the REAL task-fsm routes over a
 * scratch loopback HTTP server (real FsmStore on a scratch file) — a raw POST
 * with a `#` taskRef must land in FSM state (create + transition E1 paired on
 * the observed request log, record `active` carrying the created session id =
 * the session id 回写), while synthetic anchors (no `#`) and bot-boss
 * dispatches are exempt (zero FSM request), and G1/G3 failures refuse
 * fail-closed before any prompt is queued.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { makeDispatchRoute, type DispatchServices } from '../src/host/routes.ts'
import { makeLoopbackFsmSeam } from '../src/host/fsm-seam.ts'
// Cross-package fixture (施工取舍): the seam's loopback self-call targets the
// REAL task-fsm route handlers — one process, real handlers × real store, so
// "state 含该 taskRef" is asserted against the scratch state file itself.
import { makeTaskFsmRoutes } from '../../dsh-task-fsm/src/host/routes.ts'
import { FsmStore } from '../../dsh-task-fsm/src/host/store.ts'

const WORKSPACE = 'workspace-seam-fixture'
const SCOPE = 'content/tech/ai/dsh'
const TASK_REF = 'content/tech/ai/dsh/tasks.md#seam-fixture'
const PROMPT = '# 任务书\n\nworktree 预案 = 开 .wt/seam-fixture 后动手\n正文'

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

function fakeReq(url: string, payload: unknown, host: string): IncomingMessage {
  // Buffer chunk: readBoundedJson concats chunks — a string chunk throws
  // inside the route's body reader and surfaces as a spurious 400.
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]), {
    method: 'POST',
    url,
    headers: { host, 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage
}

interface DispatchBody {
  ok?: boolean
  sessionId?: string
  taskRef?: string
  error?: string
  guard?: string
}

describe('E1 dispatch seam (host route registers + fires E1 before session work)', () => {
  let dir = ''
  let server: Server | undefined
  let host = ''
  let store: FsmStore
  let route: ReturnType<typeof makeDispatchRoute>
  let access: string[] = []
  const counters = { created: 0, prompted: 0, renamed: 0, bindings: 0 }

  const dispatch = async (payload: Record<string, unknown>): Promise<{ status: number; body: DispatchBody }> => {
    const res = fakeRes()
    await route.handler(fakeReq(route.path, { workspaceId: WORKSPACE, ...payload }, host), res as unknown as ServerResponse)
    return { status: res.status, body: res.body === '' ? {} : JSON.parse(res.body) as DispatchBody }
  }

  const fsmHits = (needle: string): number => access.filter((line) => line === needle).length

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fsm-seam-'))
    store = new FsmStore(join(dir, 'task-fsm-state.json'))
    const fsmRoutes = makeTaskFsmRoutes({ store, dshHome: dir, maxRedisp: 3 })
    // Scratch loopback server hosting the REAL fsm routes; every request is
    // recorded — the create/transition pair is the log face of 判据①.
    const scratch = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      access.push(`${req.method} ${path}`)
      const fsmRoute = fsmRoutes.find((r) => r.kind === 'exact' && r.path === path)
      if (fsmRoute === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"ok":false,"error":"no route"}')
        return
      }
      void Promise.resolve(fsmRoute.handler(req, res)).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end('{"ok":false}')
        }
      })
    })
    server = scratch
    await new Promise<void>((resolve) => scratch.listen(0, '127.0.0.1', resolve))
    host = `127.0.0.1:${(scratch.address() as AddressInfo).port}`

    const services: DispatchServices = {
      sessions: {
        create: async () => ({ sessionId: `session-fake-${++counters.created}` }),
        rename: async () => { counters.renamed += 1 },
        prompt: async () => { counters.prompted += 1; return { accepted: true as const } },
        cancel: () => undefined,
      },
      workspaces: { get: (id) => ({ id }) },
      bindings: {
        findAlive: async () => undefined,
        record: async () => { counters.bindings += 1 },
        list: async () => [],
      },
      fsm: makeLoopbackFsmSeam(),
    }
    route = makeDispatchRoute(services)

    // G3 input: declare the scope through the real route (direct call, off the
    // request log so the pair assertion stays clean).
    const scopeRoute = fsmRoutes.find((r) => r.path === '/api/task-fsm/scope')
    if (scopeRoute === undefined) throw new Error('scope route missing')
    const res = fakeRes()
    await scopeRoute.handler(fakeReq('/api/task-fsm/scope', { key: SCOPE, prio: 'red', intent: 'seam 夹具' }, host), res as unknown as ServerResponse)
    expect(res.status).toBe(200)
  })

  afterAll(() => {
    server?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('raw dispatch with a # taskRef lands in FSM state (create+transition paired, session id 回写)', async () => {
    access = []
    const r = await dispatch({ prompt: PROMPT, taskRef: TASK_REF, title: 'seam 夹具', sessionClass: 'bot-worker' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.sessionId).toBeTruthy()
    // 判据①: log 中 create+transition 成对（本夹具的请求观测面 = 生产 access log 同形）。
    expect(fsmHits('POST /api/task-fsm/create')).toBe(1)
    expect(fsmHits('POST /api/task-fsm/transition')).toBe(1)
    const record = store.load().tasks[TASK_REF]
    expect(record).toBeDefined()
    expect(record?.state).toBe('active')
    // session id 回写（S1 前置缺口 8/8 空 → 现落 id）：E1 payload.sessionId 合并语义。
    expect(record?.session?.id).toBe(r.body.sessionId)
    expect(record?.session?.mode).toBe('frozen')
    expect(record?.history.map((h) => h.event)).toEqual(['E1'])
    expect(counters.prompted).toBe(1)
    expect(counters.bindings).toBe(1)
  })

  it('synthetic anchors (no #) and bot-boss dispatches are exempt — zero FSM request', async () => {
    access = []
    const synthetic = await dispatch({ prompt: PROMPT, taskRef: 'taskbot-takeover-1125', sessionClass: 'bot-boss' })
    expect(synthetic.status).toBe(200)
    const plain = await dispatch({ prompt: PROMPT, taskRef: 'plain-conversation-ref', sessionClass: 'bot-worker' })
    expect(plain.status).toBe(200)
    const anchoredBoss = await dispatch({ prompt: PROMPT, taskRef: 'content/tech/ai/dsh/tasks.md#boss-anchored', sessionClass: 'bot-boss' })
    expect(anchoredBoss.status).toBe(200)
    expect(access.filter((line) => line.includes('/api/task-fsm/'))).toHaveLength(0)
    expect(store.load().tasks['content/tech/ai/dsh/tasks.md#boss-anchored']).toBeUndefined()
  })

  it('G1 (no worktree 预案 in the task book) refuses 400 fail-closed with zero side effects', async () => {
    access = []
    const beforeCreated = counters.created
    const beforePrompted = counters.prompted
    const g1 = await dispatch({ prompt: '没有预案的任务书正文', taskRef: 'content/tech/ai/dsh/tasks.md#g1-fixture' })
    expect(g1.status).toBe(400)
    expect(String(g1.body.error)).toContain('E1_BLOCKED')
    expect(String(g1.body.error)).toContain('G1')
    expect(counters.created).toBe(beforeCreated) // 没建会话（零孤儿）
    expect(counters.prompted).toBe(beforePrompted)
    expect(access.filter((line) => line.includes('/api/task-fsm/'))).toHaveLength(0) // 连 create 都没发
    expect(store.load().tasks['content/tech/ai/dsh/tasks.md#g1-fixture']).toBeUndefined()
  })

  it('G3 (scope 未开) refuses the dispatch with guard + hint, prompt never queued, warn carries taskRef', async () => {
    access = []
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')) })
    const beforePrompted = counters.prompted
    try {
      const g3 = await dispatch({ prompt: PROMPT, taskRef: 'content/other/path/tasks.md#g3-fixture', sessionClass: 'bot-worker' })
      expect(g3.status).toBe(409)
      expect(g3.body.guard).toBe('G3')
      expect(String(g3.body.error)).toContain('hint=开 scope 归人')
    } finally {
      spy.mockRestore()
    }
    expect(counters.prompted).toBe(beforePrompted) // 拒派 = 不投递
    // create + transition(E1) 都发了（G3 在 transition 守卫处拒），日志可取证。
    expect(fsmHits('POST /api/task-fsm/create')).toBe(1)
    expect(fsmHits('POST /api/task-fsm/transition')).toBe(1)
    expect(warns.some((w) => w.includes('g3-fixture') && w.includes('G3'))).toBe(true)
  })

  it('operator gets 409 at the gate when the taskRef already holds a live FSM session', async () => {
    // Given the record landed active with its session bound by the first dispatch
    access = []
    const beforeCreated = counters.created
    const firstId = store.load().tasks[TASK_REF]?.session?.id
    expect(firstId).toBeTruthy()
    // When the same taskRef dispatches again
    const again = await dispatch({ prompt: PROMPT, taskRef: TASK_REF, title: 'seam 夹具', sessionClass: 'bot-worker' })
    // Then the gate answers 409 with the unchanged body shape, before create — no session minted
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ ok: false, taskRef: TASK_REF, sessionId: firstId })
    expect(String(again.body.error)).toContain('taskRef already has a live session')
    expect(fsmHits('POST /api/task-fsm/create')).toBe(0)
    expect(fsmHits('GET /api/task-fsm/state')).toBe(1) // 闸① state read only
    expect(counters.created).toBe(beforeCreated)
    expect(store.load().tasks[TASK_REF]?.session?.id).toBe(firstId) // 记录零改
  })

  it("operator's re-dispatch backfills the burned record via session/attach (B 案兜底)", async () => {
    // Given the active record with its session id cleared (钩子烧成的空洞形态)
    access = []
    const seeded = store.load()
    seeded.tasks[TASK_REF]!.session = { id: '', mode: 'active', reason: '' }
    store.save(seeded)
    const beforeTransition = fsmHits('POST /api/task-fsm/transition')
    // When the same taskRef dispatches again
    const again = await dispatch({ prompt: PROMPT, taskRef: TASK_REF, title: 'seam 夹具', sessionClass: 'bot-worker' })
    // Then the gate clears (session.id 空 ∧ 快账无活绑定), create 409 → active 空洞
    // 分流 → 会话建出后经 session/attach 补挂（e1-burn-fix-1127 §2-③a 回补）
    expect(again.status).toBe(200)
    expect(fsmHits('POST /api/task-fsm/create')).toBe(1) // 409 幂等分流
    expect(fsmHits('GET /api/task-fsm/state')).toBe(2) // 闸①读 + 分流读
    expect(fsmHits('POST /api/task-fsm/transition')).toBe(beforeTransition) // E1 跳过
    expect(fsmHits('POST /api/task-fsm/session/attach')).toBe(1) // B 案兜底挂载
    expect(store.load().tasks[TASK_REF]?.session?.id).toBe(again.body.sessionId) // 回补：id 落账
    expect(store.load().tasks[TASK_REF]?.history.map((h) => h.event)).toEqual(['E1']) // 零 history 写
  })
})
