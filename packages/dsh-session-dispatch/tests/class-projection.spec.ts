/**
 * The `sessionClass` projection (sessionclass-summary-channel-1127): the
 * fold's purity (record in → triclass out, everything else same-reference)
 * and the boot backfill's three paths — checkpoint fast-path skip, cold
 * write-open append + checkpoint refresh, live-store append — against
 * structural fakes of the persistence/cache/store services.
 *
 * test-standards-allow: table-driven fold/backfill unit tests — role-titled
 * Given/When/Then bodies would contort pure state assertions, and the one
 * vi.mock pins the single appendPluginRecord seam the live paths assert on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { appendPluginRecord, SessionLogOffset, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  CLASS_RECORD,
  createClassProjection,
  sessionClassProjection,
} from '../src/host/class-projection.ts'

vi.mock('@deepseek-ai/dsh-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session')>()
  return { ...actual, appendPluginRecord: vi.fn() }
})

afterEach(() => {
  vi.mocked(appendPluginRecord).mockReset()
})

/** A committed class record shaped exactly as the writer persists it. */
function classRecordEvent(sessionClass: string, seq = 0): SessionEvent {
  return {
    type: CLASS_RECORD,
    seq,
    time: 1_700_000_000_000,
    data: { class: sessionClass },
    ignorable: true,
  } as unknown as SessionEvent
}

/** An unrelated committed event (no ignorable marker, so no plugin record). */
function plainEvent(seq = 0): SessionEvent {
  return {
    type: 'turn/end',
    seq,
    time: 1_700_000_000_000,
    data: { turn: 1, reason: 'stop' },
  } as unknown as SessionEvent
}

const header = { id: 'session-1' } as SessionHeader

describe('sessionClassProjection fold', () => {
  it('inits null for an empty log', () => {
    expect(sessionClassProjection.init(header, SessionLogOffset(0))).toBeNull()
  })

  it('folds a well-formed class record into the triclass', () => {
    const next = sessionClassProjection.apply(null, classRecordEvent('bot-boss'))
    expect(next).toBe('bot-boss')
    expect(sessionClassProjection.apply(next, classRecordEvent('bot-worker'))).toBe('bot-worker')
  })

  it('returns the same state reference for unrelated events (zero publication)', () => {
    const state = sessionClassProjection.apply(null, classRecordEvent('human'))
    expect(sessionClassProjection.apply(state, plainEvent())).toBe(state)
  })

  it('skips malformed or foreign payloads instead of throwing', () => {
    const state = sessionClassProjection.apply(null, classRecordEvent('human'))
    expect(sessionClassProjection.apply(state, classRecordEvent('machine'))).toBe(state)
    expect(sessionClassProjection.apply(state, classRecordEvent('bot'))).toBe(state)
    const notAnObject = { ...classRecordEvent('human'), data: 7 } as unknown as SessionEvent
    expect(sessionClassProjection.apply(state, notAnObject)).toBe(state)
  })

  it('keeps the identity view and the triclass wire schema', () => {
    expect(sessionClassProjection.wire.view('bot-worker')).toBe('bot-worker')
    expect(sessionClassProjection.wire.viewSchema.safeParse('bot-worker').success).toBe(true)
    expect(sessionClassProjection.wire.viewSchema.safeParse('machine').success).toBe(false)
    expect(sessionClassProjection.stateVersion).toBe(1)
  })
})

/** Structural context double: service probes plus an immediate `inject`. */
function fakeCtx(services: Record<string, unknown>, projections?: Record<string, unknown>): Context {
  return {
    get: (name: string) => services[name],
    inject: (_deps: unknown, callback: (ctx: unknown) => unknown) => {
      const cleanup = callback({ sessionProjections: projections })
      return {
        dispose: () => {
          if (typeof cleanup === 'function') cleanup()
        },
      }
    },
  } as unknown as Context
}

interface FakeHandle {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly read: ReturnType<typeof vi.fn>
  readonly append: ReturnType<typeof vi.fn>
  readonly flush: ReturnType<typeof vi.fn>
  readonly close: ReturnType<typeof vi.fn>
}

function fakePersistence(options: {
  statHeader?: SessionHeader
  events?: SessionEvent[]
  inheritedEventCount?: number
}): { face: Record<string, unknown>; handle: FakeHandle } {
  const handle: FakeHandle = {
    header: header,
    inheritedEventCount: options.inheritedEventCount ?? 0,
    read: vi.fn(async () => ({ events: options.events ?? [] })),
    append: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  const face = {
    stat: vi.fn(async () => (options.statHeader === undefined ? undefined : { header: options.statHeader })),
    open: vi.fn(async () => handle),
  }
  return { face, handle }
}

function fakeCache(served?: Record<string, unknown>): Record<string, unknown> {
  return {
    cachedSnapshot: vi.fn(() => (served === undefined ? undefined : { values: served })),
    coldSnapshot: vi.fn(() => ({ values: {} })),
  }
}

describe('ClassProjection.backfill', () => {
  it('skips a Session whose checkpoint already carries the class (zero I/O)', async () => {
    const persistence = fakePersistence({ statHeader: header })
    const cache = fakeCache({ sessionClass: 'human' })
    const face = createClassProjection(fakeCtx({ sessionPersistence: persistence.face, sessionProjectionCache: cache }))

    await face.backfill({ 'session-1': 'human' })

    expect(persistence.face.stat).toHaveBeenCalledWith('session-1')
    expect(persistence.face.open).not.toHaveBeenCalled()
    expect(cache.coldSnapshot).not.toHaveBeenCalled()
  })

  it('appends the missing record, flushes, and refolds the checkpoint with it', async () => {
    const events = [plainEvent(0)]
    const persistence = fakePersistence({ statHeader: header, events, inheritedEventCount: 3 })
    const cache = fakeCache()
    const face = createClassProjection(fakeCtx({ sessionPersistence: persistence.face, sessionProjectionCache: cache }))

    await face.backfill({ 'session-1': 'bot-worker' })

    expect(persistence.face.open).toHaveBeenCalledWith('session-1', 'write')
    expect(persistence.handle.append).toHaveBeenCalledTimes(1)
    const [envelope] = persistence.handle.append.mock.calls[0] as [SessionEvent[]]
    expect(envelope).toHaveLength(1)
    expect(envelope[0].type).toBe(CLASS_RECORD)
    expect(envelope[0].seq).toBe(1)
    expect(envelope[0].ignorable).toBe(true)
    expect(envelope[0].data).toEqual({ class: 'bot-worker' })
    // Durability before the checkpoint write-back (the cache never leads the log).
    expect(persistence.handle.flush).toHaveBeenCalledTimes(1)
    expect(cache.coldSnapshot).toHaveBeenCalledWith(header, 3, [events[0], envelope[0]])
    expect(persistence.handle.close).toHaveBeenCalledTimes(1)
  })

  it('refreshes the checkpoint without a second record when the log already has one', async () => {
    const events = [plainEvent(0), classRecordEvent('human', 1)]
    const persistence = fakePersistence({ statHeader: header, events })
    const cache = fakeCache({ sessionClass: null })
    const face = createClassProjection(fakeCtx({ sessionPersistence: persistence.face, sessionProjectionCache: cache }))

    await face.backfill({ 'session-1': 'human' })

    expect(persistence.handle.append).not.toHaveBeenCalled()
    expect(cache.coldSnapshot).toHaveBeenCalledWith(header, 0, events)
    expect(persistence.handle.close).toHaveBeenCalledTimes(1)
  })

  it('closes the handle even when the refold throws', async () => {
    const persistence = fakePersistence({ statHeader: header, events: [plainEvent(0)] })
    const cache = fakeCache()
    cache.coldSnapshot = vi.fn(() => { throw new Error('checkpoint refused') })
    const face = createClassProjection(fakeCtx({ sessionPersistence: persistence.face, sessionProjectionCache: cache }))

    await expect(face.backfill({ 'session-1': 'human' })).resolves.toBeUndefined()
    expect(persistence.handle.close).toHaveBeenCalledTimes(1)
  })

  it('skips a Session that was never materialized or is already gone', async () => {
    const persistence = fakePersistence({})
    const cache = fakeCache()
    const face = createClassProjection(fakeCtx({ sessionPersistence: persistence.face, sessionProjectionCache: cache }))

    await face.backfill({ 'session-gone': 'human' })

    expect(persistence.face.open).not.toHaveBeenCalled()
    expect(cache.coldSnapshot).not.toHaveBeenCalled()
  })

  it('stays quiet when the profile serves no persistence/cache services', async () => {
    const face = createClassProjection(fakeCtx({}))

    await expect(face.backfill({ 'session-1': 'human' })).resolves.toBeUndefined()
  })

  it('syncs a recorded class onto a live Session and leaves cold ones to the pass', async () => {
    const live = { id: 'session-live' } as unknown as Session
    const store = { get: (id: string) => (id === 'session-live' ? live : undefined) }
    const persistence = fakePersistence({ statHeader: header, events: [plainEvent(0)] })
    const cache = fakeCache()
    const face = createClassProjection(fakeCtx({
      sessions: store,
      sessionPersistence: persistence.face,
      sessionProjectionCache: cache,
    }))

    await face.backfill({ 'session-live': 'bot-boss', 'session-cold': 'human' })

    expect(appendPluginRecord).toHaveBeenCalledWith(live, CLASS_RECORD, { class: 'bot-boss' })
    // The cold row still went through the write-open path.
    expect(persistence.face.open).toHaveBeenCalledTimes(1)
    expect(persistence.face.open).toHaveBeenCalledWith('session-cold', 'write')
  })

  it('drops a non-triclass ledger value without touching anything', async () => {
    const persistence = fakePersistence({ statHeader: header })
    const cache = fakeCache()
    const face = createClassProjection(fakeCtx({ sessionPersistence: persistence.face, sessionProjectionCache: cache }))

    await face.backfill({ 'session-1': 'machine' as never })

    expect(persistence.face.stat).not.toHaveBeenCalled()
  })
})

describe('ClassProjection mount and live sync', () => {
  it('registers the unit against the sessionProjections service', async () => {
    const register = vi.fn((_definition: unknown) => () => {})
    const face = createClassProjection(fakeCtx({}, { register, stateOf: vi.fn(() => null) }))

    await face.mount()

    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0][0]).toMatchObject({ key: 'sessionClass' })
    face.dispose()
  })

  it('appends only when the folded state disagrees with the ledger', async () => {
    const session = { id: 'session-1' } as unknown as Session
    const register = vi.fn(() => () => {})
    const stateOf = vi.fn(() => 'human')
    const face = createClassProjection(fakeCtx({}, { register, stateOf }))
    await face.mount()

    face.syncLive(session, 'human')
    expect(appendPluginRecord).not.toHaveBeenCalled()

    face.syncLive(session, 'bot-worker')
    expect(appendPluginRecord).toHaveBeenCalledWith(session, CLASS_RECORD, { class: 'bot-worker' })
    face.dispose()
  })

  it('appends unconditionally while the fold is not mounted (no dedupe, still correct)', async () => {
    const session = { id: 'session-1' } as unknown as Session
    const face = createClassProjection(fakeCtx({}, { register: vi.fn((_definition: unknown) => { throw new Error('duplicate') }), stateOf: vi.fn() }))
    await face.mount()

    face.syncLive(session, 'human')

    expect(appendPluginRecord).toHaveBeenCalledWith(session, CLASS_RECORD, { class: 'human' })
    face.dispose()
  })

  it('resolves a ledger id in the store, by either spelling, and syncs only live hits', async () => {
    const live = { id: 'session-bare' } as unknown as Session
    const store = { get: (id: string) => (id === 'session-bare' ? live : undefined) }
    const face = createClassProjection(fakeCtx({ sessions: store }, { register: vi.fn(() => () => {}), stateOf: vi.fn(() => null) }))
    await face.mount()

    face.syncById('session-bare', 'human')
    face.syncById('bare', 'human')
    face.syncById('session-cold', 'human')

    expect(appendPluginRecord).toHaveBeenCalledTimes(2)
    expect(appendPluginRecord).toHaveBeenNthCalledWith(1, live, CLASS_RECORD, { class: 'human' })
    expect(appendPluginRecord).toHaveBeenNthCalledWith(2, live, CLASS_RECORD, { class: 'human' })
    face.dispose()
  })

  it('never throws when the store service is absent', () => {
    const face = createClassProjection(fakeCtx({}))

    expect(() => face.syncById('session-1', 'human')).not.toThrow()
  })
})
