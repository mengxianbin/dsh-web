/**
 * Stall probes — the two watchdog death causes revive must cover before the
 * boss retires (`pure-worker-migration-1123` §三 缺项①②, design §7.4):
 *
 * - 缺项① **owner-heartbeat-stall**: the taskbot checkpoint
 *   (`~/.dsh/taskbot-state.json`) heartbeat is stale past the ruled 15 min
 *   grace — the owner chain is dead while nobody emits any event for it.
 *   Dual-name read (`heartbeatAt ?? heartbeat`, watchdog parity: real batches
 *   write `heartbeat` while the contract name is `heartbeatAt`).
 * - 缺项② **turn-open-stall**: a session whose turn is still open while its
 *   transcript has been silent past the ruled 30 min
 *   (`--turn-open-stall-ms 1800000`, decision-log 2026-11-06T16:45 turnOpen
 *   第二轴 — the same line session-status draws as 🔴 疑似停滞).
 *
 * Both probes are **evidence-first**: each crossing emits exactly one
 * structured `stall-detected` reading (edge-triggered; `next: 'E13'` names
 * the FSM 断链 event this death feeds — the receiving side's `stalled`
 * evidence field shipped with the FSM host deps in B1), and every recovery
 * emits `stall-cleared`. No send, no kill, no quota/breaker/wave state: the
 * probes are a new detector, not a new actor, and revive's ruled account
 * stays the single writer of its own counters.
 *
 * Scheduling is **deadline-armed**: one timer lives in the plugin shell
 * (`armStall`), armed for the earliest of the heartbeat read and the open
 * turn deadlines. The heartbeat read itself is cadence-bounded (30 s while a
 * source exists, 5 min while the file is absent) — the same poll shape the
 * watchdog ran, so a live owner advancing `heartbeatAt` never reads stale.
 *
 * Absent/unreadable checkpoint = **no source, no reading** (fail silent to
 * absence, never a false kill): the file dies with the boss, and 对账表 row 7
 * assigns unreadable state to the fsm store's fail-closed face, not here.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Which of the two ruled death causes a reading reports. */
export type StallCause = 'owner-heartbeat-stall' | 'turn-open-stall'

/**
 * Detail of one stall line. Known keys stay typed for callers/tests; the
 * index signature keeps the value assignable to the shell's `LogRecord.detail`
 * (`Record<string, unknown>`) without a cast.
 */
export type StallDetail = {
  cause: StallCause
  /** FSM event this death feeds (E13 断链 → G5 stalled evidence, §7.4). */
  next?: 'E13'
  /** Why a `stall-cleared` line fired. */
  reason?: 'turn-end' | 'activity' | 'turn-restart' | 'disposed' | 'heartbeat-fresh' | 'no-heartbeat-source'
  /** owner-heartbeat-stall measurements. */
  staleMs?: number
  graceMs?: number
  heartbeatAt?: number
  field?: 'heartbeatAt' | 'heartbeat'
  ownerSessionId?: string
  /** turn-open-stall measurements. */
  silentMs?: number
  thresholdMs?: number
  turnStartAt?: number
  [key: string]: unknown
}

/** One structured reading (rides the shell's `kind: 'log'` line shape). */
export interface StallRecord {
  kind: 'log'
  at: number
  event: 'stall-detected' | 'stall-cleared'
  sessionId?: string
  detail: StallDetail
}

/**
 * 件3 案 A (ask `case3-pick` 2026-11-24): which detected stalls are
 * send-worthy — `turn-open-stall` only, with a session id. The
 * `owner-heartbeat-stall` half keeps its evidence-only ruling (narrow
 * exemption ask `subprocess-exempt`) and never reaches the send account.
 * @param records - one sweep/event batch.
 * @returns the ruled death crossings (session + crossing time).
 */
export function ruledStallDeaths(records: readonly StallRecord[]): Array<{ sessionId: string; at: number }> {
  const deaths: Array<{ sessionId: string; at: number }> = []
  for (const record of records) {
    if (record.event === 'stall-detected' && record.detail.cause === 'turn-open-stall' && record.sessionId !== undefined) {
      deaths.push({ sessionId: record.sessionId, at: record.at })
    }
  }
  return deaths
}

/** Ruled defaults (watchdog flag parity — values live here, config may move them). */
export const STALL_HEARTBEAT_GRACE_MS = 900_000
/** turnOpen 第二轴 (decision-log 2026-11-06): open turn + silence ≥ 30 min. */
export const STALL_TURN_OPEN_MS = 1_800_000
/** Heartbeat read cadence while a source exists (watchdog `--poll-ms 30000`). */
export const HEARTBEAT_READ_MS = 30_000
/** Backoff when the checkpoint is absent/unreadable (no source to poll). */
export const HEARTBEAT_RETRY_MS = 300_000
/** Default taskbot checkpoint path (watchdog `statePath` home default). */
export const HEARTBEAT_DEFAULT_PATH = join(homedir(), '.dsh', 'taskbot-state.json')

/** One parsed owner heartbeat. */
export interface HeartbeatSource {
  /** Epoch ms of the last heartbeat write. */
  at: number
  /** Owner session id with the watchdog's `session-` prefix stripped. */
  ownerSessionId?: string
  /** Which field carried the timestamp (dual-name compat evidence). */
  field: 'heartbeatAt' | 'heartbeat'
}

/**
 * Best-effort checkpoint reader: a missing file, an unparseable blob or an
 * invalid timestamp all resolve `undefined` (no source, no reading — see the
 * module header). Sync read, tiny file, called on the cadence above only.
 * @param path - checkpoint path to read.
 * @returns the parsed heartbeat, or undefined when no usable source exists.
 */
export function makeHeartbeatReader(path: string): () => HeartbeatSource | undefined {
  return () => {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const field: 'heartbeatAt' | 'heartbeat' | undefined =
        typeof raw.heartbeatAt === 'string'
          ? 'heartbeatAt'
          : typeof raw.heartbeat === 'string'
            ? 'heartbeat'
            : undefined
      if (field === undefined) return undefined
      const at = Date.parse(raw[field] as string)
      if (!Number.isFinite(at)) return undefined
      // Watchdog parity: the checkpoint stores `session-…` while session ids
      // elsewhere carry the bare id (taskbot-watchdog.mjs sessionIdle strip).
      const owner = typeof raw.ownerSessionId === 'string' ? raw.ownerSessionId.replace(/^session-/, '') : undefined
      return { at, field, ...(owner !== undefined && owner !== '' ? { ownerSessionId: owner } : {}) }
    } catch {
      return undefined
    }
  }
}

/** Tunables the tracker reads (resolved config supplies all three). */
export interface StallOptions {
  /** Heartbeat staleness grace (default 900_000 = watchdog `--grace-ms`). */
  heartbeatGraceMs: number
  /** Open-turn silence threshold (default 1_800_000 = watchdog `--turn-open-stall-ms`). */
  turnOpenStallMs: number
}

interface OpenTurn {
  startedAt: number
  lastAt: number
}

function detected(at: number, detail: StallDetail, sessionId?: string): StallRecord {
  return { kind: 'log', at, event: 'stall-detected', ...(sessionId !== undefined ? { sessionId } : {}), detail }
}

function cleared(at: number, cause: StallCause, reason: NonNullable<StallDetail['reason']>, sessionId?: string): StallRecord {
  return {
    kind: 'log',
    at,
    event: 'stall-cleared',
    ...(sessionId !== undefined ? { sessionId } : {}),
    detail: { cause, reason },
  }
}

/**
 * Edge-triggered detector for the two ruled stall causes. Pure state machine:
 * the plugin shell owns the timer and feeds `sweep` its deadlines through
 * `nextCheckAt`; every public method is synchronous and allocation-light so
 * it can sit on the session-event hot path.
 */
export class StallTracker {
  private readonly turns = new Map<string, OpenTurn>()
  private readonly stalledTurns = new Set<string>()
  private heartbeatStalled = false
  private nextHeartbeatReadAt: number

  constructor(
    private readonly options: StallOptions,
    private readonly readHeartbeat: () => HeartbeatSource | undefined,
    private readonly now: () => number,
  ) {
    this.nextHeartbeatReadAt = now()
  }

  /**
   * Feed one session event: `turn/end` closes the episode, `turn/start`
   * (re)opens it, every other event refreshes the silence clock (and ends a
   * stalled episode — the silence that fired it is over).
   * @param sessionId - the session the event belongs to.
   * @param type - harness event type literal.
   * @param at - event timestamp (ms).
   * @returns records to log (edge-triggered: clear lines only on a flip).
   */
  onEvent(sessionId: string, type: string, at: number): StallRecord[] {
    const open = this.turns.get(sessionId)
    if (type === 'turn/end') {
      if (open === undefined) return []
      this.turns.delete(sessionId)
      if (this.stalledTurns.delete(sessionId)) return [cleared(at, 'turn-open-stall', 'turn-end', sessionId)]
      return []
    }
    if (type === 'turn/start') {
      const records: StallRecord[] = []
      if (this.stalledTurns.delete(sessionId)) records.push(cleared(at, 'turn-open-stall', 'turn-restart', sessionId))
      this.turns.set(sessionId, { startedAt: at, lastAt: at })
      return records
    }
    if (open === undefined) return []
    open.lastAt = at
    if (this.stalledTurns.delete(sessionId)) return [cleared(at, 'turn-open-stall', 'activity', sessionId)]
    return []
  }

  /**
   * Seed an open turn seen before this plugin mounted (checkpoint
   * `openTurnStartSeq` — the boot sweep's tier-1 projection). The silence
   * clock starts at seed time: a pre-mount turn can only be judged from the
   * moment this plugin could observe it, never retroactively.
   * @param sessionId - session whose turn was already open at mount.
   * @param at - seed timestamp (ms).
   */
  seedTurn(sessionId: string, at: number): void {
    if (this.turns.has(sessionId)) return
    this.turns.set(sessionId, { startedAt: at, lastAt: at })
  }

  /**
   * Drop a disposed session; a stalled episode ends with an evidence line.
   * @param sessionId - the disposed session.
   * @returns records to log.
   */
  onDisposed(sessionId: string): StallRecord[] {
    const tracked = this.turns.delete(sessionId)
    const stalled = this.stalledTurns.delete(sessionId)
    if (tracked && stalled) return [cleared(this.now(), 'turn-open-stall', 'disposed', sessionId)]
    return []
  }

  /**
   * Evaluate every deadline due at `at`: the heartbeat read (cadence-gated)
   * and each open turn's silence. Edge-triggered — one `stall-detected` per
   * episode, one `stall-cleared` per recovery.
   * @param at - evaluation timestamp (ms).
   * @returns records to log, in evaluation order.
   */
  sweep(at: number): StallRecord[] {
    const records: StallRecord[] = []
    if (at >= this.nextHeartbeatReadAt) {
      const source = this.readHeartbeat()
      if (source === undefined) {
        this.nextHeartbeatReadAt = at + HEARTBEAT_RETRY_MS
        if (this.heartbeatStalled) {
          this.heartbeatStalled = false
          records.push(cleared(at, 'owner-heartbeat-stall', 'no-heartbeat-source'))
        }
      } else {
        this.nextHeartbeatReadAt = at + HEARTBEAT_READ_MS
        const staleMs = at - source.at
        if (staleMs >= this.options.heartbeatGraceMs) {
          if (!this.heartbeatStalled) {
            this.heartbeatStalled = true
            records.push(
              detected(
                at,
                {
                  cause: 'owner-heartbeat-stall',
                  next: 'E13',
                  staleMs,
                  graceMs: this.options.heartbeatGraceMs,
                  heartbeatAt: source.at,
                  field: source.field,
                  ...(source.ownerSessionId !== undefined ? { ownerSessionId: source.ownerSessionId } : {}),
                },
                source.ownerSessionId,
              ),
            )
          }
        } else if (this.heartbeatStalled) {
          this.heartbeatStalled = false
          records.push(cleared(at, 'owner-heartbeat-stall', 'heartbeat-fresh', source.ownerSessionId))
        }
      }
    }
    for (const [sessionId, open] of this.turns) {
      if (this.stalledTurns.has(sessionId)) continue
      const silentMs = at - open.lastAt
      if (silentMs >= this.options.turnOpenStallMs) {
        this.stalledTurns.add(sessionId)
        records.push(
          detected(at, {
            cause: 'turn-open-stall',
            next: 'E13',
            silentMs,
            thresholdMs: this.options.turnOpenStallMs,
            turnStartAt: open.startedAt,
          }, sessionId),
        )
      }
    }
    return records
  }

  /**
   * Earliest future deadline the shell must arm for (heartbeat read or the
   * soonest open-turn silence threshold). Never null while the plugin runs:
   * the heartbeat cadence always schedules the next read.
   * @returns absolute epoch ms of the next check.
   */
  nextCheckAt(): number {
    let deadline = this.nextHeartbeatReadAt
    for (const [sessionId, open] of this.turns) {
      if (this.stalledTurns.has(sessionId)) continue
      const turnDeadline = open.lastAt + this.options.turnOpenStallMs
      if (turnDeadline < deadline) deadline = turnDeadline
    }
    return deadline
  }

  /** Test/status snapshot of the detector's episode state. */
  snapshot(): { openTurns: number; stalledTurns: number; heartbeatStalled: boolean } {
    return {
      openTurns: this.turns.size,
      stalledTurns: this.stalledTurns.size,
      heartbeatStalled: this.heartbeatStalled,
    }
  }
}
