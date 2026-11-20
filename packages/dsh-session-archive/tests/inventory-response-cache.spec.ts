// @vitest-environment node
/**
 * The whole-response inventory cache (task #inventory-perf-1030; sizing and
 * stale-while-revalidate reworked by #inventory-offhost-1110): one rebuild is
 * serialized once and served verbatim inside the TTL window, and past the
 * window or after an invalidation the retained bytes still answer immediately
 * while a single-flight background rebuild refreshes them — a reader never
 * pays the rebuild once a snapshot exists. Only a reader that finds no usable
 * snapshot (first build after boot, a clock that stepped back) pays one, and
 * cold bursts coalesce into a single rebuild. The window rules (lapse,
 * invalidation, a clock that steps back, an invalidation landing mid-rebuild)
 * are pinned with an injected clock; the service-level cases rest on the
 * invalidation being synchronous with the operation completing, not on
 * measured durations. The owner's two deliberate exceptions to "reads never
 * pay" are pinned too: the boot prewarm issues the first build with no
 * reader, and an explicit refresh (rebuild) pays it for its caller while
 * every other reader keeps the retained bytes.
 */
import { describe, expect, it, vi } from 'vitest'
import { InventoryResponseCache } from '../src/host/inventory-response-cache.ts'
import { ArchiveService, PREWARM_DELAY_MS, PREWARM_RETRY_MS } from '../src/host/janitor.ts'
import { createFakeHost, fakeContext, writeProjcacheSessionFile } from './fixtures.ts'

/** Let the single-flight background refresh land (its builds resolve immediately). */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Read until the background refresh lands (bounded). The pure-cache cases
 * above build in microtasks, but a service rebuild after a physical delete
 * re-walks the sessions directory (the delete pipeline invalidates the dir
 * index), so one macrotask tick cannot cover the thread-pool round trip —
 * polling expresses "once the refresh lands" without leaning on durations,
 * and a refresh that never lands (a swallowed build error) fails loudly.
 */
async function untilFresh<T extends { stale: boolean }>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const served = await read()
    if (!served.stale) return served
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error('background refresh never landed')
}

function gatedBuild(): { cache: InventoryResponseCache; release: () => void; builds: () => number } {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let buildCount = 0
  const cache = new InventoryResponseCache({
    ttlMs: 15_000,
    build: async () => {
      buildCount += 1
      const n = buildCount
      await gate
      return { payload: `{"n":${n}}`, generatedAt: 1_000 }
    },
    now: () => 1_000,
  })
  return { cache, release: () => release?.(), builds: () => buildCount }
}

describe('Given a response cache serving a retained body', () => {
  it('operator gets the very same bytes inside the window and one build behind them', async () => {
    // Given a cache whose build produced one payload
    let clock = 1_000
    let buildCount = 0
    const cache = new InventoryResponseCache({
      ttlMs: 15_000,
      build: async () => ({ payload: `{"n":${++buildCount}}`, generatedAt: clock }),
      now: () => clock,
    })

    // When two reads land inside the window
    const first = await cache.serve()
    clock += 14_999
    const second = await cache.serve()

    // Then the retained bytes answer the second read verbatim
    expect(cache.builds).toBe(1)
    expect(first.hit).toBe(false)
    expect(first.stale).toBe(false)
    expect(first.payload).toBe('{"n":1}')
    expect(second.hit).toBe(true)
    expect(second.stale).toBe(false)
    expect(second.payload).toBe('{"n":1}')
    expect(second.ageMs).toBe(14_999)
  })

  it('operator gets the stale body at once and the refresh behind it once the window lapses', async () => {
    // Given a cache holding one payload
    let clock = 1_000
    let buildCount = 0
    const cache = new InventoryResponseCache({
      ttlMs: 15_000,
      build: async () => ({ payload: `{"n":${++buildCount}}`, generatedAt: clock }),
      now: () => clock,
    })
    await cache.serve()

    // When the next read lands after the window
    clock += 15_000
    const stale = await cache.serve()

    // Then it answered from the retained body without paying the rebuild
    // inline, and kicked exactly one background refresh
    expect(stale.hit).toBe(true)
    expect(stale.stale).toBe(true)
    expect(stale.payload).toBe('{"n":1}')
    expect(cache.builds).toBe(2)

    // And once that refresh lands the next read serves the new payload fresh
    await flush()
    const refreshed = await cache.serve()
    expect(refreshed.hit).toBe(true)
    expect(refreshed.stale).toBe(false)
    expect(refreshed.payload).toBe('{"n":2}')
    expect(cache.builds).toBe(2)
  })

  it('operator gets a rebuild, never a retained body, when the clock steps backwards', async () => {
    // Given a cache holding one payload
    let clock = 5_000
    const cache = new InventoryResponseCache({
      ttlMs: 15_000,
      build: async () => ({ payload: `{"n":${cache.builds}}`, generatedAt: clock }),
      now: () => clock,
    })
    await cache.serve()

    // When the clock jumps back inside the nominal window
    clock = 4_000
    const stepped = await cache.serve()

    // Then the retained body is not trusted as fresh
    expect(cache.builds).toBe(2)
    expect(stepped.hit).toBe(false)
  })

  it('operator gets a rebuild and a clean retry after a failed build', async () => {
    // Given a cache whose first build fails
    let fail = true
    let buildCount = 0
    const cache = new InventoryResponseCache({
      ttlMs: 15_000,
      build: async () => {
        buildCount += 1
        if (fail) throw new Error('feed unavailable')
        return { payload: '{"ok":true}', generatedAt: 1_000 }
      },
      now: () => 1_000,
    })
    await expect(cache.serve()).rejects.toThrow('feed unavailable')

    // When the next read arrives after the failure cleared
    fail = false
    const recovered = await cache.serve()

    // Then nothing was poisoned: the retry rebuilds and succeeds
    expect(buildCount).toBe(2)
    expect(recovered.hit).toBe(false)
    expect(recovered.payload).toBe('{"ok":true}')
  })

  it('operator keeps the retained body when a background refresh fails', async () => {
    // Given a cache holding one payload whose refresh will fail
    let clock = 1_000
    let fail = false
    let buildCount = 0
    const cache = new InventoryResponseCache({
      ttlMs: 15_000,
      build: async () => {
        buildCount += 1
        if (fail) throw new Error('feed unavailable')
        return { payload: `{"n":${buildCount}}`, generatedAt: clock }
      },
      now: () => clock,
    })
    await cache.serve()
    clock += 15_000
    fail = true
    const stale = await cache.serve()
    await flush()

    // Then the read still answered from the retained body, and the failed
    // refresh left nothing poisoned: the next window retry succeeds
    expect(stale.stale).toBe(true)
    expect(stale.payload).toBe('{"n":1}')
    fail = false
    clock += 15_000
    const retried = await cache.serve()
    await flush()
    const after = await cache.serve()
    expect(retried.stale).toBe(true)
    expect(after.stale).toBe(false)
    expect(after.payload).toBe(`{"n":${buildCount}}`)
    expect(buildCount).toBeGreaterThanOrEqual(3)
  })
})

describe('Given a burst of readers hitting one cold cache', () => {
  it('operator pays for one rebuild, not one per reader', async () => {
    // Given a cache whose rebuild is gated mid-flight
    const { cache, release, builds } = gatedBuild()

    // When four readers arrive before it lands
    const reads = Promise.all([cache.serve(), cache.serve(), cache.serve(), cache.serve()])
    release?.()
    const served = await reads

    // Then one rebuild served all four, and the coalesced readers report the
    // latency they paid (miss), while the retained bytes are identical
    expect(builds()).toBe(1)
    for (const serve of served) expect(serve.payload).toBe('{"n":1}')
    expect(served.filter((serve) => serve.hit)).toEqual([])
  })
})

describe('Given an explicit invalidation', () => {
  it('operator gets the stale body at once and the refresh behind it', async () => {
    // Given a cache holding one payload
    let buildCount = 0
    const cache = new InventoryResponseCache({
      ttlMs: 60_000,
      build: async () => ({ payload: `{"n":${++buildCount}}`, generatedAt: 1_000 }),
      now: () => 1_000,
    })
    await cache.serve()

    // When the owner invalidates it
    cache.invalidate()
    const stale = await cache.serve()

    // Then the read answered from the retained body (never pays the rebuild
    // inline) and kicked exactly one refresh behind it
    expect(stale.hit).toBe(true)
    expect(stale.stale).toBe(true)
    expect(stale.payload).toBe('{"n":1}')
    expect(cache.builds).toBe(2)

    // And once the refresh lands the new payload answers fresh
    await flush()
    const after = await cache.serve()
    expect(after.hit).toBe(true)
    expect(after.stale).toBe(false)
    expect(after.payload).toBe('{"n":2}')
    expect(cache.builds).toBe(2)
  })

  it('operator never gets a pre-invalidation rebuild retained when it lands late', async () => {
    // Given a cache whose rebuild is gated mid-flight (no snapshot yet)
    const { cache, release, builds } = gatedBuild()

    // When the owner invalidates before that rebuild lands
    const inFlight = cache.serve()
    cache.invalidate()
    release?.()
    const abandoned = await inFlight

    // Then the abandoned reader still gets its body, but nothing was
    // retained: the next read rebuilds
    expect(abandoned.payload).toBe('{"n":1}')
    expect(builds()).toBe(1)
    const next = await cache.serve()
    expect(builds()).toBe(2)
    expect(next.hit).toBe(false)
    expect(next.payload).toBe('{"n":2}')
  })

  it('operator never pays inline for a scan the invalidation cancelled, and still gets a payload', async () => {
    // Given a cold cache whose first build hangs until its signal aborts
    let first = true
    let buildCount = 0
    let produced = 0
    let aborted = 0
    const cache = new InventoryResponseCache({
      ttlMs: 15_000,
      build: (signal) => {
        buildCount += 1
        if (first) {
          first = false
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              aborted += 1
              reject(new Error('scan cancelled'))
            }, { once: true })
          })
        }
        return Promise.resolve({ payload: `{"n":${++produced}}`, generatedAt: 1_000 })
      },
      now: () => 1_000,
    })

    // When the owner invalidates while the reader waits on that build
    const reading = cache.serve()
    cache.invalidate()
    const served = await reading

    // Then the orphaned scan was cancelled on the spot (方向④), its attempt
    // was given back rather than counted ("不白计"), and the joined reader
    // retried under the new generation and received a real payload — never
    // the dead build's
    expect(aborted).toBe(1)
    expect(cache.builds).toBe(1)
    expect(served.hit).toBe(false)
    expect(served.payload).toBe('{"n":1}')
  })

  it('operator never counts a background refresh the invalidation cancelled', async () => {
    // Given a cache holding one payload whose refresh hangs until aborted
    let clock = 1_000
    let hangs = false
    let buildCount = 0
    let aborted = 0
    const cache = new InventoryResponseCache({
      ttlMs: 15_000,
      build: (signal) => {
        buildCount += 1
        if (buildCount === 1) return Promise.resolve({ payload: '{"n":1}', generatedAt: 1_000 })
        if (hangs) {
          hangs = false
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              aborted += 1
              reject(new Error('refresh cancelled'))
            }, { once: true })
          })
        }
        return Promise.resolve({ payload: '{"n":2}', generatedAt: clock })
      },
      now: () => clock,
    })
    await cache.serve()

    // When the window lapses, the kicked refresh hangs, and the owner
    // invalidates before it lands
    clock += 15_000
    hangs = true
    const stale = await cache.serve()
    expect(stale.stale).toBe(true)
    cache.invalidate()
    await flush()

    // Then the orphaned refresh was aborted, its attempt was not counted,
    // and the retained body still answers while a fresh refresh runs behind
    expect(aborted).toBe(1)
    expect(cache.builds).toBe(1)
    const after = await cache.serve()
    expect(after.payload).toBe('{"n":1}')
    await flush()
    const refreshed = await cache.serve()
    expect(refreshed.stale).toBe(false)
    expect(refreshed.payload).toBe('{"n":2}')
    expect(cache.builds).toBe(2)
  })
})

describe('Given the boot prewarm', () => {
  it('operator gets a warm first read, with nobody paying for the warmup', async () => {
    // Given a cold cache nobody has read
    let buildCount = 0
    const cache = new InventoryResponseCache({
      ttlMs: 15_000,
      build: async () => ({ payload: `{"n":${++buildCount}}`, generatedAt: 1_000 }),
      now: () => 1_000,
    })

    // When the owner prewarms it
    cache.prewarm()
    await flush()

    // Then one background build landed without any reader asking
    expect(buildCount).toBe(1)
    expect(cache.builds).toBe(1)

    // And the first read is a hit over those bytes, paying no second build
    const first = await cache.serve()
    expect(first.hit).toBe(true)
    expect(first.payload).toBe('{"n":1}')
    expect(cache.builds).toBe(1)
  })

  it('operator gets no second build when a prewarm lands on a snapshot that already exists', async () => {
    // Given a cache already holding a snapshot
    let buildCount = 0
    const cache = new InventoryResponseCache({
      ttlMs: 15_000,
      build: async () => ({ payload: `{"n":${++buildCount}}`, generatedAt: 1_000 }),
      now: () => 1_000,
    })
    await cache.serve()

    // When the owner prewarms anyway
    cache.prewarm()
    await flush()

    // Then the existing snapshot still answers and nothing was rebuilt
    expect(cache.builds).toBe(1)
    const served = await cache.serve()
    expect(served.hit).toBe(true)
    expect(cache.builds).toBe(1)
  })

  it('operator pays one build when the prewarm lands on a cold read already in flight', async () => {
    // Given a cache whose first build is gated mid-flight
    const { cache, release, builds } = gatedBuild()

    // When a cold read and the prewarm meet that build
    const reading = cache.serve()
    cache.prewarm()
    release?.()
    const served = await reading

    // Then they shared one build: the prewarm never started a competing one
    expect(builds()).toBe(1)
    expect(served.hit).toBe(false)
    expect(served.payload).toBe('{"n":1}')
  })
})

describe('Given an explicit refresh (rebuild)', () => {
  it('operator gets rebuilt bytes, never the retained body, and the window follows', async () => {
    // Given a cache holding one payload
    let buildCount = 0
    const cache = new InventoryResponseCache({
      ttlMs: 60_000,
      build: async () => ({ payload: `{"n":${++buildCount}}`, generatedAt: 1_000 }),
      now: () => 1_000,
    })
    await cache.serve()

    // When the owner serves an explicit refresh
    const refreshed = await cache.rebuild()

    // Then this reader paid the rebuild and received the new bytes
    expect(refreshed.hit).toBe(false)
    expect(refreshed.stale).toBe(false)
    expect(refreshed.payload).toBe('{"n":2}')
    expect(cache.builds).toBe(2)

    // And the window now answers with those bytes
    const after = await cache.serve()
    expect(after.hit).toBe(true)
    expect(after.payload).toBe('{"n":2}')
    expect(cache.builds).toBe(2)
  })

  it('operator never queues behind an explicit refresh: concurrent reads keep the retained body', async () => {
    // Given a cache holding one payload whose refresh build is gated
    let buildCount = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const cache = new InventoryResponseCache({
      ttlMs: 60_000,
      build: async () => {
        buildCount += 1
        if (buildCount > 1) await gate
        return { payload: `{"n":${buildCount}}`, generatedAt: 1_000 }
      },
      now: () => 1_000,
    })
    await cache.serve()

    // When an explicit refresh waits on its rebuild while another reader arrives
    const refreshing = cache.rebuild()
    const concurrent = await cache.serve()

    // Then the concurrent read answered at once from the retained body
    expect(concurrent.hit).toBe(true)
    expect(concurrent.stale).toBe(true)
    expect(concurrent.payload).toBe('{"n":1}')

    // And the refresh reader still ends with the rebuilt bytes
    release?.()
    const refreshed = await refreshing
    expect(refreshed.payload).toBe('{"n":2}')
    expect(buildCount).toBe(2)
  })

  it('operator never receives a refresh build a mutation aborted, and never waits forever', async () => {
    // Given a cache holding one payload whose next build hangs until aborted
    let buildCount = 0
    let produced = 0
    let hangs = false
    const cache = new InventoryResponseCache({
      ttlMs: 15_000,
      build: (signal) => {
        buildCount += 1
        if (hangs) {
          hangs = false
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('scan cancelled')), { once: true })
          })
        }
        produced += 1
        return Promise.resolve({ payload: `{"n":${produced}}`, generatedAt: 1_000 })
      },
      now: () => 1_000,
    })
    await cache.serve()

    // When a mutation invalidates while the explicit refresh waits
    hangs = true
    const refreshing = cache.rebuild()
    cache.invalidate()
    const refreshed = await refreshing

    // Then the reader retried under the new generation and got a real
    // payload — never the dead build's — and the aborted attempt was not counted
    expect(refreshed.payload).toBe('{"n":2}')
    expect(cache.builds).toBe(2)
  })
})

describe('Given the service that owns the response cache', () => {
  it('operator sees the cached window, and every mutation refreshes behind the next read', async () => {
    // Given a service over a fake host with one unarchived session
    const host = createFakeHost({
      feedItems: [{ sessionId: 'session-a', updatedAt: 1 }],
      persistedIds: ['session-a'],
      dirs: ['session-a'],
    })
    const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
    await service.start()

    // When the route reads twice with no mutation between
    const first = await service.inventoryCached()
    const second = await service.inventoryCached()

    // Then the second read is a hit over the same bytes
    expect(first.hit).toBe(false)
    expect(second.hit).toBe(true)
    expect(second.payload).toBe(first.payload)
    expect(JSON.parse(first.payload).rows[0].archived).toBe(false)

    // When the service archives the session
    await service.archive(['session-a'], 'manual', undefined, 'manual-test')

    // Then the next read answers from the retained (pre-mutation) body while
    // the refresh runs behind it — reads never pay the rebuild inline
    const afterArchive = await service.inventoryCached()
    expect(afterArchive.stale).toBe(true)
    expect(JSON.parse(afterArchive.payload).rows[0].archived).toBe(false)

    // And once that refresh lands the archive is visible
    const refreshed = await untilFresh(() => service.inventoryCached())
    expect(refreshed.stale).toBe(false)
    expect(JSON.parse(refreshed.payload).rows[0].archived).toBe(true)

    // When the service restores it
    await service.unarchive(['session-a'])
    const afterUnarchive = await untilFresh(() => service.inventoryCached())
    expect(afterUnarchive.stale).toBe(false)
    expect(JSON.parse(afterUnarchive.payload).rows[0].archived).toBe(false)

    // When the service physically deletes it (the fixture's fake feed still
    // lists the session, so the observable through the response is the
    // storage size the directory walk contributed)
    expect(JSON.parse((await service.inventoryCached()).payload).rows[0].sizeBytes).toBe(64)
    await service.deleteSessions(['session-a'], { expectedTotal: 1 })
    const afterDelete = await untilFresh(() => service.inventoryCached())
    expect(afterDelete.stale).toBe(false)
    expect(JSON.parse(afterDelete.payload).rows[0].sizeBytes).toBeUndefined()
    expect(host.registry.state.archivedSessionIds).toEqual([])
  })

  it('operator sees the cache invalidated by a rejected operation that changed nothing', async () => {
    // Given a service holding a cached response
    const host = createFakeHost({
      feedItems: [{ sessionId: 'session-a', updatedAt: 1 }],
      persistedIds: ['session-a'],
    })
    const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
    await service.start()
    await service.inventoryCached()

    // When a delete batch aborts on a plan mismatch (nothing mutated; the
    // confirmed total is lower than what the host would delete)
    await expect(service.deleteSessions(['session-a'], { expectedTotal: 0 })).rejects.toThrow('delete plan mismatch')

    // Then the window was still dropped: the lock release invalidates on
    // every operation, so freshness never depends on guessing what mutated
    const after = await service.inventoryCached()
    expect(after.stale).toBe(true)
  })

  it('operator gets a background build issued at boot, before any reader asked', async () => {
    // Given a service that has just started
    const host = createFakeHost({
      feedItems: [{ sessionId: 'session-a', updatedAt: 1 }],
      persistedIds: ['session-a'],
    })
    const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
    vi.useFakeTimers()
    try {
      await service.start()

      // When the prewarm delay elapses with nobody reading
      expect(service.inventoryBuilds).toBe(0)
      await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS)

      // Then one background build was issued for the first open
      expect(service.inventoryBuilds).toBe(1)

      // And the first reader coalesces with it instead of paying a second build
      const first = await service.inventoryCached()
      expect(service.inventoryBuilds).toBe(1)
      expect(JSON.parse(first.payload).rows[0].id).toBe('session-a')
    } finally {
      service.stop()
      vi.useRealTimers()
    }
  })

  it('operator gets no prewarm build while the feed face is down, and one once it answers', async () => {
    // Given a service whose session-feed face is not answering yet
    const host = createFakeHost({
      feedItems: [{ sessionId: 'session-a', updatedAt: 1 }],
      persistedIds: ['session-a'],
    })
    const base = fakeContext(host) as { get(name: string): unknown }
    let feedFaceUp = false
    const ctx = {
      get(name: string): unknown {
        if (name === 'sessionController' && !feedFaceUp) return undefined
        return base.get(name)
      },
    }
    const service = new ArchiveService(ctx as never, { dshHome: host.home })
    vi.useFakeTimers()
    try {
      await service.start()

      // When the prewarm delay elapses with the face still down
      await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS)

      // Then no build ran: a feedless pass would cache a degraded snapshot
      expect(service.inventoryBuilds).toBe(0)

      // And when the face answers on the next retry, the build is issued
      feedFaceUp = true
      await vi.advanceTimersByTimeAsync(PREWARM_RETRY_MS)
      expect(service.inventoryBuilds).toBe(1)
    } finally {
      service.stop()
      vi.useRealTimers()
    }
  })

  it('operator sees a late-landed title on an explicit refresh, never on a plain read', async () => {
    // Given a listed session whose per-session projcache file carries no title
    const host = createFakeHost({
      feedItems: [{ sessionId: 'session-late', updatedAt: 10 }],
      dirs: ['session-late'],
    })
    writeProjcacheSessionFile(host.home, 'session-late', { createdAt: 1 })
    const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
    await service.start()
    try {
      // When the window is built while the session still has no title
      const before = await service.inventoryCached()
      expect(JSON.parse(before.payload).rows[0].title).toBeUndefined()

      // And the title lands on disk afterwards
      writeProjcacheSessionFile(host.home, 'session-late', { title: '迟到的标题', createdAt: 1 })

      // Then a plain read still answers with the retained bytes — the window
      // is the freshness authority, and a landed title is not a mutation
      const plain = await service.inventoryCached()
      expect(plain.hit).toBe(true)
      expect(JSON.parse(plain.payload).rows[0].title).toBeUndefined()

      // And the explicit refresh waits out a rebuild over the dropped title memo
      const refreshed = await service.inventoryFresh()
      expect(refreshed.hit).toBe(false)
      expect(JSON.parse(refreshed.payload).rows[0].title).toBe('迟到的标题')
    } finally {
      service.stop()
    }
  })
})
