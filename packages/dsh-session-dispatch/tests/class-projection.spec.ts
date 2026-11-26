/**
 * The `sessionClass` projection (sessionclass-summary-channel-1127): the
 * fold's purity (record in → triclass out, everything else same-reference)
 * and the boot backfill's three paths — checkpoint fast-path skip, cold
 * write-open append + checkpoint refresh, live-store append — against
 * structural fakes of the persistence/cache/store services.
 *
 * test-standards-allow: table-driven fold/backfill unit tests — role-titled
 * Given/When/Then bodies would contort pure state assertions, and the fake
 * Sessions' own `append` doubles pin the cross-copy write seam the live
 * paths assert on — including their failure logging and bounded re-check
 * (sessionclass-retry-1126).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  CLASS_RECORD,
  createClassProjection,
  sessionClassProjection,
} from '../src/host/class-projection.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
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

/**
 * A live-Session double: the cross-copy seam is the instance's own `append`,
 * which the Host stamps `{ ignorable: true }` — the shape `appendClassViaHost`
 * verifies. A custom implementation may throw to model a rejected write.
 */
function fakeSession(id: string, implementation?: () => unknown): { session: Session; append: ReturnType<typeof vi.fn> } {
  const append = vi.fn(implementation ?? (() => ({ ignorable: true })))
  return { session: { id, append } as unknown as Session, append }
}

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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const persistence = fakePersistence({ statHeader: header, events: [plainEvent(0)] })
    const cache = fakeCache()
    cache.coldSnapshot = vi.fn(() => { throw new Error('checkpoint refused') })
    const face = createClassProjection(fakeCtx({ sessionPersistence: persistence.face, sessionProjectionCache: cache }))

    await expect(face.backfill({ 'session-1': 'human' })).resolves.toBeUndefined()
    expect(persistence.handle.close).toHaveBeenCalledTimes(1)
    // The per-session failure is loud: id + class + reason, never silent.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session=session-1 class=human'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('checkpoint refused'))
    face.dispose()
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
    const { session: live, append: liveAppend } = fakeSession('session-live')
    const store = { get: (id: string) => (id === 'session-live' ? live : undefined) }
    const persistence = fakePersistence({ statHeader: header, events: [plainEvent(0)] })
    const cache = fakeCache()
    const face = createClassProjection(fakeCtx({
      sessions: store,
      sessionPersistence: persistence.face,
      sessionProjectionCache: cache,
    }))

    await face.backfill({ 'session-live': 'bot-boss', 'session-cold': 'human' })

    // The live write rides the Session's own public append (cross-copy seam).
    expect(liveAppend).toHaveBeenCalledWith(CLASS_RECORD, { class: 'bot-boss' }, { ignorable: true })
    // The cold row still went through the write-open path.
    expect(persistence.face.open).toHaveBeenCalledTimes(1)
    expect(persistence.face.open).toHaveBeenCalledWith('session-cold', 'write')
    face.dispose()
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
    const { session, append } = fakeSession('session-1')
    const register = vi.fn(() => () => {})
    const stateOf = vi.fn(() => 'human')
    const face = createClassProjection(fakeCtx({}, { register, stateOf }))
    await face.mount()

    face.syncLive(session, 'human')
    expect(append).not.toHaveBeenCalled()

    face.syncLive(session, 'bot-worker')
    expect(append).toHaveBeenCalledWith(CLASS_RECORD, { class: 'bot-worker' }, { ignorable: true })
    face.dispose()
  })

  it('appends unconditionally while the fold is not mounted (no dedupe, still correct)', async () => {
    const { session, append } = fakeSession('session-1')
    const face = createClassProjection(fakeCtx({}, { register: vi.fn((_definition: unknown) => { throw new Error('duplicate') }), stateOf: vi.fn() }))
    await face.mount()

    face.syncLive(session, 'human')

    expect(append).toHaveBeenCalledWith(CLASS_RECORD, { class: 'human' }, { ignorable: true })
    face.dispose()
  })

  it('resolves a ledger id in the store, by either spelling, and syncs only live hits', async () => {
    const { session: live, append } = fakeSession('session-bare')
    const store = { get: (id: string) => (id === 'session-bare' ? live : undefined) }
    const face = createClassProjection(fakeCtx({ sessions: store }, { register: vi.fn(() => () => {}), stateOf: vi.fn(() => null) }))
    await face.mount()

    face.syncById('session-bare', 'human')
    face.syncById('bare', 'human')
    face.syncById('session-cold', 'human')

    expect(append).toHaveBeenCalledTimes(2)
    expect(append).toHaveBeenNthCalledWith(1, CLASS_RECORD, { class: 'human' }, { ignorable: true })
    expect(append).toHaveBeenNthCalledWith(2, CLASS_RECORD, { class: 'human' }, { ignorable: true })
    face.dispose()
  })

  it('never throws when the store service is absent', () => {
    const face = createClassProjection(fakeCtx({}))

    expect(() => face.syncById('session-1', 'human')).not.toThrow()
    face.dispose()
  })
})

describe('ClassProjection failure logging and bounded re-check', () => {
  it('warns with the session id, class and reason when the live append rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { session, append } = fakeSession('session-1', () => {
      throw new TypeError('Receiver must be an instance of class Session')
    })
    const face = createClassProjection(fakeCtx({}, { register: vi.fn(() => () => {}), stateOf: vi.fn(() => null) }))
    await face.mount()

    face.syncLive(session, 'human')

    expect(append).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[session-class] live sync failed session=session-1 class=human'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TypeError: Receiver must be an instance of class Session'))
    // The armed re-check and its cap are part of the loud line.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-check armed (attempt 1/2 in 10000ms)'))
    face.dispose()
  })

  it('retries a rejected append at 10s then 60s, then gives up loudly', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { session, append } = fakeSession('session-1', () => {
      throw new Error('publication closed')
    })
    const face = createClassProjection(fakeCtx({ sessions: { get: () => session } }, { register: vi.fn(() => () => {}), stateOf: vi.fn(() => null) }))
    await face.mount()

    face.syncLive(session, 'human')
    expect(append).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(append).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(append).toHaveBeenCalledTimes(3)

    // Budget spent: no third attempt, and the give-up names the session.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(append).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-check budget spent after 2 attempts'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session=session-1'))
    face.dispose()
  })

  it('warns and re-checks a class that settled cold after the boot backfill (case B)', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let live: Session | undefined
    const store = { get: () => live }
    const { session, append } = fakeSession('session-b')
    const persistence = fakePersistence({ statHeader: header, events: [plainEvent(0)] })
    const cache = fakeCache()
    const face = createClassProjection(fakeCtx({
      sessions: store,
      sessionPersistence: persistence.face,
      sessionProjectionCache: cache,
    }, { register: vi.fn(() => () => {}), stateOf: vi.fn(() => null) }))
    await face.mount()
    await face.backfill({})

    face.syncById('session-b', 'human')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session not in the store after the boot backfill session=session-b class=human'))
    expect(append).not.toHaveBeenCalled()

    // The Session enters the store before the re-check fires: the live write lands.
    live = session
    await vi.advanceTimersByTimeAsync(10_000)

    expect(append).toHaveBeenCalledWith(CLASS_RECORD, { class: 'human' }, { ignorable: true })
    face.dispose()
  })

  it('writes through the persistence handle when the Session stays cold', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const persistence = fakePersistence({ statHeader: header, events: [plainEvent(0)] })
    const cache = fakeCache()
    const face = createClassProjection(fakeCtx({
      sessions: { get: () => undefined },
      sessionPersistence: persistence.face,
      sessionProjectionCache: cache,
    }))

    face.syncById('session-cold', 'bot-worker')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(persistence.face.open).toHaveBeenCalledWith('session-cold', 'write')
    expect(persistence.handle.append).toHaveBeenCalledTimes(1)
    expect(cache.coldSnapshot).toHaveBeenCalled()
    // A cold re-check that lands is quiet — only failures are loud.
    expect(warn).not.toHaveBeenCalled()
    face.dispose()
  })

  it('warns with the id and reason when a backfill write rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const persistence = fakePersistence({ statHeader: header, events: [plainEvent(0)] })
    persistence.face.open = vi.fn(async () => { throw new Error('owned handle') })
    const cache = fakeCache()
    const face = createClassProjection(fakeCtx({ sessionPersistence: persistence.face, sessionProjectionCache: cache }))

    await face.backfill({ 'session-1': 'human' })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[session-class] backfill failed session=session-1 class=human'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Error: owned handle'))
    face.dispose()
  })

  it('dispose clears pending re-checks so nothing fires after teardown', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { session, append } = fakeSession('session-d', () => {
      throw new Error('nope')
    })
    const face = createClassProjection(fakeCtx({}, { register: vi.fn(() => () => {}), stateOf: vi.fn(() => null) }))
    await face.mount()

    face.syncLive(session, 'human')
    expect(append).toHaveBeenCalledTimes(1)
    face.dispose()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(append).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
