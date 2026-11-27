/**
 * The turn-end seal sync (seal-light-host-state-1109 裁点1A 插件算、host 持):
 * subscribes `session/event`, and on each `turn/end` computes the session's
 * six-value grouping OFF the event loop, records it as a plugin record, and
 * lets the `seal` projection fold carry the value to the Host.
 *
 * The two implementation guardrails from the ruling travel with the code:
 * - **Compute only at turn/end, never in sweep/list paths** (护栏 ①): the
 *   registry drive is a pure fold of recorded facts; this module is the sole
 *   place `analyzeSeal` runs, and a computed payload identical to the folded
 *   one is not recorded again (稳态 O(1) 搬值; the cache单's memo inside
 *   `analyzeSeal` shaves repeat cost further once merged).
 * - **The compute itself is asynchronous** (护栏 ②): the default path runs
 *   `analyzeSeal` in a `worker_threads` script ({@link computeSealInWorker}),
 *   so the synchronous decompress never blocks the Host's event loop; specs
 *   inject a deterministic seam through {@link SealStateOptions.compute}.
 *
 * Lifecycle rides the archive service (mounted ⇔ registered): the projection
 * key exists exactly while the surface is up — key absent (plugin not
 * mounted) is the Host-side "no verdict" the client renders fail-visible.
 * The registry API is consumed in its disposer form (`register(...) → dispose`)
 * with typed `stateOf(session, 'seal')` reads — the shape both the installed
 * package and the Host's module table answer.
 * @module @linxin666/dsh-session-archive/host/seal-state
 */

import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SEAL_RECORD, sessionSealProjection, type SessionSealProjectionState } from './seal-projection.ts'
import type { SealCheckResult, SealVerdictPayload } from '../core/types.ts'

/** Worker budget: longer than any observed seal-check (max 13.1s), short enough to fail visible. */
const SEAL_COMPUTE_TIMEOUT_MS = 30_000

/** Candidates for the worker script, first existing wins: source tree (vitest) vs built lib layouts. */
const WORKER_CANDIDATES = [
  './seal-compute-worker.ts',
  './seal-compute-worker.js',
  './host/seal-compute-worker.js',
  './host/seal-compute-worker.ts',
] as const

/**
 * A rejected worker compute — an INFRA failure (script missing, budget
 * exceeded, worker crash) that never produced a verdict. It carries the
 * machine `detail` the record should show, so an infra outage is never
 * mislabelled `decode-fail` (a transcript the analysis could not read).
 * @example
 * throw new SealComputeError('seal-state: worker script not found …', 'worker-missing')
 */
export class SealComputeError extends Error {
  /** Machine detail the record carries: `worker-missing` / `worker-timeout` / `worker-error`. */
  readonly detail: string
  constructor(message: string, detail: string) {
    super(message)
    this.name = 'SealComputeError'
    this.detail = detail
  }
}

/**
 * Run one seal analysis on a worker thread (实施护栏 ②).
 * @param id - the session the verdict is for.
 * @param dir - its workspace directory from the sessions-root index.
 * @param options - click-time options carried over the wire (the async
 *   seal-check channel's `recheck` must re-probe git in the worker too —
 *   the worker's own memo is cold, but the flag still names the intent).
 * @returns the six-value grouping; rejects with a {@link SealComputeError}
 *   naming the infra cause — the caller degrades the rejection to an
 *   `UNKNOWN` record carrying that detail (fail-visible, never mislabelled
 *   `decode-fail`).
 */
export function computeSealInWorker(
  id: string,
  dir: string | undefined,
  options?: { readonly recheck?: boolean },
): Promise<SealCheckResult> {
  const base = new URL('.', import.meta.url)
  const entry = WORKER_CANDIDATES.map((candidate) => new URL(candidate, base))
    .find((url) => existsSync(fileURLToPath(url)))
  if (entry === undefined) {
    return Promise.reject(new SealComputeError('seal-state: worker script not found next to the plugin module', 'worker-missing'))
  }
  const worker = new Worker(entry)
  return new Promise<SealCheckResult>((resolve, reject) => {
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
    }
    const timer = setTimeout(() => {
      settle(() => reject(new SealComputeError('seal-state: worker compute timed out', 'worker-timeout')))
    }, SEAL_COMPUTE_TIMEOUT_MS)
    worker.once('message', (message: unknown) => {
      const result = (message as { result?: unknown } | null)?.result as SealCheckResult | undefined
      if (result === undefined || typeof result.verdict !== 'string') {
        settle(() => reject(new SealComputeError('seal-state: worker answered no result', 'worker-error')))
        return
      }
      settle(() => resolve(result))
    })
    worker.once('error', (error) => {
      settle(() => reject(error))
    })
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker postMessage has no window targetOrigin.
    worker.postMessage({ id, dir, recheck: options?.recheck === true })
  }).finally(() => {
    void worker.terminate()
  })
}

/** Collaborators of one sync instance. */
export interface SealStateOptions {
  /**
   * The sessions-root directory for an id, from the archive service's dir
   * index. May answer asynchronously: the merged install lineage serves the
   * index through an async TTL memo (`DirIndexCache.get(): Promise<...>`).
   */
  readonly resolveDir: (sessionId: string) => string | undefined | Promise<string | undefined>
  /**
   * The compute seam: defaults to the off-loop worker. Specs inject a
   * synchronous fake to drive the scheduling deterministically.
   */
  readonly compute?: (id: string, dir: string | undefined) => SealCheckResult | Promise<SealCheckResult>
}

/** The lifecycle handle the archive service owns. */
export interface SealStateSync {
  /** Register the projection and arm the turn/end subscription (soft-inject: no registry, no key). */
  start(): void
  /** Release everything; pending computes settle into the stopped guard. */
  stop(): void
}

/** Payload equality for the skip-if-unchanged guard (field order fixed at construction). */
function samePayload(left: SessionSealProjectionState, right: SealVerdictPayload): boolean {
  if (left === null) return false
  return left.verdict === right.verdict
    && left.detail === right.detail
    && left.followUpCount === right.followUpCount
}

/**
 * The bounded delayed re-check schedule (seal-write-crosscopy-1127, same
 * shape as sessionclass-retry-1126): one attempt at 10s, a second at 60s,
 * then a loud give-up — the caps that keep a permanently rejecting Session
 * from spinning, while the old "the next turn end retries" comment promised
 * a retry that never existed.
 */
const RETRY_DELAYS_MS = [10_000, 60_000] as const

/** One Session's pending seal-record re-write: the payload that failed, attempts spent, the armed timer. */
interface RetryEntry {
  session: Session
  payload: SealVerdictPayload
  attempts: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The Host's public `append` behind one structural cast (the cross-copy
 * seam, mirroring `appendClassViaHost` in class-projection): the installed
 * rc.3 type view keys `append` on `SessionEventMap` with no `LogIntent` opts
 * slot for a plugin record (keyed by `PluginRecordMap`), while the Host
 * runtime accepts `{ ignorable: true }` and stamps the marker the fold reads
 * back. The method dispatches on the instance's own prototype — the seam
 * `appendPluginRecord`'s brand-checking closure is not: a dual-copy install
 * rejects every Host instance with `TypeError: Receiver must be an instance
 * of class Session` (seal-write-crosscopy-1127 根因).
 */
interface CrossCopyAppendable {
  append(
    type: string,
    data: unknown,
    opts?: { readonly ignorable: true },
  ): { readonly ignorable?: true } | undefined
}

/**
 * Append one seal record through the Host's own `append` (the cross-copy
 * write): dispatch lands on the instance's prototype, so the Host class's
 * private brand always matches regardless of which `@deepseek-ai/dsh-session`
 * copy THIS package resolved.
 * @param session - the live Host Session to append onto.
 * @param payload - the computed verdict payload.
 * @returns the committed envelope; throws when the Host did not stamp
 *   `ignorable` — a pre-LogIntent copy would land a record the fold can
 *   never read, and this unit refuses to swallow that silently.
 */
function appendSealViaHost(session: Session, payload: SealVerdictPayload): { readonly ignorable?: true } | undefined {
  const event = (session as unknown as CrossCopyAppendable).append(SEAL_RECORD, payload, { ignorable: true })
  if (event?.ignorable !== true) {
    throw new Error('host append did not stamp the ignorable marker (pre-LogIntent host copy?)')
  }
  return event
}

/** One error's message for a warn line (mirrors the route layer's truncation). */
function errorDetail(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.slice(0, 300)
}

/** A retry timer must never hold a process open (host shutdown, test runners). */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const unref = (timer as { unref?: () => void }).unref
  if (typeof unref === 'function') unref.call(timer)
}

/**
 * Create the sync instance for one archive-surface mount.
 * @param ctx - the plugin context (events + soft service inject).
 * @param options - the dir resolver and optional compute seam.
 * @returns the lifecycle handle; call `start` after construction, `stop` on unmount.
 */
export function createSealStateSync(ctx: Context, options: SealStateOptions): SealStateSync {
  const compute = options.compute
    ?? ((id: string, dir: string | undefined): Promise<SealCheckResult> => computeSealInWorker(id, dir))
  /** The injection fiber: disposing it runs the inject callback's cleanup. */
  let disposeInjection: { dispose(): unknown } | undefined
  /** The `session/event` subscription, armed while registered. */
  let disposeEvent: (() => void) | undefined
  /** The registry's registration disposer; invoked by the shared teardown. */
  let disposeProjection: (() => void) | undefined
  /** The live registry while injected; `stateOf` reads the folded verdict through it. */
  let registry: { stateOf(session: Session, key: 'seal'): SessionSealProjectionState | undefined } | undefined
  /** Sessions waiting for (or re-waiting for) a compute; Set identity dedupes concurrent turn ends. */
  const pending = new Set<Session>()
  /** Pending bounded re-checks keyed by session id (seal-write-crosscopy-1127). */
  const retries = new Map<string, RetryEntry>()
  let pumping = false
  let stopped = false

  /** Retire one Session's pending re-check — its record now stands. */
  const dropRetry = (id: string, entry: RetryEntry): void => {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (retries.get(id) === entry) retries.delete(id)
  }

  /**
   * Arm the bounded delayed re-check for one Session's failed record write:
   * two attempts, 10s then 60s, then a loud give-up (seal-write-crosscopy-1127,
   * same schedule as sessionclass-retry-1126). A newer failed payload for the
   * same Session replaces the pending one.
   * @param id - session id the entry is keyed by.
   * @param session - the live Session whose append rejected.
   * @param payload - the verdict record that failed to land.
   * @returns a phrase for the caller's warn line — what happens next.
   */
  const scheduleRetry = (id: string, session: Session, payload: SealVerdictPayload): string => {
    if (stopped) return 're-check skipped (sync stopped)'
    const entry = retries.get(id) ?? { session, payload, attempts: 0, timer: undefined }
    entry.session = session
    entry.payload = payload
    retries.set(id, entry)
    if (entry.timer !== undefined) return `re-check already armed (attempt ${entry.attempts}/${RETRY_DELAYS_MS.length})`
    if (entry.attempts >= RETRY_DELAYS_MS.length) {
      retries.delete(id)
      return `re-check budget spent after ${entry.attempts} attempts — the record waits for the next restart's boot path`
    }
    const delay = RETRY_DELAYS_MS[entry.attempts]
    entry.attempts += 1
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      runRetry(id)
    }, delay)
    unrefTimer(entry.timer)
    return `re-check armed (attempt ${entry.attempts}/${RETRY_DELAYS_MS.length} in ${delay}ms)`
  }

  /**
   * One delayed re-write: re-check the fold (a later turn end may have
   * landed the record already), then append through the Host again. Success
   * retires the entry; failure warns with the attempt count and arms the
   * next slot, or gives up loudly once the two-attempt budget is spent.
   * @param id - session id the entry is keyed by.
   */
  function runRetry(id: string): void {
    const entry = retries.get(id)
    if (entry === undefined || stopped) return
    entry.timer = undefined
    const attempt = entry.attempts
    try {
      let current: SessionSealProjectionState = null
      try {
        current = registry?.stateOf(entry.session, 'seal') ?? null
      } catch {
        // Unreadable fold: attempt the append anyway — fail visible, not silent.
      }
      if (!samePayload(current, entry.payload)) appendSealViaHost(entry.session, entry.payload)
    } catch (error) {
      if (stopped || retries.get(id) !== entry) return
      const outcome = scheduleRetry(id, entry.session, entry.payload)
      console.warn(`[seal] record re-check failed session=${id} verdict=${entry.payload.verdict} attempt=${attempt}/${RETRY_DELAYS_MS.length} reason=${errorDetail(error)} — ${outcome}`)
      return
    }
    if (stopped || retries.get(id) !== entry) return
    dropRetry(id, entry)
  }

  const computeOne = async (session: Session): Promise<void> => {
    const id = String(session.id)
    let dir: string | undefined
    try {
      dir = await options.resolveDir(id)
    } catch {
      // A failed index scan degrades exactly like an unknown id: compute
      // with no dir, which the worker answers as UNKNOWN (fail-visible).
      dir = undefined
    }
    let result: SealCheckResult
    try {
      result = await compute(id, dir)
    } catch (error) {
      // A rejected compute is an INFRA failure (worker missing / timed out /
      // crashed) — never a transcript the analysis could not read. Name the
      // cause so the record stays trustworthy; `decode-fail` is reserved for
      // a decode the worker itself returned. UNKNOWN still stamps the row
      // (fail-visible, fail-closed gate) — the ruling's failure semantics.
      const detail = error instanceof SealComputeError ? error.detail : 'worker-error'
      result = { id, verdict: 'UNKNOWN', detail }
    }
    if (stopped) return
    // The session may have been disposed or replaced while the worker ran.
    // Probe via ctx.get (reflect store, no inject gate): the plugin's inject
    // list never declared 'sessions', and a direct `ctx.sessions` throws
    // "without inject" — fatal to the host (2026-11-11). No store ⇒ record
    // anyway; the write's own rejection handling below is the backstop.
    try {
      const store = (ctx as unknown as { get(name: string): unknown }).get('sessions') as { get?(id: string): unknown } | undefined
      if (typeof store?.get === 'function' && store.get(session.id) !== session) return
    } catch {
      // Unreadable store: fail open — same shape as the stateOf read below.
    }
    const payload: SealVerdictPayload = {
      verdict: result.verdict,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      ...(result.followUpCount === undefined ? {} : { followUpCount: result.followUpCount }),
    }
    let current: SessionSealProjectionState = null
    try {
      current = registry?.stateOf(session, 'seal') ?? null
    } catch {
      // A session the fold cannot materialize yet records anyway; the fold
      // re-reads the log when the Host next prepares it.
    }
    if (samePayload(current, payload)) return
    try {
      // Cross-copy write (seal-write-crosscopy-1127): the Host's own public
      // `append`, never the brand-checking `appendPluginRecord` helper —
      // a dual-copy install made the helper throw on every Host instance.
      appendSealViaHost(session, payload)
      // A landed record supersedes any re-check still armed for this Session.
      const armed = retries.get(id)
      if (armed !== undefined) dropRetry(id, armed)
    } catch (error) {
      // Never silent: name the Session, the verdict and the cause, then arm
      // the bounded re-check — the old empty catch promised "the next turn
      // end retries" while the histogram showed the writes just stopped.
      const outcome = scheduleRetry(id, session, payload)
      console.warn(`[seal] record write failed session=${id} verdict=${payload.verdict} reason=${errorDetail(error)} — ${outcome}`)
    }
  }

  const pump = (): void => {
    if (pumping) return
    pumping = true
    void (async () => {
      try {
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `stopped` flips from stop() on another turn of the loop (each await yields).
        while (pending.size > 0 && !stopped) {
          const session = pending.values().next().value as Session
          pending.delete(session)
          // oxlint-disable-next-line eslint/no-await-in-loop -- the single-flight await IS the design: one seal compute at a time (护栏 ①), never parallel decompresses.
          await computeOne(session)
        }
      } finally {
        pumping = false
      }
    })()
  }

  const onSessionEvent = (session: Session, event: SessionEvent): void => {
    if (event.type !== 'turn/end') return
    pending.add(session)
    pump()
  }

  /** Disarm listener + registration + registry reference; idempotent, so stop and inject-cleanup share it. */
  const teardown = (): void => {
    disposeEvent?.()
    disposeEvent = undefined
    registry = undefined
    const dispose = disposeProjection
    disposeProjection = undefined
    if (dispose !== undefined) {
      try {
        dispose()
      } catch {
        // Its fiber may already be gone during shutdown.
      }
    }
  }

  return {
    start(): void {
      stopped = false
      try {
        disposeInjection = ctx.inject(['sessionProjections'], (projectionCtx) => {
          try {
            // Disposer form: the installed package types register this way, and
            // the Host's module table answers the same call (legacy-compatible).
            disposeProjection = projectionCtx.sessionProjections.register(sessionSealProjection)
          } catch {
            // Duplicate key from a stale mount: that fold already carries the
            // value, or the key stays absent and the client paints unknown.
            return
          }
          registry = projectionCtx.sessionProjections
          // The subscription arms only once the fold is live: no registry, no
          // key, no compute — a host without the projection never pays for a
          // verdict nobody can carry.
          disposeEvent = ctx.on('session/event', onSessionEvent)
          return () => { teardown() }
        })
      } catch {
        // A service-level fixture context serves no cordis surface (no
        // `inject`): the archive service still runs, and the key simply never
        // mounts — the same "plugin absent" shape the client fails visible on.
        disposeInjection = undefined
      }
    },
    stop(): void {
      stopped = true
      pending.clear()
      // Bounded re-checks die with the mount: no timer fires after teardown.
      for (const entry of retries.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
      }
      retries.clear()
      // Synchronous disarm first — a service stop must release the key and
      // the listener now, not when the injection fiber's async dispose lands.
      teardown()
      if (disposeInjection !== undefined) {
        void disposeInjection.dispose()
        disposeInjection = undefined
      }
    },
  }
}
