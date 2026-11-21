/**
 * Boss-presence gate + halt-wake for the dispatch route
 * (dispatch-gate-halt-wake-1121). The route asks one question per dispatch —
 * "is a boss in position?" — and answers it from the taskbot checkpoint
 * (`$DSH_HOME/taskbot-state.json`, the same file the SKILL in-position
 * reading and the watchdog use), so the gate adds no new probe surface.
 *
 * Two halves, one snapshot:
 * - {@link decideBossGate} is the pure verdict. The board's reject condition
 *   is a positive conjunction — `stopFlag=halt` AND heartbeat older than the
 *   15-minute grace — so a wedge is only refused when it is provable, and an
 *   unreadable/missing checkpoint degrades to "allow + warn + trace" instead
 *   of wedging the dispatch channel behind a broken sensor (same fail-open
 *  -with-a-trace precedent as the 409 ledger read).
 * - {@link TaskbotBossGate.wakeIfHalted} is leg 2: when the snapshot says a
 *   leftover halt is present, clear it (single-field read-modify-write,
 *   atomic temp+rename, fresh re-read so a concurrent lock claim is not
 *   clobbered) so the existing self-heal chain (guard-check → watchdog →
 *   dispatchTakeover) re-arms and opens the next boss. The wake fires on any
 *   halt snapshot — even a rejected dispatch — because the refused dispatch
 *   *is* the "new work arrived" event. It only ever acts on `halt`, never on
 *   other stopFlag values, so new streaming bosses (which never write halt)
 *   are untouched.
 * @module dsh-session-dispatch/host/boss-gate
 */

import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

/** Heartbeat grace before a boss counts as absent: the SKILL in-position reading and the watchdog wide margin share this value. */
export const BOSS_HEARTBEAT_STALE_MS = 15 * 60_000

/** The checkpoint fields the gate reads (structural: the file is taskbot's, this is a read face only). */
export interface BossStateSnapshot {
  readonly ownerSessionId?: unknown
  /** ISO-8601 contract name; the legacy `heartbeat` spelling is accepted too (watchdog dual-name read). */
  readonly heartbeatAt?: unknown
  readonly heartbeat?: unknown
  readonly stopFlag?: unknown
}

/** One checkpoint read. Failures surface as readings, never as throws. */
export type BossGateReading =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'state'; readonly state: BossStateSnapshot }

/** Verdict vocabulary: `reject` refuses the dispatch, `degraded` allows it with a loud trace. */
export type BossGateVerdict = 'allow' | 'reject' | 'degraded'

/** One gate decision. `halt` mirrors the snapshot (pre-wake!) and drives the wake step. */
export interface BossGateDecision {
  readonly verdict: BossGateVerdict
  readonly reason: string
  readonly halt: boolean
}

/**
 * Pure gate verdict — no I/O, no clock of its own.
 * @param reading - one checkpoint read (snapshot taken BEFORE any wake write).
 * @param sessionClass - wire class after body normalization; absent means `human`.
 * @param nowMs - epoch ms (test seam; the route passes Date.now()).
 * @param staleMs - heartbeat grace, default {@link BOSS_HEARTBEAT_STALE_MS}.
 * @returns allow / reject / degraded plus the snapshot's halt flag.
 */
export function decideBossGate(
  reading: BossGateReading,
  sessionClass: string | undefined,
  nowMs: number,
  staleMs: number = BOSS_HEARTBEAT_STALE_MS,
): BossGateDecision {
  const halt = reading.kind === 'state' && reading.state.stopFlag === 'halt'
  // Only bot work is gated: human direct dispatch stays open, and the
  // bot-boss class must never be gated or 单任务施工入口分支一 (open a boss
  // when none is in position) could not run — that is the escape hatch the
  // reject text points callers at. The legacy `bot` wire spelling folds to
  // bot-worker here too (the body parser already normalizes it; repeating it
  // keeps the gate closed for any caller that bypasses the parser).
  const cls = sessionClass === 'bot' ? 'bot-worker' : (sessionClass ?? 'human')
  if (cls !== 'bot-worker') return { verdict: 'allow', reason: 'class-not-gated', halt }
  // Sensor failures cannot prove a wedge: allow, but leave a trace (design
  // §2.1 选型③ — 拒派可降级为警告+留痕).
  if (reading.kind === 'missing') return { verdict: 'degraded', reason: 'state-missing', halt }
  if (reading.kind === 'unreadable') return { verdict: 'degraded', reason: `state-unreadable: ${reading.detail}`, halt }
  const hbRaw = reading.state.heartbeatAt ?? reading.state.heartbeat
  const parsed = typeof hbRaw === 'string' ? Date.parse(hbRaw) : Number.NaN
  // Unparseable/absent heartbeat under a halt reads as stale: a halted boss
  // with no heartbeat is more dead, not less.
  const stale = !Number.isFinite(parsed) || nowMs - parsed > staleMs
  if (halt && stale) return { verdict: 'reject', reason: 'halt-stale', halt }
  return {
    verdict: 'allow',
    reason: halt ? 'halt-fresh' : stale ? 'stale-no-halt' : 'in-position',
    halt,
  }
}

/** The gate surface the dispatch route consumes (structural, like bindings/attention). */
export interface DispatchBossGate {
  /** Read the checkpoint once; never rejects — failures become readings. */
  check(): Promise<BossGateReading>
  /**
   * Leg-2 wake: clear a leftover `stopFlag=halt` (fresh re-read, single-field
   * patch, atomic temp+rename). @returns true only when this call cleared it.
   */
  wakeIfHalted(): Promise<boolean>
}

/** Construction options for the file-backed gate. */
export interface TaskbotBossGateOptions {
  /** Absolute path of the taskbot checkpoint (default wiring: `$DSH_HOME/taskbot-state.json`). */
  readonly statePath: string
}

/**
 * File-backed {@link DispatchBossGate}. Every method swallows its own I/O
 * errors into readings / `false`: a gate that throws would take the dispatch
 * route down with it, which is the one failure form the availability gate
 * (问4) forbids.
 */
export class TaskbotBossGate implements DispatchBossGate {
  private readonly statePath: string

  constructor(options: TaskbotBossGateOptions) {
    this.statePath = options.statePath
  }

  async check(): Promise<BossGateReading> {
    let raw: string
    try {
      raw = await readFile(this.statePath, 'utf8')
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      // Missing file = taskbot never ran = no halt evidence; other errors
      // (EACCES, transient lock) = the sensor is unreliable.
      if (code === 'ENOENT') return { kind: 'missing' }
      return { kind: 'unreadable', detail: String((error as Error)?.message ?? error).slice(0, 200) }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { kind: 'unreadable', detail: 'checkpoint is not a JSON object' }
      }
      return { kind: 'state', state: parsed as BossStateSnapshot }
    } catch (error) {
      return { kind: 'unreadable', detail: String((error as Error)?.message ?? error).slice(0, 200) }
    }
  }

  async wakeIfHalted(): Promise<boolean> {
    let tmp: string | undefined
    try {
      // Fresh re-read: the wake must act on today's file, not the snapshot
      // another writer may have moved on from (design §3.2, ms window).
      const raw = await readFile(this.statePath, 'utf8')
      const doc: unknown = JSON.parse(raw)
      if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return false
      const record = doc as Record<string, unknown>
      if (record.stopFlag !== 'halt') return false
      record.stopFlag = 'none'
      tmp = `${this.statePath}.${randomUUID()}.tmp`
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await rename(tmp, this.statePath)
      return true
    } catch {
      // Wake is best-effort: the route's verdict already used the snapshot,
      // and source B (guard-check) retries on its next tick.
      if (tmp !== undefined) await unlink(tmp).catch(() => {})
      return false
    }
  }
}
