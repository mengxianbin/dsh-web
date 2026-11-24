/**
 * Memory-floor watcher specs (板行 mem-floor-freeze-wiring-1124 判据①–④):
 * fixture-injected memory readings drive the two directions (< floor → E7
 * freeze, back above floor + cooldown → quota-free wake), the E event set
 * is pinned against the design doc's §事件集 (diff = 0), frequency bounds
 * are asserted (period ≥30s clamp, single read sub-ms budget), and the
 * anti-criteria are machine-checked (no subprocess reads, no new events).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FsmStore } from '../src/host/store.ts'
import {
  DEFAULT_WATCH_PERIOD_MS, MemFloorWatcher, MIN_WATCH_PERIOD_MS, READ_BUDGET_MS,
} from '../src/host/mem-floor-watcher.ts'
import type { TaskRecord } from '../src/core/schema.ts'
import { EVENT_LABELS, EVENTS, cellFor } from '../src/core/table.ts'

const MB = 1024 ** 2
const GB = 1024 ** 3
const TOTAL = 16 * GB
const BELOW = 500 * MB // < 10% floor (1.6 GiB)
const HEALTHY = 4 * GB // ≥ floor
const COOLDOWN_MS = 60_000

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
  store.save({ version: 1, scopes: {}, tasks: Object.fromEntries(tasks.map((t) => [t.taskRef, t])) })
}

function makeWatcher(overrides: Partial<ConstructorParameters<typeof MemFloorWatcher>[0]> = {}): MemFloorWatcher {
  return new MemFloorWatcher({
    store,
    dshHome: dir,
    maxRedisp: 3,
    floorRatio: 0.1,
    cooldownMs: COOLDOWN_MS,
    readFreeMem: () => free,
    readTotalMem: () => TOTAL,
    now: () => now,
    ...overrides,
  })
}

const WATCHER_SRC = readFileSync(
  fileURLToPath(new URL('../src/host/mem-floor-watcher.ts', import.meta.url)),
  'utf8',
)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fsm-memfloor-'))
  store = new FsmStore(join(dir, 'task-fsm-state.json'))
  free = HEALTHY
  now = 1_700_000_000_000
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('双向扳机（判据① 夹具注入假读数）', () => {
  it('free < floor → E7 freezes the active session (D 轴 ❄️, cause quota-wait)', () => {
    seed([record('t-freeze', { session: { id: 'session-a', mode: 'active', reason: '' } })])
    free = BELOW

    const info = makeWatcher().tick()
    expect(info.verdict).toBe('below-floor')
    expect(info.frozen).toEqual(['t-freeze'])

    const after = store.load().tasks['t-freeze']
    expect(after.state).toBe('active') // E7 keeps the state; the D axis carries the freeze
    expect(after.session).toMatchObject({ id: 'session-a', mode: 'frozen' })
    expect(after.session?.reason).toContain('内存地板')
    expect(after.cause).toBe('quota-wait')
    expect(after.history.at(-1)).toMatchObject({ event: 'E7', from: 'active', to: 'active' })
    expect(after.queue).toBe('none') // 配额排队不占红黄位（§4.1 不入）
  })

  it('recovery below cooldown keeps the freeze; ≥ cooldown fires the quota-free wake (E4)', () => {
    seed([record('t-freeze', { session: { id: 'session-a', mode: 'active', reason: '' } })])
    const watcher = makeWatcher()

    free = BELOW
    expect(watcher.tick().frozen).toEqual(['t-freeze'])

    // 回地板：冷却期不唤醒（双向用例的唤醒侧前置）
    free = HEALTHY
    expect(watcher.tick().verdict).toBe('cooldown')
    expect(store.load().tasks['t-freeze'].session?.mode).toBe('frozen')

    now += COOLDOWN_MS - 1
    expect(watcher.tick().verdict).toBe('cooldown')
    expect(store.load().tasks['t-freeze'].session?.mode).toBe('frozen')

    now += 1
    const info = watcher.tick()
    expect(info.verdict).toBe('wake')
    expect(info.woken).toEqual(['t-freeze'])

    const after = store.load().tasks['t-freeze']
    expect(after.session?.mode).toBe('active')
    expect(after.history.at(-1)).toMatchObject({ event: 'E4', from: 'active', to: 'active' })
  })

  it('freeze is idempotent — a second below-floor tick adds no duplicate history', () => {
    seed([record('t-freeze', { session: { id: 'session-a', mode: 'active', reason: '' } })])
    free = BELOW
    const watcher = makeWatcher()
    expect(watcher.tick().frozen).toEqual(['t-freeze'])
    const second = watcher.tick()
    expect(second.verdict).toBe('below-floor')
    expect(second.frozen).toEqual([])
    expect(store.load().tasks['t-freeze'].history).toHaveLength(1)
  })

  it('only active session-bearing rows freeze; backlog/deferred/blocked/terminal stay untouched', () => {
    seed([
      record('t-backlog', { state: 'backlog', session: { id: 's1', mode: 'active', reason: '' } }),
      record('t-deferred', { state: 'deferred', cause: 'prereq-unruled', session: { id: 's2', mode: 'frozen', reason: '等前置' } }),
      record('t-blocked', { state: 'blocked', cause: 'chain-dead', session: { id: 's3', mode: 'active', reason: '' } }),
      record('t-done', { state: 'done', session: { id: 's4', mode: 'active', reason: '' } }),
      record('t-nosession', { session: undefined }),
      record('t-active', { session: { id: 's5', mode: 'active', reason: '' } }),
    ])
    free = BELOW

    const info = makeWatcher().tick()
    expect(info.frozen).toEqual(['t-active'])
    const file = store.load()
    expect(file.tasks['t-backlog'].history).toHaveLength(0)
    expect(file.tasks['t-deferred'].history).toHaveLength(0)
    expect(file.tasks['t-blocked'].history).toHaveLength(0)
    expect(file.tasks['t-done'].history).toHaveLength(0)
    expect(file.tasks['t-nosession'].history).toHaveLength(0)
    expect(file.tasks['t-nosession'].session?.mode).not.toBe('frozen') // session-less rows never freeze
  })
})

describe('唤醒边界（⛔ 不动唤醒两触发语义）', () => {
  it('quota recovery never wakes a prereq-frozen deferred row (E4 is na there)', () => {
    seed([
      record('t-prereq', { state: 'deferred', cause: 'prereq-unruled', session: { id: 's2', mode: 'frozen', reason: '等前置' } }),
      record('t-quota', { session: { id: 's1', mode: 'frozen', reason: '内存地板' }, cause: 'quota-wait' }),
    ])
    free = HEALTHY
    const watcher = makeWatcher()

    expect(watcher.tick().verdict).toBe('cooldown') // recovery seen, cooldown starts
    now += COOLDOWN_MS
    const info = watcher.tick()
    expect(info.verdict).toBe('wake')
    expect(info.woken).toEqual(['t-quota'])

    const file = store.load()
    expect(file.tasks['t-prereq'].session?.mode).toBe('frozen') // 前置等待只走 E6 唤醒
    expect(file.tasks['t-prereq'].history).toHaveLength(0)
    expect(cellFor('deferred', 'E4')?.kind).toBe('na')
  })

  it('quota recovery never releases an E1 queue-position freeze (cause ≠ quota-wait)', () => {
    seed([record('t-queue', { session: { id: 's3', mode: 'frozen', reason: '排队位：等待开工核验' } })])
    free = HEALTHY
    const watcher = makeWatcher()

    watcher.tick()
    now += COOLDOWN_MS * 2
    const info = watcher.tick()
    expect(info.woken).toEqual([])
    const after = store.load().tasks['t-queue']
    expect(after.session?.mode).toBe('frozen') // 排队位的放行归开工核验（E2/E3），不归内存
    expect(after.history).toHaveLength(0)
  })
})

describe('频率有界（判据③ 代码断言在场）', () => {
  it('period clamps to ≥30s and the constants hold the bound', () => {
    expect(MIN_WATCH_PERIOD_MS).toBeGreaterThanOrEqual(30_000)
    expect(DEFAULT_WATCH_PERIOD_MS).toBeGreaterThanOrEqual(MIN_WATCH_PERIOD_MS)
    expect(makeWatcher({ periodMs: 5_000 }).periodMs).toBe(MIN_WATCH_PERIOD_MS)
    expect(makeWatcher({ periodMs: 30_000 }).periodMs).toBe(30_000)
    expect(makeWatcher({ periodMs: 120_000 }).periodMs).toBe(120_000)
  })

  it('start() schedules the interval with the clamped period and unrefs it; stop() clears', () => {
    const unref = vi.fn()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>)
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})

    const watcher = makeWatcher({ periodMs: 1_000 }) // would-be高频配置 → clamped
    watcher.start()
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000)
    expect(unref).toHaveBeenCalledTimes(1)

    watcher.stop()
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    watcher.stop() // idempotent
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('a single read stays sub-millisecond (real os.freemem path)', () => {
    seed([record('t-freeze', { session: { id: 'session-a', mode: 'active', reason: '' } })])
    const watcher = new MemFloorWatcher({ store, dshHome: dir, maxRedisp: 3 }) // default readers = os.freemem/totalmem
    watcher.tick()
    expect(watcher.lastReadMs).toBeGreaterThanOrEqual(0)
    expect(watcher.lastReadMs).toBeLessThan(READ_BUDGET_MS)
  })

  it('an over-budget read fails open — no freeze, no wake (反例：读慢了也不砸)', () => {
    seed([record('t-freeze', { session: { id: 'session-a', mode: 'active', reason: '' } })])
    free = BELOW
    const watcher = makeWatcher({
      readFreeMem: () => {
        const t = performance.now()
        while (performance.now() - t < READ_BUDGET_MS + 2) { /* burn past the budget */ }
        return free
      },
    })
    const info = watcher.tick()
    expect(info.verdict).toBe('anomaly')
    expect(info.detail).toContain('budget')
    expect(info.frozen).toEqual([])
    expect(store.load().tasks['t-freeze'].session?.mode).toBe('active') // fail-open: untouched
  })
})

describe('失败形态 fail-open（判据④ 外部兜底）', () => {
  it('a throwing memory sensor fails open with no freeze', () => {
    seed([record('t-freeze', { session: { id: 'session-a', mode: 'active', reason: '' } })])
    free = BELOW
    const watcher = makeWatcher({ readFreeMem: () => { throw new Error('sensor down') } })
    const info = watcher.tick()
    expect(info.verdict).toBe('anomaly')
    expect(info.detail).toContain('fail-open')
    expect(store.load().tasks['t-freeze'].session?.mode).toBe('active')
  })

  it('a non-finite reading fails open', () => {
    seed([record('t-freeze', { session: { id: 'session-a', mode: 'active', reason: '' } })])
    const watcher = makeWatcher({ readFreeMem: () => Number.NaN })
    const info = watcher.tick()
    expect(info.verdict).toBe('anomaly')
    expect(store.load().tasks['t-freeze'].session?.mode).toBe('active')
  })

  it('a corrupt store fails open and is never silently rebuilt by the watcher', () => {
    free = BELOW
    writeFileSync(store.path, '{not json', 'utf8')
    const info = makeWatcher().tick()
    expect(info.verdict).toBe('anomaly')
    expect(info.detail).toContain('unreadable')
    expect(readFileSync(store.path, 'utf8')).toBe('{not json') // 静默重建 = 打回（fsm store 口径）
  })

  it('an idle tick writes nothing (no disk churn on the healthy path)', () => {
    const saveSpy = vi.spyOn(store, 'save')
    free = HEALTHY
    makeWatcher().tick()
    expect(saveSpy).not.toHaveBeenCalled()

    seed([record('t-already-frozen', { session: { id: 's1', mode: 'frozen', reason: '排队位' } })])
    free = BELOW
    saveSpy.mockClear() // seed() itself writes once — count only watcher ticks
    makeWatcher().tick()
    expect(saveSpy).not.toHaveBeenCalled() // no eligible target → no write
  })
})

describe('反例机检（spawn 子进程读内存 / 新增 E 事件 → 打回）', () => {
  it('the watcher reads memory with os.freemem only — zero child process', () => {
    expect(WATCHER_SRC).toMatch(/from 'node:os'/)
    expect(WATCHER_SRC).toMatch(/freemem/)
    expect(WATCHER_SRC).not.toMatch(/child_process/)
    expect(WATCHER_SRC).not.toMatch(/spawn\s*\(/)
    expect(WATCHER_SRC).not.toMatch(/exec(?:Sync|File)?\s*\(/)
  })

  it('the watcher only ever emits the existing E7 and E4 transitions', () => {
    const emitted = [...WATCHER_SRC.matchAll(/'(E\d+)'/g)].map((m) => m[1])
    expect(new Set(emitted)).toEqual(new Set(['E7', 'E4']))
  })

  it('E event set matches the design doc §事件集 exactly (diff = 0)', () => {
    // pure-worker-design-1123 §事件集（E1–E21，逐字对表）
    const DESIGN_EVENT_SET: readonly (readonly [string, string])[] = [
      ['E1', '派发'], ['E2', '开工核验过'], ['E3', '开工核验拦'], ['E4', '步进'],
      ['E5', '缺前置发现'], ['E6', '前置终态到达'], ['E7', '配额空到达'], ['E8', '验收过'],
      ['E9', '验收不过（可修）'], ['E10', '修 N 轮熔断'], ['E11', '判据争议'], ['E12', '不可逆损害'],
      ['E13', '断链（心跳死）'], ['E14', '机械重派'], ['E15', '人中止'], ['E16', 'scope 取消'],
      ['E17', '收口 save'], ['E18', '终态通知人'], ['E19', '人查收回执'],
      ['E20', '等待开始（不驻留）'], ['E21', '黄灯人裁完'],
    ]
    expect(EVENTS).toEqual(DESIGN_EVENT_SET.map(([id]) => id))
    expect(EVENT_LABELS).toEqual(Object.fromEntries(DESIGN_EVENT_SET))

    // The two cells this watcher rides — both already in the table (no new cell).
    expect(cellFor('active', 'E7')).toMatchObject({ kind: 'transfer', to: 'active', effects: { cause: 'quota-wait' } })
    expect(cellFor('active', 'E4')).toMatchObject({ kind: 'transfer', to: 'active', effects: { sessionMode: 'active' } })
  })
})
