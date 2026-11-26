/**
 * The `sessionClass` session projection (sessionclass-summary-channel-1127):
 * the attention ledger's triclass folded from `plugin:session-dispatch/attention`
 * records so the value rides the list's own channel — `SessionSummary
 * .projectionValues` — exactly like every other session fact.
 *
 * Before this unit the hover card's session-type line pulled
 * `GET /api/session-dispatch/attention` lazily on first hover, so the line
 * appeared late (or never, after one failed request) while the session id
 * beside it, carried by the summary, was there at once. The endpoint stays
 * as the diagnostic read face; the line now reads the list snapshot.
 *
 * Two writers feed the fold, both mirroring the ledger file as the single
 * source of truth: {@link ClassProjection.syncById} appends onto a live
 * Session whenever a ledger write lands (the ledger's `onClassSettled`
 * seam), and {@link ClassProjection.backfill} runs once per boot over every
 * recorded Session — a fast zero-I/O skip when the checkpoint already
 * carries the class, otherwise one write-open append (only when the record
 * is missing) plus a cold refold that refreshes the checkpoint. The
 * checkpoint refresh is mandatory: a new projection key never cues the
 * controller's cold repair (`staleCheckpointKeys` skips absent rows), so a
 * log-only backfill would leave every pre-existing Session blank forever.
 *
 * The live writer deliberately calls the Session's own public `append`
 * instead of the `appendPluginRecord` helper (sessionclass-retry-1126): the
 * helper's commit closure brand-checks against whichever copy of
 * `@deepseek-ai/dsh-session` THIS package resolved, and a dual-copy install
 * (plugin symlinked into a profile whose host runs another copy) rejects
 * every Host instance with `TypeError: Receiver must be an instance of class
 * Session` — the silent loss this unit's warns now surface. A write that
 * still fails, or a class that settles while its Session is not yet in the
 * store, arms a bounded delayed re-check (two attempts, 10s then 60s, then a
 * loud give-up) instead of waiting for the next restart.
 * @module dsh-session-dispatch/host/class-projection
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  pluginRecordOf,
  SessionSeq,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { canonicalSessionId } from './bindings.ts'
import type { SessionClass } from './routes.ts'

/** The record type this fold reads; mirrors the attention ledger's classes. */
export const CLASS_RECORD = 'plugin:session-dispatch/attention'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Latest attention classification; appended by the dispatch plugin, folded by the `sessionClass` projection. */
    'plugin:session-dispatch/attention': { readonly class: SessionClass }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The attention class folded from `plugin:session-dispatch/attention`
     * records: `null` until a ledger write lands one. Registered by this
     * plugin; the key rides Session summaries (`wire.summary` default true)
     * so `session/list` serves it on the same channel as the session id.
     * Structurally the triclass the attention ledger persists — keep the two
     * spellings equal.
     */
    sessionClass: SessionClass | null
  }
  interface SessionProjectionStateMap {
    /** Host fold state for `sessionClass`: the latest class, or `null` before the first record. */
    sessionClass: SessionClass | null
  }
}

/** The triclass spellings; anything else never enters the fold. */
const triclassSchema = z.enum(['human', 'bot-boss', 'bot-worker'])

/** One record payload; malformed or foreign records never enter the state. */
const recordSchema = z.object({ class: triclassSchema }).strict()

/** Fold state = the latest class, or `null` before the first record. */
const stateSchema = triclassSchema.nullable()

/**
 * The bounded delayed re-check schedule (sessionclass-retry-1126): one
 * attempt at 10s, a second at 60s, then a loud give-up — the caps the task
 * book requires so a permanently failing Session can never spin.
 */
const RETRY_DELAYS_MS = [10_000, 60_000] as const

/** One Session's pending re-check: the class to (re)apply, attempts spent, the armed timer. */
interface RetryEntry {
  sessionClass: SessionClass
  attempts: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The Host's public `append` behind one structural cast: the installed rc.3
 * type view keys `append` on `SessionEventMap` with no `LogIntent` opts slot
 * for a plugin record (keyed by `PluginRecordMap`), while the Host runtime
 * accepts `{ ignorable: true }` and stamps the marker the fold reads back.
 * The method dispatches on the instance's own prototype — the cross-copy
 * seam that `appendPluginRecord`'s brand-checking closure is not.
 */
interface CrossCopyAppendable {
  append(
    type: string,
    data: unknown,
    opts?: { readonly ignorable: true },
  ): { readonly ignorable?: true } | undefined
}

/**
 * Append one class record through the Host's own `append` (the cross-copy
 * write): dispatch lands on the instance's prototype, so the Host class's
 * private brand always matches regardless of which `@deepseek-ai/dsh-session`
 * copy THIS package resolved.
 * @param session - the live Host Session to append onto.
 * @param sessionClass - the triclass to record.
 * @returns the committed envelope; throws when the Host did not stamp
 *   `ignorable` — a pre-LogIntent copy would land a record the fold can
 *   never read, and this unit refuses to swallow that silently.
 */
function appendClassViaHost(session: Session, sessionClass: SessionClass): { readonly ignorable?: true } | undefined {
  const event = (session as unknown as CrossCopyAppendable).append(CLASS_RECORD, { class: sessionClass }, { ignorable: true })
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
 * The definition type with `wire` required: `register`'s client-visible
 * overload takes `Omit<..., 'wire'> & { wire: NonNullable<...> }`, and a
 * plain `ProjectionDefinition` annotates `wire` as optional — the same
 * derivation the archive plugin uses for its `seal` unit.
 */
export type SessionClassProjectionDefinition =
  Omit<ProjectionDefinition<'sessionClass', SessionClass | null>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'sessionClass', SessionClass | null>['wire']> }

/**
 * The projection definition: `null` init, record-driven apply, identity view.
 * The view returns the state unchanged so an unrelated event costs zero
 * downstream publication (Object.is suppression).
 */
export const sessionClassProjection: SessionClassProjectionDefinition = {
  key: 'sessionClass',
  stateVersion: 1,
  stateSchema,
  init: () => null,
  apply: (state, event) => {
    const record = pluginRecordOf(event)
    if (record?.type !== CLASS_RECORD) return state
    // A malformed or newer record is skipped; throwing here would fail every
    // later read of this Session (same stance as the seal fold).
    const parsed = recordSchema.safeParse(record.data)
    return parsed.success ? parsed.data.class : state
  },
  wire: { viewSchema: stateSchema, view: (state) => state },
}

/** The stored-session face the backfill consumes (structural, like DispatchSessionApi). */
interface PersistenceHandleFace {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  read(): Promise<{ readonly events: readonly SessionEvent[] }>
  append(events: readonly SessionEvent[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

/** One stored session's detached metadata (only `header` is read). */
interface PersistenceFace {
  stat(id: string): Promise<{ readonly header: SessionHeader } | undefined>
  open(id: string, access: 'read' | 'write'): Promise<PersistenceHandleFace>
}

/** The persisted projection-cache face the backfill consumes. */
interface ProjectionCacheFace {
  cachedSnapshot(header: SessionHeader, keys?: readonly string[]): { readonly values: Partial<Record<string, unknown>> } | undefined
  coldSnapshot(header: SessionHeader, inheritedEventCount: SessionLogOffset, events: readonly SessionEvent[]): unknown
}

/** The session store face used to tell a live Session from a cold one. */
interface SessionStoreFace {
  get?(id: string): Session | undefined
}

/** Narrow one folded/wire value to the triclass; anything else reads as absent. */
function toClass(value: unknown): SessionClass | undefined {
  return value === 'human' || value === 'bot-boss' || value === 'bot-worker' ? value : undefined
}

/** Read one record's class from a folded payload; malformed payloads read as absent. */
function recordClass(data: unknown): SessionClass | undefined {
  const parsed = recordSchema.safeParse(data)
  return parsed.success ? parsed.data.class : undefined
}

/** Build the durable envelope for one classification (mirrors `Session#appendRecord`). */
function classRecord(sessionClass: SessionClass, seq: number): SessionEvent {
  // The envelope mirrors the writer's own committed shape; a plugin record's
  // type is keyed by PluginRecordMap, not SessionEventMap, so it crosses the
  // event type through the same unknown-assertion the writer uses.
  return {
    type: CLASS_RECORD,
    seq: SessionSeq(seq),
    time: Date.now(),
    data: { class: sessionClass },
    ignorable: true,
  } as unknown as SessionEvent
}

/**
 * Cold path for one recorded Session: stat → checkpoint fast-path skip →
 * write-open append (only when the record is missing) → cold refold that
 * refreshes the checkpoint. Pure with respect to the plugin context, so it
 * stays at module scope.
 * @param persistence - the persistence service face to stat/open through.
 * @param cache - the projection cache face serving the fast path and refold.
 * @param id - the stored Session id (canonical ledger spelling).
 * @param sessionClass - the class the ledger holds for this Session.
 * @returns resolution after the handle is closed (per-session, fail-open).
 */
async function backfillCold(persistence: PersistenceFace, cache: ProjectionCacheFace, id: string, sessionClass: SessionClass): Promise<void> {
  const snapshot = await persistence.stat(id)
  // Never materialized / already gone (janitor): nothing to fold.
  if (snapshot === undefined) return
  const header = snapshot.header
  // Zero-I/O fast path: a checkpoint that already carries this class.
  const served = cache.cachedSnapshot(header, ['sessionClass'])
  if (served !== undefined && toClass(served.values.sessionClass) === sessionClass) return
  const handle = await persistence.open(id, 'write')
  try {
    const { events } = await handle.read()
    let complete: readonly SessionEvent[] = events
    const hasRecord = events.some((event) => {
      const record = pluginRecordOf(event)
      return record?.type === CLASS_RECORD && recordClass(record.data) === sessionClass
    })
    if (!hasRecord) {
      const tail = events.length > 0 ? events[events.length - 1].seq + 1 : 0
      const envelope = classRecord(sessionClass, tail)
      await handle.append([envelope])
      // Durability before the checkpoint: the cache may lag the log, never lead it.
      await handle.flush()
      complete = [...events, envelope]
    }
    // Refresh the checkpoint — absent keys never cue the controller's cold
    // repair, so this write-back is what makes the value listable at all.
    cache.coldSnapshot(header, handle.inheritedEventCount, complete)
  } finally {
    await handle.close()
  }
}

/** One boot's ledger → log backfill face. */
export interface ClassProjection {
  /** Arm the registration fiber; resolves once the fold is mounted (or the mount failed). */
  mount(): Promise<void>
  /**
   * Append the class onto a live Session whose folded state disagrees.
   * A rejection warns with the session id, class and reason, then arms the
   * bounded delayed re-check (10s, 60s, then a loud give-up).
   */
  syncLive(session: Session, sessionClass: SessionClass): void
  /**
   * Resolve a ledger id in the store and sync it; a Session the store does
   * not hold yet arms the same bounded re-check instead of waiting for the
   * next restart's boot backfill.
   */
  syncById(sessionId: string, sessionClass: SessionClass): void
  /** Mirror every recorded class into its Session log, refreshing cold checkpoints. */
  backfill(classes: Readonly<Record<string, SessionClass>>): Promise<void>
  /** Release the injection fiber, pending re-checks and the registration (idempotent). */
  dispose(): void
}

/**
 * Create the projection face for one dispatch mount.
 * @param ctx - the plugin context (soft `sessionProjections` inject + service probes).
 * @returns the face; call `mount` once, `dispose` from the plugin's effect cleanup.
 */
export function createClassProjection(ctx: Context): ClassProjection {
  /** The injection fiber: disposing it runs the inject callback's cleanup. */
  let disposeInjection: { dispose(): unknown } | undefined
  /** The registry's registration disposer; invoked by the shared teardown. */
  let disposeProjection: (() => void) | undefined
  /** The live registry while injected; `stateOf` reads the folded class through it. */
  let registry: Context['sessionProjections'] | undefined
  let resolveMounted: (() => void) | undefined
  const mounted = new Promise<void>((resolve) => {
    resolveMounted = resolve
  })
  /** Pending bounded re-checks keyed by canonical Session id. */
  const retries = new Map<string, RetryEntry>()
  /** Set by `dispose`: no new re-check arms and running ones stop at their next checkpoint. */
  let disposed = false
  /**
   * Set when the boot backfill pass has completed: a cold settle after it
   * (the sessionclass-retry-1126 case-B signature — the settle landed after
   * the pass's snapshot) warns loudly instead of arming silently.
   */
  let backfillDone = false

  /** Disarm the registration; idempotent, shared by the inject cleanup and dispose. */
  const teardown = (): void => {
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

  const probe = (name: string): unknown => {
    try {
      return (ctx as unknown as { get(name: string): unknown }).get(name)
    } catch {
      return undefined
    }
  }

  const store = (): SessionStoreFace | undefined => {
    const service = probe('sessions')
    return typeof service === 'object' && service !== null && typeof (service as SessionStoreFace).get === 'function'
      ? service as SessionStoreFace
      : undefined
  }

  /** Retire one Session's pending re-check — its class now stands. */
  const dropRetry = (id: string, entry: RetryEntry): void => {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (retries.get(id) === entry) retries.delete(id)
  }

  /**
   * Arm the bounded delayed re-check for one Session: two attempts, 10s then
   * 60s, then a loud give-up (sessionclass-retry-1126). The latest ledger
   * class always wins over an older pending one.
   * @param sessionId - any spelling; the entry is keyed canonically.
   * @param sessionClass - the class that failed to land (or has not landed yet).
   * @returns a phrase for the caller's warn line — what happens next.
   */
  const scheduleRetry = (sessionId: string, sessionClass: SessionClass): string => {
    if (disposed) return 're-check skipped (projection disposed)'
    const id = canonicalSessionId(sessionId)
    const entry = retries.get(id) ?? { sessionClass, attempts: 0, timer: undefined }
    entry.sessionClass = sessionClass
    retries.set(id, entry)
    if (entry.timer !== undefined) return `re-check already armed (attempt ${entry.attempts}/${RETRY_DELAYS_MS.length})`
    if (entry.attempts >= RETRY_DELAYS_MS.length) {
      retries.delete(id)
      return `re-check budget spent after ${entry.attempts} attempts — the next boot's backfill owns it`
    }
    const delay = RETRY_DELAYS_MS[entry.attempts]
    entry.attempts += 1
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void runRetry(id)
    }, delay)
    unrefTimer(entry.timer)
    return `re-check armed (attempt ${entry.attempts}/${RETRY_DELAYS_MS.length} in ${delay}ms)`
  }

  /** Dedupe against the folded state, then the cross-copy append; throws on rejection. */
  const applyLive = (session: Session, sessionClass: SessionClass): void => {
    if (registry !== undefined) {
      try {
        if (registry.stateOf(session, 'sessionClass') === sessionClass) return
      } catch {
        // A fold the registry cannot materialize yet: append anyway; the fold
        // re-reads the log when the Host next prepares the Session.
      }
    }
    appendClassViaHost(session, sessionClass)
  }

  /**
   * Apply one class onto a live Session and reconcile the pending re-check.
   * A ledger write supersedes any pending re-check outright; the boot pass's
   * snapshot may predate a newer failed settle, so a `pass` write only
   * supersedes a re-check for the same class.
   * @param session - the live Session to append onto.
   * @param sessionClass - the class the caller holds now.
   * @param source - `ledger` (authoritative settle) or `pass` (boot snapshot).
   */
  const applyToLive = (session: Session, sessionClass: SessionClass, source: 'ledger' | 'pass'): void => {
    const id = canonicalSessionId(String(session.id))
    try {
      applyLive(session, sessionClass)
      const pending = retries.get(id)
      if (pending !== undefined && (source === 'ledger' || pending.sessionClass === sessionClass)) {
        dropRetry(id, pending)
      }
    } catch (error) {
      const outcome = scheduleRetry(id, sessionClass)
      console.warn(`[session-class] live sync failed session=${id} class=${sessionClass} reason=${errorDetail(error)} — ${outcome}`)
    }
  }

  /**
   * One delayed re-check: resolve the Session again (it may have entered the
   * store since the settle), sync it live, or — still cold — write through
   * the persistence handle exactly like the boot pass. Success retires the
   * entry; failure warns and arms the next slot, or gives up loudly once the
   * two-attempt budget is spent.
   * @param id - canonical Session id the entry is keyed by.
   */
  async function runRetry(id: string): Promise<void> {
    const entry = retries.get(id)
    if (entry === undefined || disposed) return
    entry.timer = undefined
    const applied = entry.sessionClass
    const attempt = entry.attempts
    let failure: string | undefined
    try {
      const session = store()?.get?.(id)
      if (session !== undefined) {
        applyLive(session, applied)
      } else {
        const persistence = probe('sessionPersistence') as PersistenceFace | undefined
        const cache = probe('sessionProjectionCache') as ProjectionCacheFace | undefined
        if (persistence === undefined || cache === undefined) {
          // No write surface: this profile serves no cold writes — quiet stop,
          // the same stance the boot pass takes for the same condition.
          dropRetry(id, entry)
          return
        }
        await backfillCold(persistence, cache, id, applied)
      }
    } catch (error) {
      failure = errorDetail(error)
    }
    if (disposed || retries.get(id) !== entry) return
    if (failure === undefined) {
      if (entry.sessionClass === applied) dropRetry(id, entry)
      // A newer class failed while this attempt ran: keep the re-check armed for it.
      else if (entry.timer === undefined) scheduleRetry(id, entry.sessionClass)
      return
    }
    const outcome = scheduleRetry(id, entry.sessionClass)
    console.warn(`[session-class] re-check failed session=${id} class=${entry.sessionClass} attempt=${attempt}/${RETRY_DELAYS_MS.length} reason=${failure} — ${outcome}`)
  }

  const syncLive = (session: Session, sessionClass: SessionClass): void => {
    applyToLive(session, sessionClass, 'ledger')
  }

  return {
    mount(): Promise<void> {
      try {
        disposeInjection = ctx.inject(['sessionProjections'], (projectionCtx) => {
          try {
            // Disposer form: the installed package types register this way, and
            // the Host's module table answers the same call (legacy-compatible).
            disposeProjection = projectionCtx.sessionProjections.register(sessionClassProjection)
          } catch {
            // Duplicate key from a stale mount: that fold already carries the
            // value, or the key stays absent and the client paints nothing.
            resolveMounted?.()
            return () => { teardown() }
          }
          registry = projectionCtx.sessionProjections
          resolveMounted?.()
          return () => { teardown() }
        })
      } catch {
        // A service-level fixture context serves no cordis surface (no
        // `inject`): the key simply never mounts — the same "plugin absent"
        // shape the client renders quiet absence on.
        resolveMounted?.()
      }
      return mounted
    },

    syncLive,

    syncById(sessionId, sessionClass): void {
      const id = canonicalSessionId(sessionId)
      const face = store()
      const session = face?.get?.(sessionId) ?? face?.get?.(id)
      if (session !== undefined) {
        syncLive(session, sessionClass)
        return
      }
      // Cold: the boot pass covers every class it snapshots; one that settles
      // after the pass (the sessionclass-retry-1126 case-B signature) would
      // otherwise wait for the next restart. The re-check re-resolves the
      // store, then falls back to the same persistence write the pass uses.
      const outcome = scheduleRetry(id, sessionClass)
      if (backfillDone) {
        console.warn(`[session-class] session not in the store after the boot backfill session=${id} class=${sessionClass} — ${outcome}`)
      }
    },

    async backfill(classes): Promise<void> {
      const persistence = probe('sessionPersistence') as PersistenceFace | undefined
      const cache = probe('sessionProjectionCache') as ProjectionCacheFace | undefined
      if (persistence === undefined || cache === undefined) return
      const face = store()
      try {
        for (const [id, value] of Object.entries(classes)) {
          const sessionClass = toClass(value)
          if (sessionClass === undefined) continue
          try {
            const session = face?.get?.(id) ?? face?.get?.(canonicalSessionId(id))
            if (session !== undefined) {
              applyToLive(session, sessionClass, 'pass')
              continue
            }
            // One bad Session never stops the pass (fail-open, per-session).
            // oxlint-disable-next-line eslint/no-await-in-loop -- the sequential pass IS the design: one Session's read+refold at a time, like the controller's repair pump.
            await backfillCold(persistence, cache, id, sessionClass)
          } catch (error) {
            // Missing directory, owned handle, unreadable log: never silent —
            // warn with the id + class + reason and arm the bounded re-check.
            const outcome = scheduleRetry(id, sessionClass)
            console.warn(`[session-class] backfill failed session=${id} class=${sessionClass} reason=${errorDetail(error)} — ${outcome}`)
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- the pacing yield is the point: work one Session, then hand the loop back.
          await new Promise<void>((resolve) => { setImmediate(resolve) })
        }
      } finally {
        // The pass ran: a cold settle from here on is the post-pass signature
        // and warns instead of arming silently.
        backfillDone = true
      }
    },

    dispose(): void {
      disposed = true
      for (const entry of retries.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
      }
      retries.clear()
      teardown()
      const dispose = disposeInjection
      disposeInjection = undefined
      if (dispose !== undefined) {
        try {
          void dispose.dispose()
        } catch {
          // Its fiber may already be gone during shutdown.
        }
      }
    },
  }
}
