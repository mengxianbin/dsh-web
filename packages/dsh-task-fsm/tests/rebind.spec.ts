/**
 * rebind 原子事件 specs (fsm-rebind-1126, 设计 §3.1/§3.2): the happy path
 * lands B's binding + A's unbind + both histories in ONE store.update (a
 * single save, asserted on a counting real store); the four refusals
 * (双向唯一 / seal UNSEALED without a force reason / A terminal / record
 * missing 404) answer structured 409+kind+detail with zero write; seal-check
 * `DONE`/`N_A` clears the §3.2 hard block while `UNKNOWN`/`PENDING` refuse
 * with the state file byte-identical; `force+forceReason` cuts through and
 * leaves a forced trace in A's history.
 *
 * The seal-check seam is injected (archive-leg fetchImpl 同形); one case runs
 * the DEFAULT loopback path against a dead origin to pin its fail-closed
 * UNKNOWN answer.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeTaskFsmRoutes, type SealCheckVerdict } from '../src/host/routes.ts'
import { FsmStore } from '../src/host/store.ts'
import type { FsmFile } from '../src/core/schema.ts'

const SCOPE = 'content/tech/ai/dsh'
const FROM = 'content/tech/ai/dsh/tasks.md#rebind-source'
const TO = 'content/tech/ai/dsh/tasks.md#rebind-target'
const SESSION = 'session-rebind-1'

interface HistoryLike {
  event?: string
  kind?: string
  forceReason?: string
  from?: string
  to?: string
}

interface RecordLike {
  state?: string
  session?: { id: string; mode: string; reason: string } | undefined
  history?: HistoryLike[]
}

interface RebindBody {
  ok?: boolean
  kind?: string
  detail?: string
  verdict?: string
  error?: string
  from?: RecordLike
  to?: RecordLike
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

async function call(route: Route, payload: unknown): Promise<{ status: number; body: RebindBody }> {
  const res = fakeRes()
  await route.handler(post(route.path, payload), res as unknown as ServerResponse)
  return { status: res.status, body: res.body === '' ? {} : JSON.parse(res.body) as RebindBody }
}

/** Real store with a save counter — 判据①「单文件一次写」的观测面 (a subclass, not a spy). */
class CountingStore extends FsmStore {
  saves = 0
  override save(file: FsmFile): void {
    this.saves += 1
    super.save(file)
  }
}

type SealCheckFake = (input: { ids: readonly string[]; origin: string }) => Promise<SealCheckVerdict>

function setup(sealCheck?: SealCheckFake) {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-rebind-'))
  const file = join(dir, 'task-fsm-state.json')
  const store = new CountingStore(file)
  const routes = makeTaskFsmRoutes({
    store,
    dshHome: dir,
    maxRedisp: 3,
    ...(sealCheck === undefined ? {} : { sealCheck }),
  })
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
    rebind: byPath('/api/task-fsm/rebind'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * The 切单 pair: scope → A created → E1 lands A active with SESSION bound
 * (real dispatch shape) → B created unbound in backlog.
 */
async function seedPair(t: ReturnType<typeof setup>): Promise<void> {
  const sc = await call(t.scope, { key: SCOPE, prio: 'red', intent: 'dsh 板（rebind 夹具）' })
  expect(sc.status).toBe(200)
  const a = await call(t.create, {
    taskRef: FROM,
    worktreePlan: '开 worktree .wt/rebind-fixture 再动手（worktree 预案）',
    scope: SCOPE,
    title: '换绑源任务',
  })
  expect(a.status).toBe(200)
  const e1 = await call(t.transition, { taskRef: FROM, event: 'E1', payload: { sessionId: SESSION } })
  expect(e1.status).toBe(200)
  const b = await call(t.create, {
    taskRef: TO,
    worktreePlan: '开 worktree .wt/rebind-fixture 再动手（worktree 预案）',
    scope: SCOPE,
    title: '换绑目标任务',
  })
  expect(b.status).toBe(200)
}

function sealOf(verdict: string, detail = ''): SealCheckFake {
  return async () => ({ verdict, detail })
}

function diskTasks(t: ReturnType<typeof setup>): Record<string, RecordLike> {
  return (JSON.parse(readFileSync(t.file, 'utf8')) as { tasks: Record<string, RecordLike> }).tasks
}

describe('rebind atomic switch (fsm-rebind-1126 §3.1)', () => {
  it('operator rebinds an active session onto a backlog task in one atomic write', async () => {
    // Given a session bound to active task A, an unbound backlog task B, and a DONE seal verdict
    let sealedIds: readonly string[] = []
    const t = setup(async ({ ids }) => {
      sealedIds = ids
      return { verdict: 'DONE', detail: '' }
    })
    try {
      await seedPair(t)
      const savesBefore = t.store.saves
      // When the operator switches the session A→B
      const r = await call(t.rebind, { fromTaskRef: FROM, toTaskRef: TO, sessionId: SESSION })
      // Then B holds the session, A is unbound, both histories carry the rebind
      // marks — written by exactly ONE save (单文件一次写), seal read A's session
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
      expect(t.store.saves - savesBefore).toBe(1)
      expect([...sealedIds]).toEqual([SESSION])
      const file = t.store.load()
      expect(file.tasks[TO]?.session).toEqual({ id: SESSION, mode: 'active', reason: '' })
      // A 解绑: the single-update reply carries no session, and the reloaded
      // record has no bound id (parse materializes a bare id-less node —
      // 「活」口径 reads session.id as a non-empty string).
      expect(r.body.from?.session).toBeUndefined()
      expect(file.tasks[FROM]?.session?.id ?? '').toBe('')
      expect(file.tasks[TO]?.history.map((h) => h.event)).toContain('rebind-in')
      expect(file.tasks[FROM]?.history.map((h) => h.event)).toContain('rebind-out')
      expect(file.tasks[FROM]?.state).toBe('active') // state untouched: A 转挂账不改态
      const onDisk = diskTasks(t)
      expect(onDisk[TO]?.session?.id).toBe(SESSION)
      expect(onDisk[FROM]?.session).toBeUndefined()
    } finally {
      t.cleanup()
    }
  })

  it('operator is refused 409 dual-bound when B already binds another session', async () => {
    // Given B bound to a foreign session
    const t = setup(sealOf('DONE'))
    try {
      await seedPair(t)
      const seeded = t.store.load()
      seeded.tasks[TO]!.session = { id: 'session-foreign', mode: 'active', reason: '' }
      t.store.save(seeded)
      const before = readFileSync(t.file, 'utf8')
      const savesBefore = t.store.saves
      // When the operator switches A→B with this session
      const r = await call(t.rebind, { fromTaskRef: FROM, toTaskRef: TO, sessionId: SESSION })
      // Then it refuses 409 dual-bound with zero write
      expect(r.status).toBe(409)
      expect(r.body.ok).toBe(false)
      expect(r.body.kind).toBe('dual-bound')
      expect(String(r.body.detail)).toContain('session-foreign')
      expect(readFileSync(t.file, 'utf8')).toBe(before)
      expect(t.store.saves).toBe(savesBefore)
    } finally {
      t.cleanup()
    }
  })

  it('operator is refused 409 dual-bound when the session already holds another active task', async () => {
    // Given a third task C (backlog) already bound to this session
    const t = setup(sealOf('DONE'))
    try {
      await seedPair(t)
      const c = await call(t.create, {
        taskRef: 'content/tech/ai/dsh/tasks.md#rebind-other',
        worktreePlan: '开 worktree .wt/rebind-fixture 再动手（worktree 预案）',
        scope: SCOPE,
        title: '占用中的其他任务',
      })
      expect(c.status).toBe(200)
      const seeded = t.store.load()
      seeded.tasks['content/tech/ai/dsh/tasks.md#rebind-other']!.session = { id: SESSION, mode: 'active', reason: '' }
      t.store.save(seeded)
      const before = readFileSync(t.file, 'utf8')
      const savesBefore = t.store.saves
      // When the operator switches A→B with this session
      const r = await call(t.rebind, { fromTaskRef: FROM, toTaskRef: TO, sessionId: SESSION })
      // Then it refuses 409 dual-bound naming the other task, zero write
      expect(r.status).toBe(409)
      expect(r.body.kind).toBe('dual-bound')
      expect(String(r.body.detail)).toContain('rebind-other')
      expect(readFileSync(t.file, 'utf8')).toBe(before)
      expect(t.store.saves).toBe(savesBefore)
    } finally {
      t.cleanup()
    }
  })

  it('operator is refused 409 seal-required on UNSEALED when force carries no reason', async () => {
    // Given a seal-check that answers UNSEALED/sentinel-pending for A's session
    // and a force flag WITHOUT a reason (force 无 reason = 不生效)
    const t = setup(sealOf('UNSEALED', 'sentinel-pending'))
    try {
      await seedPair(t)
      const before = readFileSync(t.file, 'utf8')
      const savesBefore = t.store.saves
      // When the operator tries to switch anyway
      const r = await call(t.rebind, { fromTaskRef: FROM, toTaskRef: TO, sessionId: SESSION, force: true })
      // Then it refuses 409 seal-required carrying verdict+detail, zero write
      expect(r.status).toBe(409)
      expect(r.body.ok).toBe(false)
      expect(r.body.kind).toBe('seal-required')
      expect(r.body.verdict).toBe('UNSEALED')
      expect(r.body.detail).toBe('sentinel-pending')
      expect(readFileSync(t.file, 'utf8')).toBe(before)
      expect(t.store.saves).toBe(savesBefore)
    } finally {
      t.cleanup()
    }
  })

  it('operator is refused 409 a-terminal when A already reached a terminal state', async () => {
    // Given A moved to done (terminal: 无可解绑)
    const t = setup(sealOf('DONE'))
    try {
      await seedPair(t)
      const seeded = t.store.load()
      seeded.tasks[FROM]!.state = 'done'
      t.store.save(seeded)
      const before = readFileSync(t.file, 'utf8')
      const savesBefore = t.store.saves
      // When the operator switches A→B
      const r = await call(t.rebind, { fromTaskRef: FROM, toTaskRef: TO, sessionId: SESSION })
      // Then it refuses 409 a-terminal, zero write
      expect(r.status).toBe(409)
      expect(r.body.kind).toBe('a-terminal')
      expect(String(r.body.detail)).toContain(FROM)
      expect(readFileSync(t.file, 'utf8')).toBe(before)
      expect(t.store.saves).toBe(savesBefore)
    } finally {
      t.cleanup()
    }
  })

  it('operator is refused 404 not-found when either record is missing', async () => {
    // Given a pair with only A present (B never created) and a ghost reference
    const t = setup(sealOf('DONE'))
    try {
      await seedPair(t)
      const ghost = 'content/tech/ai/dsh/tasks.md#rebind-ghost'
      const seeded = t.store.load()
      delete seeded.tasks[TO]
      t.store.save(seeded)
      const before = readFileSync(t.file, 'utf8')
      const savesBefore = t.store.saves
      // When the operator rebinds to the missing B, then from a missing A
      const missingTo = await call(t.rebind, { fromTaskRef: FROM, toTaskRef: ghost, sessionId: SESSION })
      const missingFrom = await call(t.rebind, { fromTaskRef: ghost, toTaskRef: TO, sessionId: SESSION })
      // Then both answer 404 kind=not-found naming the side, zero write
      expect(missingTo.status).toBe(404)
      expect(missingTo.body.kind).toBe('not-found')
      expect(String(missingTo.body.detail)).toContain('toTaskRef')
      expect(missingFrom.status).toBe(404)
      expect(missingFrom.body.kind).toBe('not-found')
      expect(String(missingFrom.body.detail)).toContain('fromTaskRef')
      expect(readFileSync(t.file, 'utf8')).toBe(before)
      expect(t.store.saves).toBe(savesBefore)
    } finally {
      t.cleanup()
    }
  })
})

describe('rebind seal-check hard block (fsm-rebind-1126 §3.2)', () => {
  it('operator sees DONE and N_A verdicts clear the hard block', async () => {
    // Given a seal-check answering DONE, then N_A (纯问答轮) for A's session —
    // each verdict owns its fixture, so the two runs go in parallel
    await Promise.all(['DONE', 'N_A'].map(async (verdict) => {
      let sealedIds: readonly string[] = []
      const t = setup(async ({ ids }) => {
        sealedIds = ids
        return { verdict, detail: '' }
      })
      try {
        await seedPair(t)
        // When the operator switches A→B
        const r = await call(t.rebind, { fromTaskRef: FROM, toTaskRef: TO, sessionId: SESSION })
        // Then the rebind passes and the seal read A's session id
        expect(r.status, `verdict=${verdict}`).toBe(200)
        expect([...sealedIds]).toEqual([SESSION])
        expect(t.store.load().tasks[TO]?.session?.id).toBe(SESSION)
      } finally {
        t.cleanup()
      }
    }))
  })

  it('operator is refused with zero write on UNKNOWN and PENDING verdicts', async () => {
    // Given a seal-check answering UNKNOWN, then PENDING (not in the pass set)
    await Promise.all(['UNKNOWN', 'PENDING'].map(async (verdict) => {
      const t = setup(sealOf(verdict, verdict === 'UNKNOWN' ? 'seal-check unreachable' : 'sentinel-pending'))
      try {
        await seedPair(t)
        const before = readFileSync(t.file, 'utf8')
        const savesBefore = t.store.saves
        // When the operator switches A→B
        const r = await call(t.rebind, { fromTaskRef: FROM, toTaskRef: TO, sessionId: SESSION })
        // Then it refuses 409 seal-required and the state file bytes do not change
        expect(r.status, `verdict=${verdict}`).toBe(409)
        expect(r.body.kind).toBe('seal-required')
        expect(r.body.verdict).toBe(verdict)
        expect(readFileSync(t.file, 'utf8')).toBe(before)
        expect(t.store.saves).toBe(savesBefore)
      } finally {
        t.cleanup()
      }
    }))
  })

  it('operator is refused fail-closed when the default loopback seal-check cannot be reached', async () => {
    // Given NO injected seal-check (the production default) and no listener on
    // the request origin — the loopback call must fail into UNKNOWN
    const t = setup()
    try {
      await seedPair(t)
      const before = readFileSync(t.file, 'utf8')
      const savesBefore = t.store.saves
      // When the operator switches A→B
      const r = await call(t.rebind, { fromTaskRef: FROM, toTaskRef: TO, sessionId: SESSION })
      // Then it refuses 409 seal-required/UNKNOWN (查不清即拦), zero write
      expect(r.status).toBe(409)
      expect(r.body.kind).toBe('seal-required')
      expect(r.body.verdict).toBe('UNKNOWN')
      expect(readFileSync(t.file, 'utf8')).toBe(before)
      expect(t.store.saves).toBe(savesBefore)
    } finally {
      t.cleanup()
    }
  })

  it('operator force-cuts past UNSEALED and A history carries the forced trace', async () => {
    // Given an UNSEALED seal verdict and a force cut WITH a reason
    const t = setup(sealOf('UNSEALED', 'sentinel-pending'))
    try {
      await seedPair(t)
      const reason = '人裁强制切单：save 未存档但进度已交接'
      // When the operator switches A→B with force+forceReason
      const r = await call(t.rebind, { fromTaskRef: FROM, toTaskRef: TO, sessionId: SESSION, force: true, forceReason: reason })
      // Then it passes and A's history holds the forced rebind-out trace on disk
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
      const forced = t.store.load().tasks[FROM]?.history.find((h) => h.event === 'rebind-out')
      expect(forced?.kind).toBe('forced')
      expect(forced?.forceReason).toBe(reason)
      const onDisk = diskTasks(t)
      const diskTrace = onDisk[FROM]?.history?.find((h) => h.event === 'rebind-out')
      expect(diskTrace?.kind).toBe('forced')
      expect(diskTrace?.forceReason).toBe(reason)
      expect(onDisk[TO]?.session?.id).toBe(SESSION)
    } finally {
      t.cleanup()
    }
  })
})
