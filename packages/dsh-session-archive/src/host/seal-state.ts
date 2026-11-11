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
import { appendPluginRecord, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
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
 * Run one seal analysis on a worker thread (实施护栏 ②).
 * @param id - the session the verdict is for.
 * @param dir - its workspace directory from the sessions-root index.
 * @returns the six-value grouping; rejects on worker failure or timeout —
 *   the caller degrades the rejection to an `UNKNOWN` record (fail-visible).
 */
export function computeSealInWorker(id: string, dir: string | undefined): Promise<SealCheckResult> {
  const base = new URL('.', import.meta.url)
  const entry = WORKER_CANDIDATES.map((candidate) => new URL(candidate, base))
    .find((url) => existsSync(fileURLToPath(url)))
  if (entry === undefined) {
    return Promise.reject(new Error('seal-state: worker script not found next to the plugin module'))
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
      settle(() => reject(new Error('seal-state: worker compute timed out')))
    }, SEAL_COMPUTE_TIMEOUT_MS)
    worker.once('message', (message: unknown) => {
      const result = (message as { result?: unknown } | null)?.result as SealCheckResult | undefined
      if (result === undefined || typeof result.verdict !== 'string') {
        settle(() => reject(new Error('seal-state: worker answered no result')))
        return
      }
      settle(() => resolve(result))
    })
    worker.once('error', (error) => {
      settle(() => reject(error))
    })
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker postMessage has no window targetOrigin.
    worker.postMessage({ id, dir })
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
  let pumping = false
  let stopped = false

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
    } catch {
      // Worker failure or timeout: the same UNKNOWN the endpoint would serve
      // for an unreadable transcript — visible on the lamp, never silent.
      result = { id, verdict: 'UNKNOWN', detail: 'decode-fail' }
    }
    if (stopped) return
    // The session may have been disposed or replaced while the worker ran.
    if (ctx.sessions.get(session.id) !== session) return
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
      appendPluginRecord(session, SEAL_RECORD, payload)
    } catch {
      // Store-owned append preconditions (unentered row, in-flight publication)
      // reject without changing the log; the next turn end retries.
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
