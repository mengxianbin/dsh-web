/**
 * Boot sweep (拍板账⑪): at plugin activation the plugin actively scans for
 * orphan turns — sessions whose stored log ends in a `turn/start` that never
 * met a `turn/end` — judges 中断归因 = 重启, and wakes each confirmed orphan
 * through the ruled staggered nudge with zero quota consumption. The scan
 * cannot wait for events: the `interrupted` closer is only written when the
 * session is next resumed (design §4.2 条3), so an idle killed session emits
 * nothing at all.
 *
 * Attribution is structural, not heuristic: every in-process stop commits a
 * `turn/end` (human abort → `aborted`, goal block → `blocked`, fork →
 * `forked`, failures → `error`, resume → `interrupted`), so a cold session
 * whose raw log ends inside a turn can only have been left that way by the
 * process dying mid-turn — a restart. No time window is needed, and none is
 * introduced (参数零改).
 *
 * Detection runs on existing seams only (zero harness changes), in two tiers
 * over `sessionController.list()` rows:
 * - tier 1 — the harness-maintained `turnBoundary` projection: a numeric
 *   `openTurnStartSeq` means the final `turn/start` never met a `turn/end`
 *   as of the last checkpoint flush (the same signal the summary row uses to
 *   read "interrupted mid-turn" without opening the Session).
 * - tier 2 — rows without a usable `turnBoundary` value (a session with no
 *   projection-cache record yet) carry no checkpoint to trust, so the raw
 *   read decides for them.
 * Every candidate is then CONFIRMED by a raw, unbalanced log read through
 * `sessionPersistence` before any nudge: the checkpoint lags the log by the
 * write-behind window (`writeIntervalMs` / `writeEveryEvents`; mandatory
 * only at creation, `turn/end`, and disposal), so the screen may over-call,
 * and only the raw stream distinguishes an open turn from a committed
 * `interrupted` closer. Residual, documented: a hard-kill restart landing
 * inside the write-behind window of the orphan's `turn/start` leaves the
 * checkpoint reading "closed" and that sub-window orphan is not screened; a
 * graceful restart flushes at session disposal and is caught.
 *
 * Every failure lands as a loud `boot-sweep-failed` line and stops that
 * path (fail closed — an unconfirmed session is never nudged).
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LogRecord, PolicyRecord } from './policy.ts'

/** One `SessionSummary` row as the sweep reads it (structural cast, same style as `ReviveSessionApi`). */
export interface SweepRow {
  readonly sessionId: string
  readonly running: boolean
  readonly agentAvailable: boolean
  readonly projections?: { readonly values: Readonly<Record<string, unknown>> }
}

/** How the list-side screen classifies one row before any log read. */
export type SweepClass = 'live' | 'closed' | 'candidate' | 'unknown'

/** Wire shape of the `turnBoundary` projection value the screen reads. */
interface TurnBoundaryValue {
  readonly openTurnStartSeq?: number | null
}

/**
 * Classify one list row for the sweep.
 * @param row - summary row from `sessionController.list`.
 * @returns `live` when a live Agent owns the row (running or attached — not
 *   an orphan), `closed` when the harness checkpoint proves the last turn
 *   ended, `candidate` when the checkpoint says a turn is open, `unknown`
 *   when no usable checkpoint exists (the raw read decides).
 */
export function classifySweepRow(row: SweepRow): SweepClass {
  if (row.running || row.agentAvailable) return 'live'
  const boundary = row.projections?.values.turnBoundary as TurnBoundaryValue | undefined
  const open = boundary?.openTurnStartSeq
  if (typeof open === 'number') return 'candidate'
  if (open === null) return 'closed'
  return 'unknown'
}

/** Result of balancing one raw stored log. */
export interface SweepScan {
  /** Whether the log's tail sits inside a turn (`turn/start` with no later `turn/end`). */
  open: boolean
  /** Latest folded usage (inputTokens + cacheReadTokens — the live folding's context definition), when observed. */
  contextTokens?: number
}

/**
 * Balance a raw (unbalanced) stored event list and report its tail state.
 * @param events - events in seq order exactly as `SessionPersistence` returns
 *   them (no synthetic closers — that is what distinguishes an orphan from a
 *   session already resumed after an interruption).
 * @returns whether the log ends inside a turn, plus the last observed context
 *   size for the 150k watermark gate.
 */
export function scanOpenTurn(events: readonly SessionEvent[]): SweepScan {
  let open = false
  let contextTokens: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
    else if (event.type === 'assistant/message') {
      const usage = event.data.usage
      if (usage !== undefined) contextTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0)
    }
  }
  return { open, ...(contextTokens === undefined ? {} : { contextTokens }) }
}

/** Boot-sweep collaboration surface; the plugin shell binds it to the live host services. */
export interface BootSweepDeps {
  /** Visible list rows (archived excluded). Rejections are retried — boot readiness races. */
  listRows: (signal: AbortSignal) => Promise<readonly SweepRow[]>
  /** Raw stored events for one session; `undefined` when the persistence seam is missing (fail closed). */
  readEvents: ((sessionId: string, signal: AbortSignal) => Promise<readonly SessionEvent[]>) | undefined
  /** Whether a live Agent owns the session right now (re-checked after the raw read, before deciding). */
  isAttached: (sessionId: string) => boolean
  /** Fold the confirmed orphan's usage into the watermark gate, then run the ruled gates (zero quota). */
  decide: (sessionId: string, at: number, contextTokens: number | undefined) => PolicyRecord[]
  /** Log every record and queue the nudge for revive decisions (the existing applyRecords path). */
  apply: (records: PolicyRecord[]) => void
  /** Sweep-scoped structured evidence line. */
  log: (record: LogRecord) => void
  /** Clock (the host supplies `Date.now`). */
  now: () => number
  /** Disposal cancellation: the sweep stops between sessions and lists quietly. */
  signal: AbortSignal
  /** Delay between list attempts (boot plumbing; tests shrink it). */
  retryMs?: number
}

/** List attempts before the sweep gives up with a loud line (boot readiness races). */
const LIST_ATTEMPTS = 6
/** Default delay between list attempts. */
const LIST_RETRY_MS = 1000

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function hasTurnBoundary(row: SweepRow): boolean {
  return row.projections?.values.turnBoundary !== undefined
}

function isRevive(record: PolicyRecord): boolean {
  return record.kind === 'decision' && record.action === 'revive'
}

/**
 * List rows once the host projection faces answer; a rejection (services still
 * coming up) or a listing that carries no `turnBoundary` anywhere (projection
 * units still registering) waits and retries within the attempt budget.
 * @param deps - bound sweep surface.
 * @returns the rows, or `undefined` when the sweep must stop (logged or aborted).
 */
async function listRowsWhenReady(deps: BootSweepDeps): Promise<readonly SweepRow[] | undefined> {
  let lastError: unknown
  for (let attempt = 0; attempt < LIST_ATTEMPTS; attempt++) {
    if (attempt > 0) await wait(deps.retryMs ?? LIST_RETRY_MS, deps.signal)
    if (deps.signal.aborted) return undefined
    try {
      const rows = await deps.listRows(deps.signal)
      // No row carries turnBoundary: either the projection units are still
      // registering mid-boot (retry) or this deployment has no projection
      // cache at all (the last attempt falls through to raw reads).
      if (rows.length > 0 && attempt + 1 < LIST_ATTEMPTS && !rows.some(hasTurnBoundary)) continue
      return rows
    } catch (error) {
      lastError = error
    }
  }
  deps.log({
    kind: 'log',
    at: deps.now(),
    event: 'boot-sweep-failed',
    detail: { stage: 'list', error: String(lastError).slice(0, 300) },
  })
  return undefined
}

/**
 * Run one boot sweep: list → screen → raw confirm → decided nudges.
 * Never throws: every failure lands as a `boot-sweep-failed` line, and an
 * unconfirmed session is never nudged (fail closed).
 * @param deps - bound host services (see {@link BootSweepDeps}).
 */
export async function runBootSweep(deps: BootSweepDeps): Promise<void> {
  try {
    const rows = await listRowsWhenReady(deps)
    if (rows === undefined) return
    const candidates: SweepRow[] = []
    let live = 0
    let closed = 0
    let unknown = 0
    for (const row of rows) {
      const cls = classifySweepRow(row)
      if (cls === 'live') live += 1
      else if (cls === 'closed') closed += 1
      else {
        candidates.push(row)
        if (cls === 'unknown') unknown += 1
      }
    }
    if (candidates.length > 0 && deps.readEvents === undefined) {
      deps.log({
        kind: 'log',
        at: deps.now(),
        event: 'boot-sweep-failed',
        detail: { stage: 'read', error: 'sessionPersistence unavailable — candidates cannot be confirmed' },
      })
      return
    }
    const readEvents = deps.readEvents
    let reads = 0
    let revived = 0
    let parked = 0
    let confirmedClosed = 0
    let attached = 0
    if (readEvents !== undefined) {
      for (const row of candidates) {
        if (deps.signal.aborted) break
        let scan: SweepScan
        try {
          scan = scanOpenTurn(await readEvents(row.sessionId, deps.signal))
          reads += 1
        } catch (error) {
          deps.log({
            kind: 'log',
            at: deps.now(),
            event: 'boot-sweep-failed',
            sessionId: row.sessionId,
            detail: { stage: 'read', error: String(error).slice(0, 300) },
          })
          continue
        }
        if (!scan.open) {
          confirmedClosed += 1
          continue
        }
        // The row may have been attached between list and read (a human
        // opening it resumes the turn away); never double-drive a live owner.
        if (deps.isAttached(row.sessionId)) {
          attached += 1
          continue
        }
        const records = deps.decide(row.sessionId, deps.now(), scan.contextTokens)
        deps.apply(records)
        if (records.some(isRevive)) revived += 1
        else parked += 1
      }
    }
    deps.log({
      kind: 'log',
      at: deps.now(),
      event: 'boot-sweep',
      detail: {
        rows: rows.length,
        live,
        closed,
        candidates: candidates.length,
        unknown,
        reads,
        revived,
        parked,
        confirmedClosed,
        attached,
      },
    })
  } catch (error) {
    try {
      deps.log({
        kind: 'log',
        at: deps.now(),
        event: 'boot-sweep-failed',
        detail: { stage: 'sweep', error: String(error).slice(0, 300) },
      })
    } catch {
      // A failing logger during shutdown must not become an unhandled rejection.
    }
  }
}
