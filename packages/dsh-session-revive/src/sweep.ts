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
 * Design §4.2 rule two (revive-restart-gap-1126) widens the SCREEN, not the
 * structure: a row whose checkpoint proves the last turn closed but whose
 * `lastTurnOutcome` projection reads `kind: 'error'` also enters the
 * candidate face — an error-closed session's event-driven detect never
 * replays after a restart, so without this the closed half of a revive
 * decision slept until a manual continue (the 2026-11-26 incident). The raw
 * confirm still owns the verdict: the tail's last `turn/end` must be an
 * `error` AND the failure must still classify as revivable (the policy's one
 * effective classification, bound as `reviveClass`) before `decide` may run.
 * A closed non-error turn (completed/aborted/blocked/interrupted), a missing
 * outcome projection or an unbound classifier stays `confirmedClosed` —
 * 宁漏不误复活. The expansion rides the existing zero-quota `decide` channel;
 * no parameter moves (参数零改).
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
  /** Summary-header projection: present on subagent children (design 件1 child index). */
  readonly origin?: 'subagent'
  /** Summary-header projection: direct parent of a subagent child. */
  readonly parentSessionId?: string
  readonly projections?: { readonly values: Readonly<Record<string, unknown>> }
}

/**
 * Structural view of the session controller's list face: rows arrive inside
 * the `SessionListValue` envelope the Host's `list` returns (`{ items }`),
 * never as a bare array. Declaring the envelope honestly is the point — a
 * view that promises a bare array compiles against the structural cast and
 * dies at runtime on `for...of` before a single row is read.
 */
export interface SweepListApi {
  list(
    request: { includeArchived: boolean; includeSubagents: boolean; trimHeavyProjections: boolean },
    signal?: AbortSignal,
  ): Promise<{ readonly items: readonly SweepRow[] }>
}

/**
 * Build the sweep's `listRows` dependency over the Host session controller.
 * The controller answers `SessionListValue` (`{ items }`) while the screen
 * consumes a bare row array, so the unwrap lives here — in the one place the
 * tests exercise — because passing the envelope through fails closed at the
 * first `for...of` (`rows is not iterable`, observed on the 2026-11-08 boot)
 * and the sweep screens nothing.
 *
 * `includeSubagents: true` (design revive-child-rescue-1124 件2 / gap 2):
 * the harness list defaults to filtering `origin=subagent` rows (registry
 * pre-exclusion + header predicate), so without the flag neither the boot
 * sweep nor the mount-time stall seeding — both bound to this one
 * `listRows` source — ever sees a child session. Children ride the same
 * confirm chain and the same four gates; no quota exemption is introduced.
 *
 * `onRow` (件1 child index): every listed row is noticed here — the one
 * choke point both consumers share — so the send dispatch can later route a
 * child nudge through the parent-authorized delivery seam.
 * @param controller - structural list face of the session controller.
 * @param onRow - optional per-row notice (header capture for child routing).
 * @returns the ruled row-scope listing (archived excluded, subagent rows
 *   restored, heavy projections trimmed) with the envelope unwrapped into rows.
 */
export function makeListRows(
  controller: SweepListApi,
  onRow?: (row: SweepRow) => void,
): (signal: AbortSignal) => Promise<readonly SweepRow[]> {
  return async (signal) => {
    const listed = await controller.list(
      { includeArchived: false, includeSubagents: true, trimHeavyProjections: true },
      signal,
    )
    if (onRow !== undefined) for (const row of listed.items) onRow(row)
    return listed.items
  }
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
 *   an orphan), `candidate` when the checkpoint says a turn is open OR its
 *   `lastTurnOutcome` projection reads `error` (design §4.2 rule two: an
 *   error-closed session re-enters the scan face; the raw confirm still owns
 *   the verdict), `closed` when the checkpoint proves a non-error turn ended
 *   or no outcome projection exists (宁漏: no signal, no sweep), `unknown`
 *   when no usable checkpoint exists (the raw read decides).
 */
export function classifySweepRow(row: SweepRow): SweepClass {
  if (row.running || row.agentAvailable) return 'live'
  const values = row.projections?.values
  const boundary = values?.turnBoundary as TurnBoundaryValue | undefined
  const open = boundary?.openTurnStartSeq
  if (typeof open === 'number') return 'candidate'
  if (open === null) {
    // Rule two screen: only an `error` outcome re-opens a closed row; every
    // other closer (completed/aborted/blocked/interrupted/max-tokens) and a
    // missing projection keep it closed.
    const outcome = values?.lastTurnOutcome as { kind?: string } | null | undefined
    if (outcome?.kind === 'error') return 'candidate'
    return 'closed'
  }
  return 'unknown'
}

/** Result of balancing one raw stored log. */
export interface SweepScan {
  /** Whether the log's tail sits inside a turn (`turn/start` with no later `turn/end`). */
  open: boolean
  /** Latest folded usage (inputTokens + cacheReadTokens — the live folding's context definition), when observed. */
  contextTokens?: number
  /**
   * The route the next request would use, when the log records one: the latest
   * `model/selection` not yet retired by a request header, else the last
   * `request/header`'s config (the same fold as the harness's modelSelection
   * projection). Boot decisions seed this into the machine — an idle session
   * never emits `model/selection` live, so the stored log is the only route
   * evidence a restart leaves behind.
   */
  route?: { readonly provider: string; readonly model?: string }
  /**
   * The tail's failure identity when the log's LAST `turn/end` was an
   * `error` (design §4.2 rule two): the closed-error confirm reads the raw
   * code/message off it and asks the policy's classification. Absent for any
   * other closer (completed/aborted/blocked/interrupted/max-tokens/forked)
   * or when no turn ever ended — a non-error tail never re-enters the decide
   * face, whatever the checkpoint screen projected.
   */
  lastError?: { readonly code: string; readonly message: string }
}

/**
 * Balance a raw (unbalanced) stored event list and report its tail state.
 * @param events - events in seq order exactly as `SessionPersistence` returns
 *   them (no synthetic closers — that is what distinguishes an orphan from a
 *   session already resumed after an interruption).
 * @returns whether the log ends inside a turn, the last observed context
 *   size for the 1M watermark gate, the route the log proves (see
 *   {@link SweepScan.route}), and the tail's error identity when the last
 *   `turn/end` was an `error` (see {@link SweepScan.lastError}).
 */
export function scanOpenTurn(events: readonly SessionEvent[]): SweepScan {
  let open = false
  let contextTokens: number | undefined
  let pending: { provider: string; model?: string } | undefined
  let lastUsed: { provider: string; model?: string } | undefined
  let lastError: { code: string; message: string } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') {
      open = false
      // Structural read (the wire type promises a reason; fixtures may omit
      // it): only an explicit error closer stamps the tail identity rule
      // two's closed-error confirm reads — any other closer clears it, so
      // the LAST turn/end always wins.
      const reason = (event.data as { reason?: { kind?: string; error?: { code: string; message: string } } }).reason
      lastError =
        reason?.kind === 'error' && reason.error !== undefined
          ? { code: reason.error.code, message: reason.error.message }
          : undefined
    } else if (event.type === 'assistant/message') {
      const usage = event.data.usage
      if (usage !== undefined) contextTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0)
    } else if (event.type === 'model/selection') {
      pending = { provider: event.data.provider, model: event.data.model }
    } else if (event.type === 'request/header') {
      const config = event.data.header.config
      lastUsed = { provider: config.provider, model: config.model }
      if (
        pending !== undefined &&
        pending.provider === lastUsed.provider &&
        pending.model === lastUsed.model
      ) {
        pending = undefined
      }
    }
  }
  const route = pending ?? lastUsed
  return {
    open,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(route === undefined ? {} : { route }),
    ...(lastError === undefined ? {} : { lastError }),
  }
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
  /**
   * Seed the machine's per-session route from the stored log before deciding.
   * Optional so older bindings keep compiling; without it a boot decision
   * gates `route-unknown` and parks fail-closed until a `model/selection`
   * that an idle session never emits (the 2026-11-18 boot deadlock).
   */
  seedRoute?: (sessionId: string, route: { readonly provider: string; readonly model?: string }) => void
  /**
   * Whether a closed tail's failure would enter the revival flow (design
   * §4.2 rule two): the policy's ONE effective classification — the raw
   * `refineFailureCode` first, then the ruled/config lists with the
   * learner's admission/eviction — so the sweep's screen-confirm and the
   * live error path can never classify a code differently. Optional so
   * older bindings keep compiling; WITHOUT it a closed-error candidate
   * fails closed (confirmed-closed, never decided).
   */
  reviveClass?: (code: string, message: string) => boolean
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
          // Design §4.2 rule two: a closed tail re-enters the decide face
          // only when its last `turn/end` was an `error` the policy still
          // classifies as revivable (raw log beats the projection screen);
          // any other closer — and any wall/other-class or evicted code, or
          // an unbound classifier — stays confirmed-closed (宁漏不误复活).
          const tail = scan.lastError
          const revivable =
            tail !== undefined && deps.reviveClass !== undefined && deps.reviveClass(tail.code, tail.message)
          if (!revivable) {
            confirmedClosed += 1
            continue
          }
        }
        // The row may have been attached between list and read (a human
        // opening it resumes the turn away); never double-drive a live owner.
        if (deps.isAttached(row.sessionId)) {
          attached += 1
          continue
        }
        // Route evidence lands before the decision: the v2 gate reads the
        // machine's per-session route, and a boot decision with none parks
        // fail-closed (route-unknown) until a model/selection that an idle
        // session never emits.
        if (scan.route !== undefined) deps.seedRoute?.(row.sessionId, scan.route)
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
