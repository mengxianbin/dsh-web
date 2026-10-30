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
 * measured durations.
 */
import { describe, expect, it } from 'vitest'
import { InventoryResponseCache } from '../src/host/inventory-response-cache.ts'
import { ArchiveService } from '../src/host/janitor.ts'
import { createFakeHost, fakeContext } from './fixtures.ts'

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
})
