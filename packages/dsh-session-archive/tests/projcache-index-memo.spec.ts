// @vitest-environment node
/**
 * The projection-cache index memo (ARC-1): every inventory pass used to
 * re-read and re-parse the whole `storages/session_projcache.json`, while the
 * far larger directory walk of the same pass was already reused. These cases
 * pin the replacement — one parse per burst window, a fresh parse once the
 * window lapses, explicit invalidation after the delete pipeline rewrites the
 * index, no ghost rows, and a parse failure that still degrades to an empty
 * table instead of resurrecting the last good parse.
 *
 * Reuse is observed from the document the pass returns, never from a timer and
 * never from a patched module graph: the harness file is rewritten between two
 * passes, and the pass that reused its parse keeps answering with the facts it
 * paid for while a pass reading the file for itself sees the rewrite. The
 * service-level case therefore rests on the action's passes landing inside the
 * production window (they are milliseconds apart); each window rule itself
 * (lapse, invalidation, a clock that steps back) is pinned with an injected
 * clock, so no case asks a measured duration to say anything. Since the read
 * went async (task #inventory-perf-1030) the memo is an `AsyncTtlMemo`: the
 * same window rules plus single-flight coalescing and an invalidation that
 * wins over a parse already in flight.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveService } from '../src/host/janitor.ts'
import { buildInventory, readProjcacheIndex, type ProjcacheIndex } from '../src/host/inventory.ts'
import { writeJsonAtomic } from '../src/host/ledger.ts'
import { AsyncTtlMemo } from '../src/host/ttl-memo.ts'
import { createFakeHost, fakeContext, writeProjcache } from './fixtures.ts'

const INDEX_SUFFIX = join('storages', 'session_projcache.json')

/** A DSH home holding only the storages directory the index lives in. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-projcache-index-'))
  mkdirSync(join(home, 'storages'), { recursive: true })
  return home
}

describe('Given one user action that issues several inventory passes', () => {
  it('operator reuses the index parse it already paid for while the window is open', async () => {
    // Given a service whose index titles one session
    const host = createFakeHost({
      feedItems: [
        { sessionId: 'session-a', updatedAt: 10 },
        { sessionId: 'session-b', updatedAt: 9 },
      ],
      dirs: ['session-a', 'session-b'],
    })
    writeProjcache(host.home, {
      'session-a': { title: 'Alpha', createdAt: 1 },
      'session-b': { title: 'Beta', createdAt: 2 },
    })
    const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
    await service.start()
    const first = await service.inventory()

    // When the harness rewrites the index and the next pass of the same action
    // runs inside the window
    writeProjcache(host.home, {
      'session-a': { title: 'Amended', createdAt: 1 },
      'session-b': { title: 'Beta', createdAt: 2 },
    })
    const second = await service.inventory()

    // Then that pass never re-read the file: it answers with the parse it paid
    // for, while a pass reading the index for itself does see the rewrite
    expect(first.rows.map((row) => row.title)).toEqual(['Alpha', 'Beta'])
    expect(second.rows.map((row) => row.title)).toEqual(['Alpha', 'Beta'])
    const readingForItself = await buildInventory(host.sources(), AbortSignal.timeout(5_000))
    expect(readingForItself.rows.map((row) => row.title)).toEqual(['Amended', 'Beta'])
  })
})

describe('Given a physical delete inside the memo window', () => {
  it('operator never sees the deleted session facts resurface on the next pass', async () => {
    // Given a session whose directory and index entry exist and were listed
    const host = createFakeHost({
      feedItems: [{ sessionId: 'session-del', updatedAt: 10 }],
      persistedIds: ['session-del'],
      archivedSessionIds: ['session-del'],
    })
    mkdirSync(join(host.home, 'sessions', '--demo--', 'del'), { recursive: true })
    writeFileSync(join(host.home, 'sessions', '--demo--', 'del', 'session.jsonl.zstd'), Buffer.alloc(64, 1))
    writeProjcache(host.home, { 'session-del': { title: 'Doomed', createdAt: 5 } })
    await writeJsonAtomic(join(host.home, 'dsh-session-archive', 'archive-ledger.json'), {
      version: 1,
      entries: { 'session-del': { archivedAt: 123, source: 'manual' } },
    })
    const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
    await service.start()
    const before = await service.inventory()
    expect(before.rows[0]?.title).toBe('Doomed')

    // When the session is physically deleted and another pass follows at once
    const response = await service.deleteSessions(['session-del'], { expectedTotal: 1 })
    const after = await service.inventory()

    // Then the pass no longer answers with the removed session's facts
    expect(response.results).toEqual([{ id: 'session-del', status: 'ok' }])
    expect(after.rows[0]?.title).toBeUndefined()
    expect(after.rows[0]?.createdAt).toBeUndefined()
  })
})

describe('Given an index that mentions sessions with no storage and no feed row', () => {
  it('operator gets no ghost row out of the memo either', async () => {
    // Given an index entry for a session that exists nowhere on disk or in the feed
    const host = createFakeHost({ feedItems: [], dirs: ['session-real'] })
    writeProjcache(host.home, { 'session-ghost': { title: 'Ghost', createdAt: 1 } })
    const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
    await service.start()

    // When two passes read the memoized index
    const first = await service.inventory()
    const second = await service.inventory()

    // Then only the on-disk session becomes a row
    expect(first.rows.map((row) => row.id)).toEqual(['session-real'])
    expect(second.rows.map((row) => row.id)).toEqual(['session-real'])
  })
})

describe('Given the same fixture read with and without the memo', () => {
  it('operator gets identical rows, in identical order', async () => {
    // Given a home mixing feed rows, disk-only rows, an archived row and an
    // index entry for a session that no longer exists
    const host = createFakeHost({
      feedItems: [
        { sessionId: 'session-a', updatedAt: 30, cwd: '/Users/demo' },
        { sessionId: 'session-b', updatedAt: 20, parentSessionId: 'session-a' },
        { sessionId: 'session-gone', updatedAt: 10 },
      ],
      dirs: ['session-a', 'session-disk', 'session-gone'],
      archivedSessionIds: ['session-disk'],
      workspaces: [{ id: 'ws-1', path: '/Users/demo', title: 'Demo', sessionIds: ['session-a', 'session-b'] }],
    })
    writeProjcache(host.home, {
      'session-a': { title: 'Alpha', createdAt: 1 },
      'session-b': { title: 'Beta', createdAt: 2 },
      'session-gone': { title: 'Gone', createdAt: 3 },
    })
    const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
    await service.start()

    // When the service pass (memoized index, reused walk) and a pass that
    // derives both for itself assemble the same fixture
    const viaService = await service.inventory()
    const direct = await buildInventory(host.sources(), AbortSignal.timeout(5_000))

    // Then the documents agree, row set and order included
    expect(viaService.rows).toEqual(direct.rows)
    expect(viaService.workspaces).toEqual(direct.workspaces)
    expect(viaService.archivedSessionIds).toEqual(direct.archivedSessionIds)
    expect(viaService.rows.map((row) => row.id)).toEqual([
      'session-a',
      'session-b',
      'session-gone',
      'session-disk',
    ])
  })
})

describe('Given the memo that serves the projection-cache index', () => {
  it('operator pays for one parse inside the window and a fresh one after it lapses', async () => {
    // Given an index and a memo with an injected clock
    const home = makeHome()
    writeProjcache(home, { 'session-a': { title: 'Alpha', createdAt: 1 } })
    let clock = 1_000
    const memo = new AsyncTtlMemo<ProjcacheIndex>({ ttlMs: 2_000, load: () => readProjcacheIndex(home), now: () => clock })

    // When two reads land inside the window
    const first = await memo.get()
    clock += 1_500
    const second = await memo.get()

    // Then one parse served them both, and the harness file only lands once
    expect(memo.loads).toBe(1)
    expect(second).toBe(first)
    expect(Object.keys(second.sessions)).toEqual(['session-a'])

    // When the window lapses and the file changed underneath
    clock += 600
    writeProjcache(home, { 'session-b': { title: 'Beta', createdAt: 2 } })
    const refreshed = await memo.get()

    // Then the new content is parsed, not the retained one
    expect(memo.loads).toBe(2)
    expect(Object.keys(refreshed.sessions)).toEqual(['session-b'])
  })

  it('operator sees an explicit invalidation force the next parse', async () => {
    // Given a memo that already served a read
    const home = makeHome()
    writeProjcache(home, { 'session-a': { title: 'Alpha', createdAt: 1 } })
    const memo = new AsyncTtlMemo<ProjcacheIndex>({ ttlMs: 60_000, load: () => readProjcacheIndex(home), now: () => 1_000 })
    await memo.get()

    // When the owner invalidates it
    memo.invalidate()
    await memo.get()

    // Then the index was parsed again
    expect(memo.loads).toBe(2)
  })

  it('operator gets a parse, never a stale value, when the clock steps backwards', async () => {
    // Given a memo holding a value
    const home = makeHome()
    writeProjcache(home, { 'session-a': { title: 'Alpha', createdAt: 1 } })
    let clock = 5_000
    const memo = new AsyncTtlMemo<ProjcacheIndex>({ ttlMs: 2_000, load: () => readProjcacheIndex(home), now: () => clock })
    await memo.get()

    // When the clock jumps back inside the nominal window
    clock = 4_000
    await memo.get()

    // Then the value is not trusted as fresh
    expect(memo.loads).toBe(2)
  })

  it('operator gets an empty table when the index is unparseable, never the last good parse', async () => {
    // Given a parse that succeeded once
    const home = makeHome()
    writeProjcache(home, { 'session-a': { title: 'Alpha', createdAt: 1 } })
    let clock = 1_000
    const memo = new AsyncTtlMemo<ProjcacheIndex>({ ttlMs: 2_000, load: () => readProjcacheIndex(home), now: () => clock })
    expect(Object.keys((await memo.get()).sessions)).toEqual(['session-a'])

    // When the file is corrupted and the window lapses
    writeFileSync(join(home, INDEX_SUFFIX), '{ truncated')
    clock += 2_001
    const degraded = await memo.get()

    // Then the pass degrades to an empty index rather than the stale one
    expect(degraded.sessions).toEqual({})
    clock += 1
    expect((await memo.get()).sessions).toEqual({})
  })

  it('operator gets an empty table from a missing index file as well', async () => {
    // Given a home with no index file at all
    const home = makeHome()

    // When a memo reads it
    const memo = new AsyncTtlMemo<ProjcacheIndex>({ ttlMs: 2_000, load: () => readProjcacheIndex(home), now: () => 1_000 })

    // Then the pass sees an empty table
    expect((await memo.get()).sessions).toEqual({})
  })

  it('operator never gets a pre-invalidation parse retained when invalidation lands mid-parse', async () => {
    // Given a memo whose parse is held mid-flight over the content it read
    // (the delete pipeline invalidates the memo before it rewrites the index,
    // which can overlap a pass that is still reading the old content)
    const home = makeHome()
    writeProjcache(home, { 'session-a': { title: 'Doomed', createdAt: 1 } })
    let signalRead: (() => void) | undefined
    const readDone = new Promise<void>((resolve) => { signalRead = resolve })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const memo = new AsyncTtlMemo<ProjcacheIndex>({
      ttlMs: 60_000,
      load: async () => {
        // Parse the file first, then hold mid-flight: the value awaiting is
        // the pre-invalidation content, exactly what a real overlap reads.
        const parsed = await readProjcacheIndex(home)
        signalRead?.()
        await gate
        return parsed
      },
      now: () => 1_000,
    })

    // When the parse holds the old content and the owner invalidates, then
    // rewrites the index, before the parse lands
    const inFlight = memo.get()
    await readDone
    memo.invalidate()
    writeProjcache(home, {})
    release?.()
    const abandoned = await inFlight

    // Then the pre-invalidation parse is served to its own reader but never
    // retained: the next read parses the rewritten file
    expect(Object.keys(abandoned.sessions)).toEqual(['session-a'])
    expect(memo.loads).toBe(1)
    const next = await memo.get()
    expect(memo.loads).toBe(2)
    expect(next.sessions).toEqual({})
  })

  it('operator readers arriving during one parse join it instead of starting their own', async () => {
    // Given a memo whose parse is gated
    const home = makeHome()
    writeProjcache(home, { 'session-a': { title: 'Alpha', createdAt: 1 } })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const memo = new AsyncTtlMemo<ProjcacheIndex>({
      ttlMs: 60_000,
      load: async () => {
        await gate
        return readProjcacheIndex(home)
      },
      now: () => 1_000,
    })

    // When three readers arrive while the first parse runs
    const first = memo.get()
    const second = memo.get()
    const third = memo.get()
    release?.()
    const results = await Promise.all([first, second, third])

    // Then one parse served all three
    expect(memo.loads).toBe(1)
    expect(results[1]).toBe(results[0])
    expect(results[2]).toBe(results[0])
  })
})
