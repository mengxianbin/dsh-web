/**
 * Memory-floor watcher — the E7 trigger the design left unwired
 * (pure-worker-design-1123 §事件集「host 配额闸 → E7」/ §3.2 冻结时机;
 * board row `mem-floor-freeze-wiring-1124`).
 *
 * One low-frequency tick reads system free memory with `os.freemem()` — a
 * cheap synchronous syscall, **no child process is ever started** (reading
 * memory by spawning a subprocess is the availability gate's anti-pattern):
 *   · free < floor  →  the EXISTING E7 transition freezes active sessions
 *     (D 轴 ❄️, cause `quota-wait`, hover reason carries the readings);
 *   · free ≥ floor continuously for the cooldown  →  the EXISTING wake
 *     trigger `quota-free` (E4, §3.3 唤醒两触发) releases those freezes.
 *
 * Hard boundaries (board row ⛔): the E event set is untouched — this
 * module only ever *emits* E7 and E4 — and no session body is killed
 * (freeze = mark + input hiding; reclamation of already-spawned
 * subprocesses is natural drain, documented in the construction doc).
 *
 * Frequency is bounded by construction (period clamped to
 * ≥ `MIN_WATCH_PERIOD_MS`) and every read is held to `READ_BUDGET_MS`; an
 * over-budget or failing read makes the tick fail OPEN (no freeze, no wake)
 * — the dispatch-side floor reading stays the backstop (板行失败形态④).
 * @module dsh-task-fsm/host/mem-floor-watcher
 */
import { performance } from 'node:perf_hooks'
import { freemem, totalmem } from 'node:os'
import { applyTransition } from '../core/fsm.ts'
import type { FsmFile, TaskRecord } from '../core/schema.ts'
import type { FsmStore } from './store.ts'
import { makeHostDeps } from './sources.ts'

/** 频率有界（板行判据③）：周期下限 30s — smaller config values clamp here. */
export const MIN_WATCH_PERIOD_MS = 30_000
/** Default period (施工期定, 判据归人): 60s — 日占空秒级以下（四问②）. */
export const DEFAULT_WATCH_PERIOD_MS = 60_000
/** Single-read budget (板行判据③ 单次亚毫秒): over budget = fail-open tick. */
export const READ_BUDGET_MS = 1
/** Default floor = 10% free memory (与派发侧地板读数同口径; 施工期定判据归人). */
export const DEFAULT_FLOOR_RATIO = 0.1
/** Default wake cooldown (施工期定, 判据归人): 60s continuously healthy. */
export const DEFAULT_COOLDOWN_MS = 60_000

/** Result of one tick — observability seam for tests and host wiring. */
export interface MemFloorTickInfo {
  /** Clock reading at tick start (injected `now()`). */
  at: number
  /** Free bytes read this tick (0 on anomaly). */
  free: number
  /** Total bytes read this tick (0 on anomaly). */
  total: number
  /** Floor bytes = total × floorRatio. */
  floor: number
  /** What the tick decided. */
  verdict: 'below-floor' | 'cooldown' | 'wake' | 'anomaly'
  /** Duration of the memory reads (ms, `performance.now()` — budget check). */
  readMs: number
  /** taskRefs frozen by this tick (E7). */
  frozen: readonly string[]
  /** taskRefs woken by this tick (E4 via the `quota-free` trigger). */
  woken: readonly string[]
  /** Anomaly detail (read failure / over-budget / corrupt store). */
  detail?: string
}

export interface MemFloorWatcherOptions {
  /** Machine-authority store (`~/.dsh/task-fsm-state.json`). */
  store: FsmStore
  /** DSH home (guard source wiring, same as the routes). */
  dshHome: string
  /** G5 redisp breaker cap (wiring parity with `makeTaskFsmRoutes`). */
  maxRedisp: number
  /** Free/total ratio floor; clamped into [0, 1]. Default 0.10. */
  floorRatio?: number
  /** Tick period ms; clamped to ≥ `MIN_WATCH_PERIOD_MS`. Default 60s. */
  periodMs?: number
  /** Continuous-healthy time before a wake fires. Default 60s. */
  cooldownMs?: number
  /** Free-memory reader (fixture seam). Default `os.freemem`. */
  readFreeMem?: () => number
  /** Total-memory reader (fixture seam). Default `os.totalmem`. */
  readTotalMem?: () => number
  /** Clock (cooldown bookkeeping only; read budget uses `performance.now()`). */
  now?: () => number
  /** Per-tick observability hook (tests / optional host logging). */
  onTick?: (info: MemFloorTickInfo) => void
}

const MB = 1024 * 1024

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * The host-side memory floor watcher. One bounded timer; every tick is a
 * cheap read + an optional state-machine transfer (E7 freeze / E4 wake) —
 * never a new event, never a subprocess, never a high-frequency poll.
 */
export class MemFloorWatcher {
  /** Effective period after the ≥30s clamp (frequency bound, 判据③). */
  readonly periodMs: number
  readonly cooldownMs: number
  readonly floorRatio: number

  /** Duration of the last completed memory read (ms, 判据③ sub-ms assertion). */
  lastReadMs = 0

  private readonly store: FsmStore
  private readonly dshHome: string
  private readonly maxRedisp: number
  private readonly readFreeMem: () => number
  private readonly readTotalMem: () => number
  private readonly now: () => number
  private readonly onTick?: (info: MemFloorTickInfo) => void
  private recoveredAt: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: MemFloorWatcherOptions) {
    this.store = options.store
    this.dshHome = options.dshHome
    this.maxRedisp = options.maxRedisp
    this.readFreeMem = options.readFreeMem ?? freemem
    this.readTotalMem = options.readTotalMem ?? totalmem
    this.now = options.now ?? Date.now
    this.onTick = options.onTick
    // 频率有界 (判据③): the period can never be configured below 30s.
    this.periodMs = Math.max(MIN_WATCH_PERIOD_MS, Math.floor(options.periodMs ?? DEFAULT_WATCH_PERIOD_MS))
    this.cooldownMs = Math.max(0, Math.floor(options.cooldownMs ?? DEFAULT_COOLDOWN_MS))
    this.floorRatio = clamp(options.floorRatio ?? DEFAULT_FLOOR_RATIO, 0, 1)
  }

  /** Start the bounded timer (unref'd — never keeps the host alive). */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => { this.tick() }, this.periodMs)
    // The watcher must not hold the process open; it is a background cadence.
    this.timer.unref?.()
  }

  /** Stop the timer (idempotent). */
  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * One watch tick: cheap read (sub-ms budget, fail-open) → floor compare
   * → E7 freeze pass or cooldown/wake pass over the fsm file.
   * @returns the tick's decision record (tests assert on it).
   */
  tick(): MemFloorTickInfo {
    const at = this.now()
    const base = { at, free: 0, total: 0, floor: 0, readMs: 0, frozen: [] as string[], woken: [] as string[] }

    // ———① 廉价读（零子进程）+ 单次亚毫秒预算（超预算 =本轮 fail-open）———
    const t0 = performance.now()
    let free: number
    let total: number
    try {
      free = this.readFreeMem()
      total = this.readTotalMem()
    } catch (error) {
      this.lastReadMs = performance.now() - t0
      return this.emit({
        ...base, verdict: 'anomaly',
        detail: `memory read failed (fail-open, no freeze): ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    this.lastReadMs = performance.now() - t0
    const readMs = this.lastReadMs
    if (readMs >= READ_BUDGET_MS) {
      return this.emit({
        ...base, verdict: 'anomaly', readMs,
        detail: `memory read ${readMs.toFixed(3)}ms ≥ ${READ_BUDGET_MS}ms budget (fail-open, no freeze)`,
      })
    }
    if (!Number.isFinite(free) || !Number.isFinite(total) || free < 0 || total <= 0) {
      return this.emit({
        ...base, verdict: 'anomaly', readMs,
        detail: `non-finite memory reading (fail-open, no freeze): free=${String(free)} total=${String(total)}`,
      })
    }
    const floor = Math.floor(total * this.floorRatio)

    // ——— 机器权威读（损坏 = fail-open，绝不在 watcher 里静默重建）———
    let file: FsmFile
    try {
      file = this.store.load()
    } catch (error) {
      return this.emit({
        ...base, free, total, floor, verdict: 'anomaly', readMs,
        detail: `task-fsm store unreadable (fail-open, no freeze): ${error instanceof Error ? error.message : String(error)}`,
      })
    }

    // ——— ② 低于地板 → 既有 E7 转移落冻结位（只打 active 且未冻结的会话行）———
    if (free < floor) {
      this.recoveredAt = null
      const frozen: string[] = []
      for (const [taskRef, record] of Object.entries(file.tasks)) {
        if (record.state !== 'active') continue // E7 only applies from active (table 三分)
        if (record.session?.mode !== 'active' || record.session.id === '') continue // already ❄️/🔒 or session-less
        const result = applyTransition(
          record, 'E7', this.depsFor(file, record),
          { reason: `内存地板：FreeMB ${Math.round(free / MB)} < 地板 ${Math.round(floor / MB)}（mem-floor watcher）` },
        )
        if (result.ok) {
          file.tasks[taskRef] = result.record
          frozen.push(taskRef)
        }
      }
      if (frozen.length > 0) this.store.save(file) // no write when nothing changed
      return this.emit({ ...base, free, total, floor, verdict: 'below-floor', readMs, frozen })
    }

    // ——— ③ 回地板 + 冷却 → 既有 `quota-free` 唤醒（E4；只放 quota-wait 冻结行）———
    const wakeTargets = Object.entries(file.tasks).filter(([, record]) =>
      record.cause === 'quota-wait'
      && (record.session?.mode === 'frozen' || record.session?.mode === 'locked'))
    if (wakeTargets.length === 0) {
      this.recoveredAt = null
      return this.emit({ ...base, free, total, floor, verdict: 'cooldown', readMs })
    }
    if (this.recoveredAt === null) {
      this.recoveredAt = at
      return this.emit({ ...base, free, total, floor, verdict: 'cooldown', readMs })
    }
    if (at - this.recoveredAt < this.cooldownMs) {
      return this.emit({ ...base, free, total, floor, verdict: 'cooldown', readMs })
    }
    const woken: string[] = []
    for (const [taskRef, record] of wakeTargets) {
      const result = applyTransition(record, 'E4', this.depsFor(file, record), {})
      if (result.ok) {
        file.tasks[taskRef] = result.record
        woken.push(taskRef)
      }
    }
    if (woken.length > 0) this.store.save(file)
    this.recoveredAt = at // further wake attempts wait another cooldown (bounded retry)
    return this.emit({ ...base, free, total, floor, verdict: 'wake', readMs, woken })
  }

  /** Guard deps for one record — parity with the route-side wiring (§2.4). */
  private depsFor(file: FsmFile, record: TaskRecord) {
    return makeHostDeps({
      dshHome: this.dshHome,
      file,
      evidence: { writer: 'other' },
      maxRedisp: this.maxRedisp,
      redisp: record.attempts.redisp,
    })
  }

  private emit(info: MemFloorTickInfo): MemFloorTickInfo {
    this.onTick?.(info)
    return info
  }
}
