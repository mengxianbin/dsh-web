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
 * @module dsh-session-dispatch/host/class-projection
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  appendPluginRecord,
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
  /** Append the class onto a live Session whose folded state disagrees. */
  syncLive(session: Session, sessionClass: SessionClass): void
  /** Resolve a ledger id in the store and sync it; a cold Session waits for the backfill pass. */
  syncById(sessionId: string, sessionClass: SessionClass): void
  /** Mirror every recorded class into its Session log, refreshing cold checkpoints. */
  backfill(classes: Readonly<Record<string, SessionClass>>): Promise<void>
  /** Release the injection fiber and the registration (idempotent). */
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

  const syncLive = (session: Session, sessionClass: SessionClass): void => {
    if (registry !== undefined) {
      try {
        if (registry.stateOf(session, 'sessionClass') === sessionClass) return
      } catch {
        // A fold the registry cannot materialize yet: append anyway; the fold
        // re-reads the log when the Host next prepares the Session.
      }
    }
    try {
      appendPluginRecord(session, CLASS_RECORD, { class: sessionClass })
    } catch {
      // Store-owned append preconditions (unentered row, in-flight publication)
      // reject without changing the log; the next ledger write retries.
    }
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
      const face = store()
      if (face === undefined) return
      const session = face.get?.(sessionId) ?? face.get?.(canonicalSessionId(sessionId))
      // Cold: the boot backfill pass owns the log write.
      if (session !== undefined) syncLive(session, sessionClass)
    },

    async backfill(classes): Promise<void> {
      const persistence = probe('sessionPersistence') as PersistenceFace | undefined
      const cache = probe('sessionProjectionCache') as ProjectionCacheFace | undefined
      if (persistence === undefined || cache === undefined) return
      const face = store()
      for (const [id, value] of Object.entries(classes)) {
        const sessionClass = toClass(value)
        if (sessionClass === undefined) continue
        try {
          const session = face?.get?.(id) ?? face?.get?.(canonicalSessionId(id))
          if (session !== undefined) {
            syncLive(session, sessionClass)
            continue
          }
          // One bad Session never stops the pass (fail-open, per-session).
          // oxlint-disable-next-line eslint/no-await-in-loop -- the sequential pass IS the design: one Session's read+refold at a time, like the controller's repair pump.
          await backfillCold(persistence, cache, id, sessionClass)
        } catch {
          // Missing directory, owned handle, unreadable log: skip this Session.
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- the pacing yield is the point: work one Session, then hand the loop back.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
      }
    },

    dispose(): void {
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
