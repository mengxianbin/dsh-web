// @vitest-environment node
/**
 * The whole-response inventory cache (task #inventory-perf-1030): one rebuild
 * is serialized once and served verbatim inside a short TTL window, a cold
 * burst coalesces into a single rebuild, and every mutating operation the
 * service performs drops the window so its own archive/restore/delete results
 * are never masked. The window rules (lapse, invalidation, a clock that steps
 * back, an invalidation landing mid-rebuild) are pinned with an injected
 * clock; the service-level cases rest on the invalidation being synchronous
 * with the operation completing, not on measured durations.
 */
import { describe, expect, it } from 'vitest'
import { InventoryResponseCache } from '../src/host/inventory-response-cache.ts'
import { ArchiveService } from '../src/host/janitor.ts'
import { createFakeHost, fakeContext } from './fixtures.ts'

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
    expect(first.payload).toBe('{"n":1}')
    expect(second.hit).toBe(true)
    expect(second.payload).toBe('{"n":1}')
    expect(second.ageMs).toBe(14_999)
  })

  it('operator gets a rebuild once the window lapses', async () => {
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
    const rebuilt = await cache.serve()

    // Then it paid a rebuild and sees the new payload
    expect(cache.builds).toBe(2)
    expect(rebuilt.hit).toBe(false)
    expect(rebuilt.payload).toBe('{"n":2}')
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
  it('operator gets a rebuild even inside the window', async () => {
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
    const after = await cache.serve()

    // Then the window no longer answers: a rebuild did
    expect(cache.builds).toBe(2)
    expect(after.hit).toBe(false)
    expect(after.payload).toBe('{"n":2}')
  })

  it('operator never gets a pre-invalidation rebuild retained when it lands late', async () => {
    // Given a cache whose rebuild is gated mid-flight
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
  it('operator sees the cached window, and every mutation drops it', async () => {
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

    // Then the next read is a rebuild that already shows the archive
    const afterArchive = await service.inventoryCached()
    expect(afterArchive.hit).toBe(false)
    expect(JSON.parse(afterArchive.payload).rows[0].archived).toBe(true)
    expect((await service.inventoryCached()).hit).toBe(true)

    // When the service restores it
    await service.unarchive(['session-a'])

    // Then the window dropped again and the restore is visible at once
    const afterUnarchive = await service.inventoryCached()
    expect(afterUnarchive.hit).toBe(false)
    expect(JSON.parse(afterUnarchive.payload).rows[0].archived).toBe(false)

    // When the service physically deletes it (the fixture's fake feed still
    // lists the session, so the observable through the response is the
    // storage size the directory walk contributed)
    expect(JSON.parse((await service.inventoryCached()).payload).rows[0].sizeBytes).toBe(64)
    await service.deleteSessions(['session-a'], { expectedTotal: 1 })

    // Then the delete is visible at once: the window dropped and the storage
    // the response reports is gone
    const afterDelete = await service.inventoryCached()
    expect(afterDelete.hit).toBe(false)
    expect(JSON.parse(afterDelete.payload).rows[0].sizeBytes).toBeUndefined()
    expect(host.registry.state.archivedSessionIds).toEqual([])
  })

  it('operator sees the cached window survive a rejected operation that changed nothing', async () => {
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

    // Then the cache was still dropped: the lock release invalidates on every
    // operation, so freshness never depends on guessing what mutated
    const after = await service.inventoryCached()
    expect(after.hit).toBe(false)
  })
})
