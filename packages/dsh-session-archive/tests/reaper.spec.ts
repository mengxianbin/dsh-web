// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ArchiveService } from '../src/host/janitor.ts'
import { writeJsonAtomic, type LedgerDocument, type LedgerEntry } from '../src/host/ledger.ts'
import { REAP_IDLE_MS, runReapCycle, type ReaperDeps } from '../src/host/reaper.ts'
import { unarchiveSessions } from '../src/host/workspace-store.ts'
import { createFakeHost, fakeContext, type FakeHost, type FeedItem } from './fixtures.ts'

const DAY = 86_400_000
const NOW = 1_700_000_000_000

function makeService(host: FakeHost, config: Record<string, unknown> = {}): ArchiveService {
  const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
  service.applyConfig({ enabled: true, ...config })
  return service
}

async function settledService(host: FakeHost, config?: Record<string, unknown>): Promise<ArchiveService> {
  const service = makeService(host, config)
  await service.start()
  return service
}

/** Seed the on-disk ledger BEFORE start (the service loads once); actor included. */
async function seedLedger(host: FakeHost, entries: Record<string, LedgerEntry>): Promise<void> {
  await writeJsonAtomic(join(host.home, 'dsh-session-archive', 'archive-ledger.json'), { version: 1, entries })
}

interface FixtureOptions {
  now?: number
  items?: unknown[]
  archived?: string[]
  hostTimes?: Record<string, number>
  entries?: Record<string, LedgerEntry>
  protectedIds?: string[]
  feedError?: boolean
  flushError?: boolean
  archiveErrorIds?: string[]
  /** Archiving a key also archives these ids — simulates the harness cascade. */
  cascade?: Record<string, string[]>
}

/** Hand-built ReaperDeps for the pure passes — no service, no disk. */
function makeFixture(options: FixtureOptions = {}) {
  const ledger: LedgerDocument = { version: 1, entries: { ...(options.entries ?? {}) } }
  const archived = [...(options.archived ?? [])]
  const hostTimes = { ...(options.hostTimes ?? {}) }
  const archiveCalls: string[] = []
  let listCalls = 0
  let now = options.now ?? NOW
  const deps: ReaperDeps = {
    now: () => now,
    listFeed: async () => {
      listCalls += 1
      if (options.feedError) throw new Error('feed down')
      return { items: options.items ?? [] }
    },
    archivedSessionIds: () => archived,
    archivedAtById: () => hostTimes,
    protectedIds: new Set(options.protectedIds ?? []),
    ledger,
    archive: async (nativeId) => {
      if (options.archiveErrorIds?.includes(nativeId)) throw new Error(`refused: ${nativeId}`)
      archiveCalls.push(nativeId)
      archived.push(nativeId)
      for (const child of options.cascade?.[nativeId] ?? []) archived.push(child)
    },
    flushLedger: async () => {
      if (options.flushError) throw new Error('disk full')
    },
  }
  return {
    deps,
    ledger,
    archived,
    hostTimes,
    archiveCalls,
    get listCalls(): number {
      return listCalls
    },
  }
}

function sub(id: string, parent: string, updatedAt: number): FeedItem {
  return { sessionId: id, origin: 'subagent', parentSessionId: parent, updatedAt }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reaper: idle subagent reaping (design §四)', () => {
  it('archives an idle subagent through the seam and writes its ledger entry', async () => {
    const f = makeFixture({
      now: NOW,
      items: [
        { sessionId: 'session-p', updatedAt: NOW },
        sub('session-sub', 'session-p', NOW - 3 * DAY),
      ],
    })
    const stats = await runReapCycle(f.deps)
    expect(stats).toEqual({ reaped: 1, reconciled: 0 })
    expect(f.archiveCalls).toEqual(['session-sub'])
    expect(f.archived).toContain('session-sub')
    expect(f.ledger.entries['session-sub']).toEqual({ archivedAt: NOW, source: 'auto', actor: 'reaper', reason: 'idle-2d' })
  })

  it('leaves a subagent that has not crossed the 2-day idle line', async () => {
    const f = makeFixture({ now: NOW, items: [sub('session-sub', 'session-p', NOW - REAP_IDLE_MS + 60_000)] })
    const stats = await runReapCycle(f.deps)
    expect(stats).toEqual({ reaped: 0, reconciled: 0 })
    expect(f.archiveCalls).toEqual([])
    expect(f.ledger.entries['session-sub']).toBeUndefined()
  })

  it('nets only idle unprotected unarchived subagents — top-level, fresh, running, live and archived stay put', async () => {
    const f = makeFixture({
      now: NOW,
      protectedIds: ['session-live'],
      archived: ['session-done'],
      items: [
        { sessionId: 'session-top', updatedAt: NOW - 3 * DAY },
        sub('session-fresh', 'session-p', NOW - DAY),
        { ...sub('session-run', 'session-p', NOW - 3 * DAY), running: true },
        sub('session-live', 'session-p', NOW - 3 * DAY),
        sub('session-done', 'session-p', NOW - 3 * DAY),
        sub('session-go', 'session-p', NOW - 3 * DAY),
      ],
    })
    const stats = await runReapCycle(f.deps)
    expect(stats).toEqual({ reaped: 1, reconciled: 0 })
    expect(f.archiveCalls).toEqual(['session-go'])
    expect(Object.keys(f.ledger.entries)).toEqual(['session-go'])
    expect(f.ledger.entries['session-go']).toEqual({ archivedAt: NOW, source: 'auto', actor: 'reaper', reason: 'idle-2d' })
  })

  it('inherits the actor from the parent ledger entry', async () => {
    const f = makeFixture({
      now: NOW,
      entries: { 'session-p': { archivedAt: NOW - DAY, source: 'manual', actor: 'manual-test' } },
      items: [sub('session-sub', 'session-p', NOW - 3 * DAY)],
    })
    await runReapCycle(f.deps)
    expect(f.ledger.entries['session-sub']).toEqual({ archivedAt: NOW, source: 'auto', actor: 'manual-test', reason: 'idle-2d' })
  })

  it('logs a refused archive, writes no entry for it, and keeps reaping the rest', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const f = makeFixture({
      now: NOW,
      archiveErrorIds: ['session-bad'],
      items: [
        sub('session-bad', 'session-p', NOW - 3 * DAY),
        sub('session-good', 'session-p', NOW - 3 * DAY),
      ],
    })
    const stats = await runReapCycle(f.deps)
    expect(stats.reaped).toBe(1)
    expect(f.archiveCalls).toEqual(['session-good'])
    expect(f.ledger.entries['session-bad']).toBeUndefined()
    expect(f.ledger.entries['session-good']).toBeDefined()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("reaper archive of 'session-bad' failed"))
  })

  it('propagates a feed failure so the caller leaves its throttle unset', async () => {
    const f = makeFixture({ feedError: true })
    await expect(runReapCycle(f.deps)).rejects.toThrow('feed down')
  })

  it('propagates a ledger flush failure with the entries kept in memory for the retry', async () => {
    const f = makeFixture({
      now: NOW,
      flushError: true,
      items: [sub('session-sub', 'session-p', NOW - 3 * DAY)],
    })
    await expect(runReapCycle(f.deps)).rejects.toThrow('disk full')
    expect(f.ledger.entries['session-sub']).toBeDefined()
  })
})

describe('reaper: cascade ledger reconcile (design §五)', () => {
  const HOST_AT = NOW + 500_000

  it('backfills a cascade child with the host time and the parent actor', async () => {
    const f = makeFixture({
      archived: ['session-p', 'session-c'],
      hostTimes: { 'session-c': HOST_AT },
      entries: { 'session-p': { archivedAt: HOST_AT - 5_000, source: 'manual', actor: 'manual-test' } },
      items: [{ sessionId: 'session-p', updatedAt: 1 }, sub('session-c', 'session-p', 1)],
    })
    const stats = await runReapCycle(f.deps)
    expect(stats).toEqual({ reaped: 0, reconciled: 1 })
    expect(f.ledger.entries['session-c']).toEqual({ archivedAt: HOST_AT, source: 'auto', actor: 'manual-test', reason: 'cascade' })
  })

  it("falls back to actor 'cascade' when the archived parent has no entry", async () => {
    const f = makeFixture({
      archived: ['session-p', 'session-c'],
      hostTimes: { 'session-c': HOST_AT },
      items: [{ sessionId: 'session-p', updatedAt: 1 }, sub('session-c', 'session-p', 1)],
    })
    await runReapCycle(f.deps)
    expect(f.ledger.entries['session-c']).toEqual({ archivedAt: HOST_AT, source: 'auto', actor: 'cascade', reason: 'cascade' })
  })

  it('skips a child whose parent is still alive (native direct archive, not a cascade product)', async () => {
    const f = makeFixture({
      archived: ['session-c'],
      hostTimes: { 'session-c': HOST_AT },
      items: [sub('session-c', 'session-p', 1)],
    })
    const stats = await runReapCycle(f.deps)
    expect(stats).toEqual({ reaped: 0, reconciled: 0 })
    expect(f.ledger.entries['session-c']).toBeUndefined()
  })

  it('skips a gap without a host stamp rather than fabricating a time', async () => {
    const f = makeFixture({
      archived: ['session-p', 'session-c'],
      hostTimes: {},
      entries: { 'session-p': { archivedAt: 1, source: 'manual', actor: 'manual-test' } },
      items: [{ sessionId: 'session-p', updatedAt: 1 }, sub('session-c', 'session-p', 1)],
    })
    const stats = await runReapCycle(f.deps)
    expect(stats.reconciled).toBe(0)
    expect(f.ledger.entries['session-c']).toBeUndefined()
  })

  it('leaves an entry that already exists untouched (idempotent dedupe)', async () => {
    const existing: LedgerEntry = { archivedAt: 1, source: 'manual', actor: 'someone' }
    const f = makeFixture({
      archived: ['session-p', 'session-c'],
      hostTimes: { 'session-c': HOST_AT },
      entries: { 'session-c': existing },
      items: [{ sessionId: 'session-p', updatedAt: 1 }, sub('session-c', 'session-p', 1)],
    })
    const stats = await runReapCycle(f.deps)
    expect(stats).toEqual({ reaped: 0, reconciled: 0 })
    expect(f.ledger.entries['session-c']).toEqual(existing)
  })

  it('fills same-round gaps parent-first so a grandchild inherits the real actor', async () => {
    const hostChild = NOW + 100_000
    const hostGrand = NOW + 200_000
    const f = makeFixture({
      archived: ['session-p', 'session-c', 'session-g'],
      hostTimes: { 'session-c': hostChild, 'session-g': hostGrand },
      entries: { 'session-p': { archivedAt: 1, source: 'manual', actor: 'alice' } },
      items: [
        sub('session-g', 'session-c', 1), // grandchild listed first — forces the wave
        sub('session-c', 'session-p', 1),
        { sessionId: 'session-p', updatedAt: 1 },
      ],
    })
    const stats = await runReapCycle(f.deps)
    expect(stats.reconciled).toBe(2)
    expect(f.ledger.entries['session-c']).toEqual({ archivedAt: hostChild, source: 'auto', actor: 'alice', reason: 'cascade' })
    expect(f.ledger.entries['session-g']).toEqual({ archivedAt: hostGrand, source: 'auto', actor: 'alice', reason: 'cascade' })
  })

  it('resolves a corrupt self-parent gap with the fallback instead of looping', async () => {
    const f = makeFixture({
      archived: ['session-x'],
      hostTimes: { 'session-x': HOST_AT },
      items: [{ sessionId: 'session-x', origin: 'subagent', parentSessionId: 'session-x', updatedAt: 1 }],
    })
    const stats = await runReapCycle(f.deps)
    expect(stats.reconciled).toBe(1)
    expect(f.ledger.entries['session-x']).toEqual({ archivedAt: HOST_AT, source: 'auto', actor: 'cascade', reason: 'cascade' })
  })

  it('labels a child the harness cascade carried during the reap as cascade, not idle-2d', async () => {
    const f = makeFixture({
      now: NOW,
      hostTimes: { 'session-b': HOST_AT },
      cascade: { 'session-a': ['session-b'] },
      items: [
        sub('session-a', 'session-p', NOW - 3 * DAY),
        sub('session-b', 'session-a', NOW - 3 * DAY),
      ],
    })
    const stats = await runReapCycle(f.deps)
    expect(stats).toEqual({ reaped: 1, reconciled: 1 })
    expect(f.archiveCalls).toEqual(['session-a'])
    expect(f.ledger.entries['session-a']).toEqual({ archivedAt: NOW, source: 'auto', actor: 'reaper', reason: 'idle-2d' })
    expect(f.ledger.entries['session-b']).toEqual({ archivedAt: HOST_AT, source: 'auto', actor: 'reaper', reason: 'cascade' })
  })
})

describe('reaper service wiring (design §四/§八)', () => {
  it('runs from the service: seam archive + persisted entry, no journal row', async () => {
    const now = Date.now()
    const host = createFakeHost({
      feedItems: [
        { sessionId: 'session-p', updatedAt: now },
        sub('session-sub', 'session-p', now - 3 * DAY),
      ],
    })
    const service = await settledService(host)
    await service.reapIdleSubagents()

    expect(host.registry.archivedSessionIds).toEqual(['session-sub'])
    expect(service.ledgerSnapshot().entries['session-sub']).toEqual({
      archivedAt: expect.any(Number),
      source: 'auto',
      actor: 'reaper',
      reason: 'idle-2d',
    })
    const onDisk = JSON.parse(readFileSync(join(host.home, 'dsh-session-archive', 'archive-ledger.json'), 'utf8')) as LedgerDocument
    expect(onDisk.entries['session-sub']?.reason).toBe('idle-2d')
    // reaper deliberately writes no journal rows (design §四 journal 交互 decision)
    expect(existsSync(join(host.home, 'dsh-session-archive', 'archive-events.jsonl'))).toBe(false)
  })

  it('scans at most once per 24h and retries immediately after a failed scan', async () => {
    const host = createFakeHost({ feedItems: [{ sessionId: 'session-p', updatedAt: Date.now() }] })
    const ctx = fakeContext(host) as { get(name: string): unknown }
    const service = new ArchiveService(ctx as never, { dshHome: host.home })
    service.applyConfig({ enabled: true })
    await service.start()
    const controller = ctx.get('sessionController') as { list(): Promise<{ items?: unknown[] }> }
    const realList = controller.list.bind(controller)

    controller.list = async () => {
      throw new Error('feed down')
    }
    await expect(service.reapIdleSubagents()).rejects.toThrow('feed down')
    controller.list = realList

    // The failed scan left the throttle unset, so this retry runs and reaps.
    host.feedItems.push(sub('session-sub', 'session-p', Date.now() - 3 * DAY))
    await service.reapIdleSubagents()
    expect(host.registry.archivedSessionIds).toContain('session-sub')

    // Within 24h the throttle holds: another idle subagent stays untouched.
    host.feedItems.push(sub('session-sub2', 'session-p', Date.now() - 3 * DAY))
    await service.reapIdleSubagents()
    expect(host.registry.archivedSessionIds).not.toContain('session-sub2')
  })

  it('respects live-store protection through protectedReason', async () => {
    const host = createFakeHost({
      feedItems: [sub('session-sub', 'session-p', Date.now() - 3 * DAY)],
      liveIds: ['session-sub'],
    })
    const service = await settledService(host)
    await service.reapIdleSubagents()
    expect(host.registry.archivedSessionIds).toEqual([])
    expect(service.ledgerSnapshot().entries['session-sub']).toBeUndefined()
  })

  it('backfills a post-cascade child in the service with the seeded parent actor', async () => {
    const hostTime = Date.now() - 1_000
    const host = createFakeHost({
      feedItems: [
        { sessionId: 'session-p', updatedAt: Date.now() },
        sub('session-c', 'session-p', Date.now()),
      ],
      archivedSessionIds: ['session-p', 'session-c'],
      archivedAtById: { 'session-c': hostTime },
    })
    await seedLedger(host, { 'session-p': { archivedAt: hostTime - 5_000, source: 'manual', actor: 'manual-test' } })
    const service = await settledService(host)
    await service.reapIdleSubagents()

    expect(service.ledgerSnapshot().entries['session-c']).toEqual({
      archivedAt: hostTime,
      source: 'auto',
      actor: 'manual-test',
      reason: 'cascade',
    })
    // Nothing was reaped: both rows were already archived.
    expect(service.ledgerSnapshot().entries['session-p']?.actor).toBe('manual-test')
  })

  it('unarchive does not cascade to children (design §六)', async () => {
    const host = createFakeHost({
      feedItems: [
        { sessionId: 'session-p', updatedAt: 1 },
        sub('session-c', 'session-p', 1),
      ],
      archivedSessionIds: ['session-p', 'session-c'],
    })
    await unarchiveSessions(host.registry, ['session-p'])
    expect(host.registry.archivedSessionIds).toEqual(['session-c'])
  })
})
