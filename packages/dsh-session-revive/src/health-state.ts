/**
 * Mechanism-health state file (拍板⑮, ruled 2026-11-15: the shield reports
 * revive mechanism health ONLY — 插件激活 / mode=live / status 端点可读 /
 * 断路器无连跳 / 无 HALT — 正常静默、异常才亮). The plugin folds those five
 * facts into ONE small JSON at `<dsh-home>/session-revive-health.json` and
 * writes it ONLY when a fact flips (拍板⑮ 字面: 只在状态变化时写、正常运行近零
 * 写入) — unlike the auto-route poll ledger there is deliberately NO per-tick
 * heartbeat, so the harness reader attaches by presence/parse, not mtime.
 *
 * Cross-repo contract, duty-file style (auto-route `poll-state.ts` is the
 * pipeline precedent): this package publishes facts + the composed `ok`;
 * the reader counterpart is `deepseek-harness` `packages/api/session-controller/
 * src/revive-health.ts` `REVIVE_HEALTH_FILE` — keep the two constants in sync.
 *
 * Best-effort by design: a failed write is swallowed — the reader then sees
 * the file absent/stale and degrades to the 「未接线」 quiet line, never a
 * false red (auto-route's fail-open family). A state-file hiccup must never
 * bubble into the revival chain.
 * @module dsh-session-revive/health-state
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'

/** Ledger filename under the DSH home; mirrored by the harness reader. */
export const REVIVE_HEALTH_FILE = 'session-revive-health.json'

/** host-revive's state file (dsh-defense-hardening-1103), read for the HALT fact. */
export const HOST_REVIVE_STATE_FILE = 'dsh-host-revive-state.json'

/**
 * Consecutive breaker trips without an intervening completed turn that still
 * read as healthy — a single trip is normal defense (狼来了 discipline: one
 * fact, one alarm, no threshold-less reds), a run of them is 连跳. This is a
 * shield-face judgment value, NOT one of the four frozen 拍板⑭ thresholds.
 */
export const REVIVE_TRIP_STREAK_LIMIT = 3

/** The five mechanism-health facts, flat for change detection and the wire. */
export interface ReviveHealthFacts {
  /** The plugin effect is mounted (the file's presence itself asserts this). */
  readonly active: boolean
  readonly mode: 'shadow' | 'live'
  /** The status payload builder ran without throwing (端点可读). */
  readonly status: 'ok' | 'error'
  /** Current consecutive breaker trips since the last completed turn. */
  readonly breakerTrips: number
  /** breakerTrips below {@link REVIVE_TRIP_STREAK_LIMIT}. */
  readonly breakerOk: boolean
  /** host-revive is HALTed (missing state file reads as healthy, 零痕迹). */
  readonly halted: boolean
}

/** One published document: the facts plus the composed verdict and stamp. */
export interface ReviveHealthState extends ReviveHealthFacts {
  readonly at: number
  readonly ok: boolean
}

/** The verdict the shield keys on: all five conditions hold (拍板⑭⑮). */
export function reviveHealthOk(facts: ReviveHealthFacts): boolean {
  return facts.active && facts.mode === 'live' && facts.status === 'ok' && facts.breakerOk && !facts.halted
}

/**
 * The host-revive HALT fact: its state file is the only HALT in the revive
 * family (dsh-defense-hardening-1103 journal). 健康态零痕迹 — a missing or
 * unparseable file reads as NOT halted, exactly like the duty ledger's
 * host-revive row (never a false red).
 * @param path - state file location (injectable for tests).
 * @returns whether host-revive is currently HALTed.
 */
export function readHostReviveHalted(path = join(dshHome(), HOST_REVIVE_STATE_FILE)): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { halted?: unknown }
    return parsed.halted === true
  } catch {
    return false
  }
}

/**
 * Publish one health snapshot (atomic replace: write temp, then rename, so
 * the reader never observes a half-written document).
 * @param state - the composed facts; facts only, no policy.
 */
export function writeReviveHealth(state: ReviveHealthState): void {
  try {
    const path = join(dshHome(), REVIVE_HEALTH_FILE)
    const temp = `${path}.tmp`
    writeFileSync(temp, `${JSON.stringify(state)}\n`, 'utf8')
    renameSync(temp, path)
  } catch {
    // Best-effort: see module doc. The reader degrades to the quiet line.
  }
}

/**
 * Remove the ledger (plugin disabled or unloaded). Force-ignores absence;
 * errors are swallowed for the same best-effort reason — a leftover file
 * simply keeps its last facts until the next mount rewrites them.
 */
export function removeReviveHealth(): void {
  try {
    rmSync(join(dshHome(), REVIVE_HEALTH_FILE), { force: true })
  } catch {
    // Best-effort: see module doc.
  }
}

/** Injectable seams so tests never touch the real DSH home. */
export interface MechanismHealthOptions {
  mode: 'shadow' | 'live'
  readStatus: () => 'ok' | 'error'
  readHalted: () => boolean
  write?: (state: ReviveHealthState) => void
  remove?: () => void
  now?: () => number
}

/**
 * The five-fact tracker: arms the breaker streak, evaluates on demand, and
 * writes ONLY when the fact bundle changes (正常运行近零写入). Event-driven —
 * the host calls {@link MechanismHealth.sync} from existing turn/end handling
 * and at mount; there is no timer of its own (零轮询).
 */
export class MechanismHealth {
  private tripStreak = 0
  private lastFacts: string | undefined
  private readonly mode: 'shadow' | 'live'
  private readonly readStatus: () => 'ok' | 'error'
  private readonly readHalted: () => boolean
  private readonly write: (state: ReviveHealthState) => void
  private readonly remove: () => void
  private readonly now: () => number

  constructor(options: MechanismHealthOptions) {
    this.mode = options.mode
    this.readStatus = options.readStatus
    this.readHalted = options.readHalted
    this.write = options.write ?? writeReviveHealth
    this.remove = options.remove ?? removeReviveHealth
    this.now = options.now ?? (() => Date.now())
  }

  /** One breaker trip landed (from the policy's breaker records). */
  noteTrip(): void {
    this.tripStreak += 1
  }

  /** A turn completed: the mechanism demonstrably works, the streak clears. */
  noteCompleted(): void {
    this.tripStreak = 0
  }

  /**
   * Evaluate the five facts and write iff the bundle changed since the last
   * write. The `at` stamp rides only real changes — comparing it would turn
   * every evaluation into a write and break 近零写入.
   */
  sync(): void {
    const facts: ReviveHealthFacts = {
      active: true,
      mode: this.mode,
      status: this.safeStatus(),
      breakerTrips: this.tripStreak,
      breakerOk: this.tripStreak < REVIVE_TRIP_STREAK_LIMIT,
      halted: this.safeHalted(),
    }
    const key = JSON.stringify(facts)
    if (key === this.lastFacts) return
    this.lastFacts = key
    this.write({ ...facts, at: this.now(), ok: reviveHealthOk(facts) })
  }

  /** Plugin disabled/unloaded: the face disappears (面消失, not 面变坏). */
  dispose(): void {
    this.remove()
  }

  private safeStatus(): 'ok' | 'error' {
    try {
      return this.readStatus()
    } catch {
      return 'error'
    }
  }

  private safeHalted(): boolean {
    try {
      return this.readHalted()
    } catch {
      return false
    }
  }
}
