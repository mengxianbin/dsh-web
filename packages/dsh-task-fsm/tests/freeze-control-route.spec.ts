/**
 * POST /api/task-fsm/freeze-control route fixture (freeze-reclaim-phase2-1127
 * 分期3, §6.4 三态裁定 #16): the REAL handler over a REAL FsmStore.
 *
 * Contract under test:
 *  ① 200 sets `freezeControl`, and **history is byte-identical** — the control
 *     state is a structural per-record field (谁改: 人), not a state transition.
 *     HistoryEventSchema is a whitelist, so an invented event would make
 *     parseFsmFile fail-close the WHOLE ledger; the route therefore writes no
 *     history entry (parent/attach 同口径).
 *  ② all three states switch (human-freeze / human-thaw / auto); `auto` is the
 *     revocable "回自动托管" position (default = absent = 自动托管).
 *  ③ idempotent: same value re-POST → 200 with zero drift.
 *  ④ 404 unknown taskRef (+ hint), 400 bad body / non-whitelist control,
 *     405 non-POST, 403 non-loopback (zero write).
 *  ⑤ cross-face: the written value is exactly what the mem-floor watcher
 *     gates on — human-thaw survives a sustained below-enter pass, auto
 *     freezes normally (the watcher reads the same field off the same store).
 *
 * test-standards-allow: dsh-task-fsm machine-behavior fixture — no user role
 * exists for a loopback route contract (bdd-title would be fiction, the
 * script header says so itself); bodies are seed -> act -> assert (corpus style).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeTaskFsmRoutes } from '../src/host/routes.ts'
import { FsmStore } from '../src/host/store.ts'
import { MemFloorWatcher } from '../src/host/mem-floor-watcher.ts'
import type { HistoryEntry } from '../src/core/schema.ts'

const SCOPE = 'content/tech/ai/dsh'
const TARGET_REF = 'content/tech/ai/dsh/tasks.md#freeze-control-target'
const UNKNOWN_REF = 'content/tech/ai/dsh/tasks.md#freeze-control-unknown'
const SESSION_A = 'session-freeze-control-a'
const MB = 1024 ** 2
const GB = 1024 ** 3

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
  const dir = mkdtempSync(join(tmpdir(), 'fsm-freeze-control-'))
  const store = new FsmStore(join(dir, 'task-fsm-state.json'))
  const routes = makeTaskFsmRoutes({ store, dshHome: dir, maxRedisp: 3 })
  const byPath = (p: string): Route => {
    const route = routes.find((r) => r.path === p)
    if (route === undefined) throw new Error(`route missing: ${p}`)
    return route
  }
  return {
    dir,
    store,
    scope: byPath('/api/task-fsm/scope'),
    create: byPath('/api/task-fsm/create'),
    transition: byPath('/api/task-fsm/transition'),
    attach: byPath('/api/task-fsm/session/attach'),
    freezeControl: byPath('/api/task-fsm/freeze-control'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** scope → create → E1 → attach: an active, session-bound record the way dispatch lands it. */
async function seed(t: ReturnType<typeof setup>, taskRef: string, title: string): Promise<void> {
  const sc = await post(t.scope, { key: SCOPE, prio: 'yellow', intent: 'dsh 板（freeze-control 路由夹具）' })
  expect([200, 409]).toContain(sc.status)
  const cr = await post(t.create, {
    taskRef,
    worktreePlan: '开 worktree .wt/freeze-control-fixture 再动手（worktree 预案）',
    scope: SCOPE,
    title,
  })
  expect(cr.status).toBe(200)
  const e1 = await post(t.transition, { taskRef, event: 'E1' })
  expect(e1.status).toBe(200)
  const at = await post(t.attach, { taskRef, sessionId: SESSION_A })
  expect(at.status).toBe(200)
}

/** §6.2 attention ledger: SESSION_A = bot-worker in a declared scope (eligible). */
function writeAttention(t: ReturnType<typeof setup>): void {
  writeFileSync(
    join(t.dir, 'session-attention.json'),
    JSON.stringify({
      version: 1,
      sessions: {
        [SESSION_A]: { class: 'bot-worker', defaultApplied: true, source: 'dispatch', updatedAt: '' },
      },
    }),
    'utf8',
  )
}

/** A watcher over the same store, injected below the 800M enter line. */
function belowEnterWatcher(t: ReturnType<typeof setup>, free: number, nowAt: () => number): MemFloorWatcher {
  return new MemFloorWatcher({
    store: t.store,
    dshHome: t.dir,
    maxRedisp: 3,
    floorRatio: 0.1,
    readFreeMem: () => free,
    readTotalMem: () => 16 * GB,
    now: nowAt,
  })
}

describe('POST /api/task-fsm/freeze-control (§6.4 三态人面写入口)', () => {
  it('sets freezeControl without writing any history entry (结构字段 ≠ 状态转移)', async () => {
    const t = setup()
    try {
      await seed(t, TARGET_REF, 'freeze-control 夹具·目标')
      const before = t.store.load()
      const beforeHistory: HistoryEntry[] = [...(before.tasks[TARGET_REF]?.history ?? [])]

      const hit = await post(t.freezeControl, { taskRef: TARGET_REF, control: 'human-thaw' })
      expect(hit.status).toBe(200)
      expect(hit.body.ok).toBe(true)

      const after = t.store.load()
      expect(after.tasks[TARGET_REF]?.freezeControl).toBe('human-thaw')
      // ⛔ 不写 history：控制态是结构字段（HistoryEventSchema 白名单会 fail-closed 拒整账）。
      expect(after.tasks[TARGET_REF]?.history).toEqual(beforeHistory)
      // 冻结/解冻本体没被代跑：session 原样（只写门控位）。
      expect(after.tasks[TARGET_REF]?.session).toEqual(before.tasks[TARGET_REF]?.session)
    } finally {
      t.cleanup()
    }
  })

  it('switches through all three states (human-freeze / human-thaw / auto)', async () => {
    const t = setup()
    try {
      await seed(t, TARGET_REF, 'freeze-control 夹具·三态')
      const first = await post(t.freezeControl, { taskRef: TARGET_REF, control: 'human-freeze' })
      expect(first.status).toBe(200)
      expect(t.store.load().tasks[TARGET_REF]?.freezeControl).toBe('human-freeze')
      const second = await post(t.freezeControl, { taskRef: TARGET_REF, control: 'human-thaw' })
      expect(second.status).toBe(200)
      expect(t.store.load().tasks[TARGET_REF]?.freezeControl).toBe('human-thaw')
      const third = await post(t.freezeControl, { taskRef: TARGET_REF, control: 'auto' })
      expect(third.status).toBe(200)
      expect(t.store.load().tasks[TARGET_REF]?.freezeControl).toBe('auto')
      expect(t.store.load().tasks[TARGET_REF]?.history).toHaveLength(1) // only the seeded E1
    } finally {
      t.cleanup()
    }
  })

  it('is idempotent: same value re-POST answers 200 with zero drift', async () => {
    const t = setup()
    try {
      await seed(t, TARGET_REF, 'freeze-control 夹具·幂等')
      expect((await post(t.freezeControl, { taskRef: TARGET_REF, control: 'human-freeze' })).status).toBe(200)
      const once = t.store.load()
      const again = await post(t.freezeControl, { taskRef: TARGET_REF, control: 'human-freeze' })
      expect(again.status).toBe(200)
      const twice = t.store.load()
      expect(twice.tasks[TARGET_REF]?.freezeControl).toBe('human-freeze')
      expect(JSON.stringify(twice.tasks)).toBe(JSON.stringify(once.tasks))
    } finally {
      t.cleanup()
    }
  })

  it('rejects a malformed body (400) and any control outside the three-state whitelist (400)', async () => {
    const t = setup()
    try {
      await seed(t, TARGET_REF, 'freeze-control 夹具·400')
      expect((await post(t.freezeControl, { taskRef: TARGET_REF })).status).toBe(400)
      expect((await post(t.freezeControl, { control: 'human-thaw' })).status).toBe(400)
      expect((await post(t.freezeControl, { taskRef: TARGET_REF, control: 'lock' })).status).toBe(400)
      expect((await post(t.freezeControl, { taskRef: TARGET_REF, control: 'human' })).status).toBe(400)
      expect((await post(t.freezeControl, { taskRef: TARGET_REF, control: null })).status).toBe(400)
      // 400 也零写：validate 在 store.update 之前。
      expect(t.store.load().tasks[TARGET_REF]?.freezeControl).toBeUndefined()
    } finally {
      t.cleanup()
    }
  })

  it('an unknown taskRef answers 404 with the dispatch hint', async () => {
    const t = setup()
    try {
      await seed(t, TARGET_REF, 'freeze-control 夹具·404')
      const miss = await post(t.freezeControl, { taskRef: UNKNOWN_REF, control: 'human-thaw' })
      expect(miss.status).toBe(404)
      expect(miss.body.ok).toBe(false)
      expect(String(miss.body.hint ?? '')).toContain('POST /api/task-fsm/create')
    } finally {
      t.cleanup()
    }
  })

  it('refuses non-POST (405) and non-loopback callers (403), both zero-write', async () => {
    const t = setup()
    try {
      await seed(t, TARGET_REF, 'freeze-control 夹具·405/403')
      const getReq = Object.assign(Readable.from([]), {
        method: 'GET',
        url: t.freezeControl.path,
        headers: { host: '127.0.0.1:3080' },
        socket: { remoteAddress: '127.0.0.1' },
      }) as unknown as IncomingMessage
      expect((await call(t.freezeControl, getReq)).status).toBe(405)

      const remote = await post(t.freezeControl, { taskRef: TARGET_REF, control: 'human-freeze' }, '10.0.0.5:9999')
      expect(remote.status).toBe(403)
      expect(remote.body.ok).toBe(false)
      expect(t.store.load().tasks[TARGET_REF]?.freezeControl).toBeUndefined()
    } finally {
      t.cleanup()
    }
  })

  it('cross-face: the written value is what the watcher gates on (human-thaw 豁免 / auto 照冻)', async () => {
    const t = setup()
    try {
      await seed(t, TARGET_REF, 'freeze-control 夹具·门控贯通')
      writeAttention(t)

      // 人保的：进场线之下满轴一拍 → 豁免成立，零冻零史。
      await post(t.freezeControl, { taskRef: TARGET_REF, control: 'human-thaw' })
      let now = 1_700_000_000_000
      const nowAt = () => now
      const protectedWatcher = belowEnterWatcher(t, 799 * MB, nowAt)
      protectedWatcher.tick()
      now += 30_000
      const held = protectedWatcher.tick()
      expect(held.verdict).toBe('below-enter')
      expect(held.frozen).toEqual([])
      expect(t.store.load().tasks[TARGET_REF]?.session?.mode).toBe('active')

      // 撤回自动托管：同一读数同一拍 → 正常冻。
      await post(t.freezeControl, { taskRef: TARGET_REF, control: 'auto' })
      now += 30_000
      const autoWatcher = belowEnterWatcher(t, 799 * MB, nowAt)
      autoWatcher.tick()
      now += 30_000
      const fired = autoWatcher.tick()
      expect(fired.frozen).toEqual([TARGET_REF])
      expect(t.store.load().tasks[TARGET_REF]?.session?.mode).toBe('frozen')
      expect(t.store.load().tasks[TARGET_REF]?.freezeControl).toBe('auto')
    } finally {
      t.cleanup()
    }
  })
})
