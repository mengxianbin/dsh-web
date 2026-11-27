/**
 * §6.4 双阈值滞回 + 三态门控 夹具 (freeze-reclaim-phase2-1127 分期3, 验收②):
 * the three line readings (进场线 800M / 中带 800–1600M / 唤醒线 1600M) each
 * drive the watcher's zone, the 30s time axis gates every action (anti-
 * jitter), the dead band proves 进场与唤醒不来回抖 (hysteresis: freezing at
 * <800M never flips back before ≥1600M, and a wake never re-freezes above
 * the enter line), and the §6.4 三态 gates (human-thaw exempt from
 * auto-freeze / human-freeze locked against auto-wake / absent = 自动托管)
 * are asserted on the real sustained pass. Event set untouched: the watcher
 * still only emits E7/E4.
 *
 * test-standards-allow: dsh-task-fsm machine-behavior fixture — no user role
 * exists for a memory-threshold reading (bdd-title would be fiction, the
 * script header says so itself); bodies are seed -> act -> assert (corpus style).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsmStore } from '../src/host/store.ts'
import {
  DEFAULT_TIME_AXIS_MS, ENTER_LINE_BYTES, MemFloorWatcher, WAKE_LINE_BYTES,
} from '../src/host/mem-floor-watcher.ts'
import type { ScopeDecl, TaskRecord } from '../src/core/schema.ts'
import type { SessionClass } from '../src/host/freeze-permission.ts'

const MB = 1024 ** 2
const GB = 1024 ** 3
const TOTAL = 16 * GB
const BELOW_ENTER = 799 * MB // < 800M 进场线
const MID_BAND = 1000 * MB // 800–1600M 中带死区
const NEAR_WAKE = 1599 * MB // 中带内、贴着唤醒线（死区仍不动作）
const ABOVE_WAKE = 1601 * MB // ≥ 1600M 唤醒线
const TIME_AXIS = DEFAULT_TIME_AXIS_MS

let dir: string
let store: FsmStore
let free: number
let now: number

function record(taskRef: string, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    taskRef,
    scope: 'content/tech/ai/dsh',
    state: 'active',
    queue: 'none',
    attempts: { redisp: 0, autofix: 0 },
    history: [],
    ...extra,
  }
}

function seed(tasks: TaskRecord[]): void {
  const scopes = Object.fromEntries(
    [...new Set(tasks.map((t) => t.scope).filter((s) => s !== ''))]
      .map((s): [string, ScopeDecl] => [s, { intent: '', prio: 'yellow', declaredAt: '2026-11-27T00:00:00.000Z' }]),
  )
  store.save({ version: 1, scopes, tasks: Object.fromEntries(tasks.map((t) => [t.taskRef, t])) })
  // Every session id → bot-worker: permission table always eligible, so the
  // only variable under test is the threshold / 三态 gate itself.
  const classes = Object.fromEntries(
    tasks.flatMap((t): [string, SessionClass][] => (t.session?.id ? [[t.session.id, 'bot-worker']] : [])),
  )
  writeFileSync(
    join(dir, 'session-attention.json'),
    JSON.stringify({
      version: 1,
      sessions: Object.fromEntries(Object.entries(classes).map(([id, cls]) =>
        [id, { class: cls, defaultApplied: true, source: 'dispatch', updatedAt: '' }])),
    }),
    'utf8',
  )
}

function makeWatcher(): MemFloorWatcher {
  return new MemFloorWatcher({
    store,
    dshHome: dir,
    maxRedisp: 3,
    floorRatio: 0.1,
    readFreeMem: () => free,
    readTotalMem: () => TOTAL,
    now: () => now,
  })
}

/** Enter the zone, hold the reading past the 30s axis, tick again. */
function tickSustained(watcher: MemFloorWatcher) {
  watcher.tick()
  now += TIME_AXIS
  return watcher.tick()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fsm-dualthreshold-'))
  store = new FsmStore(join(dir, 'task-fsm-state.json'))
  free = 4 * GB
  now = 1_700_000_000_000
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('三线各构读数（验收②：进场 / 中带 / 唤醒 → §6.4 行为）', () => {
  it('the constants pin the ruling: 800M enter / 1600M wake / 30s time axis', () => {
    expect(ENTER_LINE_BYTES).toBe(800 * MB)
    expect(WAKE_LINE_BYTES).toBe(1600 * MB)
    expect(DEFAULT_TIME_AXIS_MS).toBe(30_000)
    expect(ENTER_LINE_BYTES).toBeLessThan(WAKE_LINE_BYTES) // 800M gap = the hysteresis band
  })

  it('进场线 (free < 800M): sustained ≥30s freezes; the time axis holds it back before that', () => {
    seed([record('t-run', { session: { id: 's-run', mode: 'active', reason: '' } })])
    free = BELOW_ENTER
    const watcher = makeWatcher()

    const first = watcher.tick()
    expect(first.verdict).toBe('below-enter')
    expect(first.zoneHeldMs).toBe(0)
    expect(first.frozen).toEqual([]) // 越线即刻不动作 — 时间轴未满

    now += TIME_AXIS - 1
    const pending = watcher.tick()
    expect(pending.zoneHeldMs).toBe(TIME_AXIS - 1)
    expect(pending.frozen).toEqual([])

    now += 1
    const fired = watcher.tick()
    expect(fired.zoneHeldMs).toBe(TIME_AXIS)
    expect(fired.frozen).toEqual(['t-run'])
    expect(store.load().tasks['t-run'].session?.mode).toBe('frozen')
    expect(store.load().tasks['t-run'].cause).toBe('quota-wait')
  })

  it('中带 800–1600M: 新照常旧排队 — active runs, frozen queues, no action ever', () => {
    seed([
      record('t-new', { session: { id: 's-new', mode: 'active', reason: '' } }),
      record('t-old', { session: { id: 's-old', mode: 'frozen', reason: '排队位' }, cause: 'quota-wait' }),
    ])
    free = MID_BAND
    const watcher = makeWatcher()

    const info1 = watcher.tick()
    expect(info1.verdict).toBe('mid-band')
    now += TIME_AXIS * 10 // 死区里待再久也两向零动作
    const info2 = watcher.tick()
    expect(info2.verdict).toBe('mid-band')
    expect(info2.frozen).toEqual([])
    expect(info2.woken).toEqual([])

    const file = store.load()
    expect(file.tasks['t-new'].session?.mode).toBe('active') // 新照常
    expect(file.tasks['t-old'].session?.mode).toBe('frozen') // 旧排队
    expect(file.tasks['t-new'].history).toHaveLength(0)
    expect(file.tasks['t-old'].history).toHaveLength(0)
  })

  it('唤醒线 (free ≥ 1600M): sustained ≥30s wakes quota-wait; before that the freeze holds', () => {
    seed([record('t-old', { session: { id: 's-old', mode: 'frozen', reason: '内存让路' }, cause: 'quota-wait' })])
    free = ABOVE_WAKE
    const watcher = makeWatcher()

    const first = watcher.tick()
    expect(first.verdict).toBe('above-wake')
    expect(first.woken).toEqual([]) // 时间轴未满 → 冻结保持
    expect(store.load().tasks['t-old'].session?.mode).toBe('frozen')

    now += TIME_AXIS - 1
    expect(watcher.tick().woken).toEqual([])

    now += 1
    const fired = watcher.tick()
    expect(fired.woken).toEqual(['t-old'])
    const after = store.load().tasks['t-old']
    expect(after.session?.mode).toBe('active')
    expect(after.history.at(-1)).toMatchObject({ event: 'E4' })
  })
})

describe('滞回不来回抖（验收②：死区 + 时间轴双防）', () => {
  it('freeze at <800M, then dead-band readings (even 1599M) never wake it — only ≥1600M does', () => {
    seed([record('t-run', { session: { id: 's-run', mode: 'active', reason: '' } })])
    const watcher = makeWatcher()

    free = BELOW_ENTER
    expect(tickSustained(watcher).frozen).toEqual(['t-run'])

    // 801M–1599M 全段 = 死区：冻结保持，零唤醒（进场与唤醒不来回抖）
    for (const reading of [MID_BAND, NEAR_WAKE, MID_BAND, NEAR_WAKE]) {
      free = reading
      watcher.tick()
      now += TIME_AXIS * 3
      const info = watcher.tick()
      expect(info.verdict).toBe('mid-band')
      expect(info.woken).toEqual([])
      expect(store.load().tasks['t-run'].session?.mode).toBe('frozen')
    }

    free = ABOVE_WAKE
    expect(tickSustained(watcher).woken).toEqual(['t-run'])
  })

  it('after a wake, dead-band readings never re-freeze — only <800M does', () => {
    seed([record('t-run', { session: { id: 's-run', mode: 'active', reason: '' } })])
    const watcher = makeWatcher()

    free = BELOW_ENTER
    expect(tickSustained(watcher).frozen).toEqual(['t-run'])
    free = ABOVE_WAKE
    expect(tickSustained(watcher).woken).toEqual(['t-run'])

    // 醒后回到中带：不回冻（进场线之上新照常）
    for (const reading of [MID_BAND, NEAR_WAKE, MID_BAND]) {
      free = reading
      watcher.tick()
      now += TIME_AXIS * 3
      const info = watcher.tick()
      expect(info.verdict).toBe('mid-band')
      expect(info.frozen).toEqual([])
      expect(store.load().tasks['t-run'].session?.mode).toBe('active')
    }

    // 只有重新跌破进场线（且满轴）才再次冻
    free = BELOW_ENTER
    expect(tickSustained(watcher).frozen).toEqual(['t-run'])
  })

  it('oscillation across the enter line without sustaining 30s never freezes (时间轴防抖)', () => {
    seed([record('t-run', { session: { id: 's-run', mode: 'active', reason: '' } })])
    const watcher = makeWatcher()

    // 799M ↔ 801M 每 10s 摆动：越区即重数时间轴，任何一侧都攒不满 30s
    for (let i = 0; i < 6; i++) {
      free = BELOW_ENTER
      watcher.tick()
      now += 10_000
      free = 801 * MB
      watcher.tick()
      now += 10_000
    }
    const info = watcher.tick()
    expect(info.frozen).toEqual([])
    expect(store.load().tasks['t-run'].session?.mode).toBe('active')
    expect(store.load().tasks['t-run'].history).toHaveLength(0)
  })

  it('oscillation across the wake line without sustaining 30s never wakes (时间轴防抖)', () => {
    seed([record('t-old', { session: { id: 's-old', mode: 'frozen', reason: '内存让路' }, cause: 'quota-wait' })])
    const watcher = makeWatcher()

    // 1601M ↔ 1599M 每 10s 摆动：唤醒线两侧来回，攒不满 30s
    for (let i = 0; i < 6; i++) {
      free = ABOVE_WAKE
      watcher.tick()
      now += 10_000
      free = NEAR_WAKE
      watcher.tick()
      now += 10_000
    }
    const info = watcher.tick()
    expect(info.woken).toEqual([])
    expect(store.load().tasks['t-old'].session?.mode).toBe('frozen')
    expect(store.load().tasks['t-old'].history).toHaveLength(0)
  })
})

describe('三态 freezeControl 门控（§6.4 裁定 #16，watcher 面）', () => {
  it('human-thaw 豁免期不入自动冻列 — a sustained below-enter pass skips the row', () => {
    seed([record('t-kept', { session: { id: 's-kept', mode: 'active', reason: '' }, freezeControl: 'human-thaw' })])
    free = BELOW_ENTER

    const info = tickSustained(makeWatcher()) // 满轴 → 选行真跑过，三态是唯一拦截
    expect(info.verdict).toBe('below-enter')
    expect(info.frozen).toEqual([])
    const after = store.load().tasks['t-kept']
    expect(after.session?.mode).toBe('active')
    expect(after.history).toHaveLength(0)
  })

  it('human-freeze 只有人能解 — a sustained above-wake pass never auto-wakes it', () => {
    seed([record('t-locked', {
      session: { id: 's-locked', mode: 'frozen', reason: '内存让路' },
      cause: 'quota-wait',
      freezeControl: 'human-freeze',
    })])
    free = ABOVE_WAKE

    const info = tickSustained(makeWatcher())
    expect(info.verdict).toBe('above-wake')
    expect(info.woken).toEqual([])
    const after = store.load().tasks['t-locked']
    expect(after.session?.mode).toBe('frozen')
    expect(after.history).toHaveLength(0)
  })

  it('缺省 = 自动托管 — an unset control row freezes and wakes normally (positive control)', () => {
    seed([record('t-auto', { session: { id: 's-auto', mode: 'active', reason: '' } })])
    const watcher = makeWatcher()

    free = BELOW_ENTER
    expect(tickSustained(watcher).frozen).toEqual(['t-auto'])
    free = ABOVE_WAKE
    expect(tickSustained(watcher).woken).toEqual(['t-auto'])
    expect(store.load().tasks['t-auto'].session?.mode).toBe('active')
  })

  it('explicit auto = 自动托管 (撤豁免后回托管，双向照常)', () => {
    seed([record('t-revoked', {
      session: { id: 's-revoked', mode: 'active', reason: '' },
      freezeControl: 'auto',
    })])
    const watcher = makeWatcher()

    free = BELOW_ENTER
    expect(tickSustained(watcher).frozen).toEqual(['t-revoked'])
  })
})
