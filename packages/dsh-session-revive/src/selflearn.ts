/**
 * Self-learning admission/eviction for the revive whitelist (拍板⑭, ruled
 * 2026-11-15: 白名单进出全自动、零人机环节). Every refined failure code keeps a
 * rolling-window sample trail: one sample opens at the failure and decides at
 * the session's next `turn/end` — completed = recovered, another death = not.
 * A `model/selection` between the failure and that outcome drops the sample
 * (the QUOTA attribution lesson machineized: a route switch that cured the
 * death is never the continue's credit). With n >= {@link SELFLEARN_MIN_N}
 * decided samples and a bare recovery rate >= {@link SELFLEARN_MIN_RATE}, a
 * code not already classified revive-class auto-enters the whitelist; a
 * LEARNED entry whose auto-revivals fail to complete
 * {@link SELFLEARN_EVICT_STRIKES} times in a row auto-evicts to the parked
 * stop channel. Everything is in-memory, event-driven (fed from the policy's
 * existing entry points), zero polling, zero transcript reads, zero AI.
 *
 * Layering (拍板⑨ 接线): the learner only ever mutates its OWN admitted set —
 * config-pinned lists (`reviveCodes`/`wallCodes`) and the code-ruled
 * `STOP_CAUSES` are classOf !== 'other', so they are never admitted, never
 * struck, never evicted; 「配置值仍可覆盖」holds in both directions and the
 * 「改阈值/改类目归人」obligation stays where it was. The four threshold values
 * are ruled constants (改值 = T2 归人).
 * @module dsh-session-revive/selflearn
 */

import type { FailureClass } from './config.ts'

/** Minimum decided samples in the window before a code may auto-admit (拍板⑭, 改值 = T2). */
export const SELFLEARN_MIN_N = 10
/** Minimum bare recovery rate (recovered / decided) before a code may auto-admit (拍板⑭, 改值 = T2). */
export const SELFLEARN_MIN_RATE = 0.55
/** Consecutive auto-revived deaths that evict one LEARNED entry (拍板⑭, 改值 = T2). */
export const SELFLEARN_EVICT_STRIKES = 3
/** Rolling window: samples older than this age out (拍板⑭ 时间衰减防老数据钉名单, 改值 = T2). */
export const SELFLEARN_WINDOW_DAYS = 30
/** {@link SELFLEARN_WINDOW_DAYS} in ms. */
export const SELFLEARN_WINDOW_MS = SELFLEARN_WINDOW_DAYS * 24 * 60 * 60 * 1000

/**
 * The coarse catch-all bucket (拍板⑭ 粗码桶坑): `PI_AI_ERROR` is a harness
 * default class, not a refined code — it never enters the statistics. Every
 * other code reaching {@link SelfLearn.onFailure} has already been through
 * `refineFailureCode()`.
 */
const NON_STAT_CODES: ReadonlySet<string> = new Set(['PI_AI_ERROR'])

/** One failure sample: opens pending, decides at the session's next turn end. */
interface Sample {
  readonly at: number
  readonly sessionId: string
  /** `undefined` = pending (not yet decided, never counted in n). */
  recovered?: boolean
  /** The revival that opened this sample was an auto-revival of a LEARNED entry. */
  autoRevived?: boolean
}

interface CodeState {
  samples: Sample[]
  /** Samples dropped before deciding (model/selection confound), lifetime count. */
  excluded: number
  /** Consecutive auto-revived deaths of this code's LEARNED entry. */
  strikes: number
}

interface Pending {
  code: string
  sample: Sample
}

/** One admission or eviction verdict, turned into a ledger line by the policy. */
export type SelfLearnEvent =
  | { type: 'admit'; at: number; code: string; n: number; rate: number }
  | { type: 'evict'; at: number; code: string; n: number; rate: number; strikes: number; sessionId: string }

/** Per-code statistics as the status endpoint echoes them. */
export interface SelfLearnCodeSnapshot {
  code: string
  /** Decided samples inside the rolling window (the n of n >= 10). */
  n: number
  recovered: number
  /** recovered / n; 0 while n = 0. */
  rate: number
  excluded: number
  strikes: number
}

/** The status endpoint's selflearn block (拍板⑭ 统计回显). */
export interface SelfLearnSnapshot {
  windowDays: number
  thresholds: { minN: number; minRate: number; evictStrikes: number }
  admitted: string[]
  evicted: string[]
  codes: SelfLearnCodeSnapshot[]
}

/**
 * The self-learning loop: sample trail, threshold admission, and strike-based
 * eviction of learned entries. Pure and time-explicit — every entry point
 * takes the event timestamp, so tests drive it with a fake clock exactly like
 * {@link RevivalPolicy}.
 */
export class SelfLearn {
  private readonly states = new Map<string, CodeState>()
  private readonly pending = new Map<string, Pending>()
  private readonly admittedSet = new Set<string>()
  private readonly evictedSet = new Set<string>()
  /** Effective class lookup supplied by the policy (config lists + learned admissions). */
  private readonly classOf: (code: string) => FailureClass

  constructor(options: { classOf: (code: string) => FailureClass }) {
    this.classOf = options.classOf
  }

  /** Whether the learner auto-admitted this code (its entry, its strikes, its eviction). */
  isAdmitted(code: string): boolean {
    return this.admittedSet.has(code)
  }

  /** Whether this code was evicted (sticky for the run: later stats never re-admit it). */
  isEvicted(code: string): boolean {
    return this.evictedSet.has(code)
  }

  /**
   * One `turn/end` error: decide the session's previous sample (it died again)
   * first, then open a fresh sample for this refined code.
   * @param code - the refined failure code (post `refineFailureCode()`).
   * @param sessionId - the session the failure belongs to.
   * @param at - event timestamp.
   * @returns admission/eviction events produced by the previous sample's close.
   */
  onFailure(code: string, sessionId: string, at: number): SelfLearnEvent[] {
    const events = this.close(sessionId, at, false)
    if (!NON_STAT_CODES.has(code)) {
      const sample: Sample = { at, sessionId }
      this.stateOf(code).samples.push(sample)
      this.pending.set(sessionId, { code, sample })
    }
    this.prune(at)
    return events
  }

  /**
   * A turn ended without an error: the session demonstrably ran again, so the
   * pending sample (if any) decides recovered.
   * @param sessionId - the session that completed a turn.
   * @param at - event timestamp.
   * @returns admission events the recovery may have crossed the line for.
   */
  onSuccess(sessionId: string, at: number): SelfLearnEvent[] {
    const events = this.close(sessionId, at, true)
    this.prune(at)
    return events
  }

  /**
   * A durable `model/selection` landed between the failure and its outcome:
   * the sample is confounded (换路由治好的不算 continue 的功劳) and is dropped
   * undecided — it never enters n, never credits a recovery.
   */
  onRouteChange(sessionId: string): void {
    this.drop(sessionId, true)
  }

  /** The session is gone with its sample still undecided: drop it (no observation, no counter). */
  onForget(sessionId: string): void {
    this.drop(sessionId, false)
  }

  /**
   * Mark the session's pending sample as auto-revived — only the policy calls
   * this for a revival of a LEARNED entry (拍板⑭ 除名 counts 自动复活 of what
   * the learner put in; config-pinned codes are the human layer and never
   * accumulate strikes).
   */
  markRevived(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry !== undefined) entry.sample.autoRevived = true
  }

  /** Bounded introspection for the status endpoint; `at` applies the rolling window. */
  snapshot(at: number): SelfLearnSnapshot {
    this.prune(at)
    const codes: SelfLearnCodeSnapshot[] = []
    for (const [code, state] of this.states) {
      const { n, recovered } = this.windowStats(state, at)
      codes.push({
        code,
        n,
        recovered,
        rate: n === 0 ? 0 : recovered / n,
        excluded: state.excluded,
        strikes: state.strikes,
      })
    }
    codes.sort((a, b) => b.n - a.n || a.code.localeCompare(b.code))
    return {
      windowDays: SELFLEARN_WINDOW_DAYS,
      thresholds: { minN: SELFLEARN_MIN_N, minRate: SELFLEARN_MIN_RATE, evictStrikes: SELFLEARN_EVICT_STRIKES },
      admitted: [...this.admittedSet].sort(),
      evicted: [...this.evictedSet].sort(),
      codes: codes.slice(0, 100),
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private stateOf(code: string): CodeState {
    let state = this.states.get(code)
    if (state === undefined) {
      state = { samples: [], excluded: 0, strikes: 0 }
      this.states.set(code, state)
    }
    return state
  }

  /** Close the session's pending sample as recovered / not-recovered and run the verdicts. */
  private close(sessionId: string, at: number, recovered: boolean): SelfLearnEvent[] {
    const entry = this.pending.get(sessionId)
    if (entry === undefined) return []
    this.pending.delete(sessionId)
    entry.sample.recovered = recovered
    const state = this.stateOf(entry.code)
    if (recovered) {
      // Any completed turn breaks the streak — the code demonstrably runs again.
      state.strikes = 0
    } else if (entry.sample.autoRevived === true) {
      state.strikes += 1
    }
    const events = this.checkEvict(entry.code, at, sessionId)
    events.push(...this.checkAdmit(entry.code, at))
    return events
  }

  private drop(sessionId: string, countExcluded: boolean): void {
    const entry = this.pending.get(sessionId)
    if (entry === undefined) return
    this.pending.delete(sessionId)
    if (countExcluded) this.stateOf(entry.code).excluded += 1
  }

  /**
   * Evict a LEARNED entry at the strike line: it leaves the whitelist, later
   * errors park on the stop-parked channel, and the policy writes the ledger
   * + alarm lines. Sticky for the run — re-admission only happens after a
   * restart re-asserts the config layer (配置值仍可覆盖).
   */
  private checkEvict(code: string, at: number, sessionId: string): SelfLearnEvent[] {
    if (this.evictedSet.has(code)) return []
    const state = this.states.get(code)
    if (state === undefined || state.strikes < SELFLEARN_EVICT_STRIKES) return []
    // The strike model only ever counts auto-revivals of learned entries, so a
    // strike line here already implies the learner owns this code.
    if (!this.admittedSet.has(code)) return []
    this.admittedSet.delete(code)
    this.evictedSet.add(code)
    const { n, recovered } = this.windowStats(state, at)
    return [{ type: 'evict', at, code, n, rate: n === 0 ? 0 : recovered / n, strikes: state.strikes, sessionId }]
  }

  /**
   * Admit a brand-new code once the window proves it: n >= 10 decided samples
   * AND bare recovery rate >= 55%. Codes already revive-class (config-pinned
   * or `STOP_CAUSES`) and wall-class codes are classOf !== 'other' — the
   * learner never touches them (no ledger line, no set change).
   */
  private checkAdmit(code: string, at: number): SelfLearnEvent[] {
    if (this.evictedSet.has(code) || this.admittedSet.has(code)) return []
    if (this.classOf(code) !== 'other') return []
    const state = this.states.get(code)
    if (state === undefined) return []
    const { n, recovered } = this.windowStats(state, at)
    if (n < SELFLEARN_MIN_N) return []
    const rate = recovered / n
    if (rate < SELFLEARN_MIN_RATE) return []
    this.admittedSet.add(code)
    return [{ type: 'admit', at, code, n, rate }]
  }

  /** Decided samples of one code inside the rolling window. */
  private windowStats(state: CodeState, at: number): { n: number; recovered: number } {
    let n = 0
    let recovered = 0
    for (const sample of state.samples) {
      if (at - sample.at >= SELFLEARN_WINDOW_MS) continue
      if (sample.recovered === undefined) continue
      n += 1
      if (sample.recovered) recovered += 1
    }
    return { n, recovered }
  }

  /** Time decay: age samples out of the window and stale pendings out of the trail. */
  private prune(at: number): void {
    for (const [sessionId, entry] of this.pending) {
      if (at - entry.sample.at >= SELFLEARN_WINDOW_MS) this.pending.delete(sessionId)
    }
    for (const state of this.states.values()) {
      state.samples = state.samples.filter((sample) => at - sample.at < SELFLEARN_WINDOW_MS)
    }
  }
}
