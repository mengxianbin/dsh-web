/**
 * The resident auto-renew loop (L3 self-heal, taskRef #mimo-login-cta-l3-1029):
 * a timer that replays the silent renewal chain so the stored platform cookie
 * stays fresh while the 30-day `passToken` lives — zero interaction, no
 * browser, no UI.
 *
 * Cadence (first-version conservative, 2026-10-29 ruling): one attempt
 * `startupDelayMs` (60s) after apply — so a restart produces a first-run log —
 * then one attempt per `intervalMs`, clamped to a 24-hour floor inside the
 * scheduler as well as in Config (defense in depth). Timing is per-process:
 * a restart re-arms the loop (documented in the README's known limitations).
 *
 * Verdict handling:
 * - `ok` → info log with the rotated balance; the dsh-usage poll cycle picks
 *   the new cookie up on its own (no refresh poke — the loop has no request
 *   host, and the host re-probes every cycle anyway);
 * - `interactive` (passToken expired, ~once per 30 days) → warn log and the
 *   loop PAUSES: no further attempts are scheduled, per the ruling "不自动
 *   重试（留给 UI 入口）". `rearm()` — called by the routes after a
 *   successful manual renew / capture / account paste — restarts it, so a
 *   human fix restores self-healing without a process restart;
 * - `failed` / `no-url` / `store-error` / missing credentials → visible
 *   warn/error log, then the next attempt waits the full interval (no
 *   hammering, no silent breakage).
 *
 * Every log line carries the `[dsh-mimo-relogin]` prefix and rides stdout /
 * stderr into `dsh-web.log` (the start script redirects both).
 * @module dsh-mimo-relogin/host/auto-renew
 */
import type { Context } from '@deepseek-ai/cordis'
import { performRenew } from './renew-core.ts'

/** First attempt lands shortly after apply, so a restart shows a first-run log. */
const STARTUP_GRACE_MS = 60_000
/** The conservative cadence floor: never renew more than once per 24h. */
const MIN_INTERVAL_MS = 86_400_000

/** Log severity the loop reports with. */
export type AutoRenewLogLevel = 'info' | 'warn' | 'error'

/** Scheduler options resolved from Config at apply time. */
export interface AutoRenewOptions {
  /** Platform origin the chain walks and probes. */
  platformUrl: string
  /** Cadence between attempts; clamped to >= 24h inside the scheduler. */
  intervalMs: number
  /** Delay before the first attempt (test seam; default 60s). */
  startupDelayMs?: number
}

/** Injected seams so tests replay the loop without timers or a live platform. */
export interface AutoRenewDeps {
  /** Injectable fetch (the chain). */
  fetchImpl?: typeof fetch
  /** Log sink (default: console at the matching severity). */
  log?: (level: AutoRenewLogLevel, message: string) => void
  /**
   * Timer seam: schedules `fn` after `ms` and returns its canceller
   * (default: a node setTimeout with `.unref()`).
   */
  schedule?: (fn: () => void, ms: number) => () => void
}

/** Handle the plugin keeps: re-arm after a human fix, dispose on shutdown. */
export interface AutoRenewHandle {
  /** Re-arm a loop paused on `interactive` (after a successful manual store). */
  rearm(): void
  /** Cancel the pending attempt and refuse every further cycle. */
  dispose(): void
}

const defaultLog = (level: AutoRenewLogLevel, message: string): void => {
  if (level === 'info') console.log(message)
  else if (level === 'warn') console.warn(message)
  else console.error(message)
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms)
  handle.unref?.()
  return () => { clearTimeout(handle) }
}

/** Human units for the arming line (`60000ms` → `60s`, `86400000ms` → `24h`). */
function humanDelay(ms: number): string {
  if (ms % 3_600_000 === 0) return `${String(ms / 3_600_000)}h`
  if (ms % 60_000 === 0) return `${String(ms / 60_000)}s`
  if (ms % 1_000 === 0) return `${String(ms / 1_000)}s`
  return `${String(ms)}ms`
}

/**
 * Start the resident auto-renew loop.
 * @param ctx - host plugin context (credentials seam).
 * @param options - platform origin and cadence.
 * @param deps - injectable fetch / log / timer seams.
 * @returns the handle (rearm + dispose); the caller disposes it on shutdown.
 */
export function startAutoRenew(
  ctx: Context,
  options: AutoRenewOptions,
  deps: AutoRenewDeps = {},
): AutoRenewHandle {
  const fetchImpl = deps.fetchImpl ?? fetch
  const schedule = deps.schedule ?? defaultSchedule
  const intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs)
  const startupDelayMs = options.startupDelayMs ?? STARTUP_GRACE_MS
  const log = (level: AutoRenewLogLevel, message: string): void => {
    (deps.log ?? defaultLog)(level, `[dsh-mimo-relogin] auto-renew: ${message}`)
  }

  let disposed = false
  let latched = false
  let cancelPending: (() => void) | undefined

  const scheduleNext = (ms: number): void => {
    if (disposed || latched) return
    cancelPending = schedule(() => { void cycle() }, ms)
  }

  const cycle = async (): Promise<void> => {
    if (disposed || latched) return
    try {
      const result = await performRenew(ctx, options.platformUrl, fetchImpl)
      if (result.status === 'ok') {
        const balance = result.balance?.balance === undefined
          ? ''
          : ` — balance ${result.balance.balance}${result.balance.currency === undefined ? '' : ` ${result.balance.currency}`}`
        log('info', `ok: serviceToken rotated (${String(result.hops.length)} hops)${balance}`)
      } else if (result.status === 'chain' && result.verdict === 'interactive') {
        // passToken is gone: retrying the chain would hit the same form every
        // time. Pause and leave the fix to the UI entry (the re-login page).
        latched = true
        log('warn', 'PAUSED: passToken expired (verdict interactive) — open /api/mimo-relogin/page and log in once; auto-renew re-arms after the next successful renew / capture / paste')
        return
      } else if (result.status === 'chain') {
        log('error', `failed (${result.verdict})${result.note === undefined ? '' : `: ${result.note}`} — next attempt in ${humanDelay(intervalMs)}`)
      } else if (result.status === 'no-account') {
        log('warn', 'skipped: no account cookies stored — log in once through /api/mimo-relogin/page to arm the chain; next check in ' + humanDelay(intervalMs))
      } else if (result.status === 'no-credentials') {
        log('warn', 'skipped: credentials service unavailable; next check in ' + humanDelay(intervalMs))
      } else {
        log('error', `store failed: ${result.error} — next attempt in ${humanDelay(intervalMs)}`)
      }
    } catch (error) {
      log('error', `unexpected error: ${String(error)} — next attempt in ${humanDelay(intervalMs)}`)
    }
    scheduleNext(intervalMs)
  }

  log('info', `armed: first attempt in ${humanDelay(startupDelayMs)}, then every ${humanDelay(intervalMs)}`)
  scheduleNext(startupDelayMs)

  return {
    rearm(): void {
      if (disposed || !latched) return
      latched = false
      log('info', 're-armed after a successful manual credential store')
      scheduleNext(intervalMs)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      cancelPending?.()
      cancelPending = undefined
    },
  }
}
