// @vitest-environment node
/**
 * B′ journal self-tests (archive-audit-journal-1114): every case runs against
 * a disposable fixture home (mkdtemp) — no real workspace archive action ever
 * touches the running system (AGENTS sandbox rule, 2026-10-24 incident).
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveService } from '../src/host/janitor.ts'
import { appendJournal, type JournalEvent } from '../src/host/journal.ts'
import { writeJsonAtomic } from '../src/host/ledger.ts'
import { createFakeHost, fakeContext, type FakeHost } from './fixtures.ts'

const DAY = 86_400_000

interface JournalRow {
  id: string
  op: string
  at: number
  actor?: string
  entry?: Record<string, unknown>
}

function makeService(host: FakeHost): ArchiveService {
  return new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
}

async function settledService(host: FakeHost, config: Record<string, unknown> = {}): Promise<ArchiveService> {
  const service = makeService(host)
  service.applyConfig({ enabled: true, ...config })
  await service.start()
  return service
}

function journalPath(host: FakeHost): string {
  return join(host.home, 'dsh-session-archive', 'archive-events.jsonl')
}

function readRows(path: string): JournalRow[] {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (raw.trim() === '') return []
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JournalRow)
}

describe('archive event journal (B′)', () => {
  it('keeps exactly one monotonic row per operation across archive → unarchive → re-archive', async () => {
    const host = createFakeHost({ feedItems: [{ sessionId: 'session-a', updatedAt: 1 }], persistedIds: ['session-a'] })
    const service = await settledService(host)
    try {
      const t0 = Date.now()
      const first = await service.archive(['session-a'], 'manual', undefined, 'manual-test')
      const t1 = Date.now()
      const undone = await service.unarchive(['session-a'])
      const t2 = Date.now()
      const again = await service.archive(['session-a'], 'manual', undefined, 'manual-test')
      const t3 = Date.now()
      expect(first.results).toEqual([{ id: 'session-a', status: 'ok' }])
      expect(undone.results).toEqual([{ id: 'session-a', status: 'ok' }])
      expect(again.results).toEqual([{ id: 'session-a', status: 'ok' }])

      const rows = readRows(journalPath(host))
      expect(rows).toHaveLength(3)
      expect(rows.map((row) => row.op)).toEqual(['archive', 'unarchive', 'archive'])
      for (const row of rows) {
        expect(row.id).toBe('session-a')
        expect(typeof row.at).toBe('number')
        expect(Number.isFinite(row.at)).toBe(true)
      }
      // First row = the first archive's own moment, never overwritten by the re-archive.
      expect(rows[0].at).toBeGreaterThanOrEqual(t0)
      expect(rows[0].at).toBeLessThanOrEqual(t1)
      // Strictly increasing across the three operations (+2ms nudge allowance).
      expect(rows[1].at).toBeGreaterThan(rows[0].at)
      expect(rows[2].at).toBeGreaterThan(rows[1].at)
      expect(rows[2].at).toBeGreaterThanOrEqual(t2)
      expect(rows[2].at).toBeLessThanOrEqual(t3 + 2)
      // Actor travels on REST archive rows, none on unarchive rows.
      expect(rows[0].actor).toBe('manual-test')
      expect(rows[2].actor).toBe('manual-test')
      expect(rows[1].actor).toBeUndefined()
    } finally {
      service.stop()
    }
  })

  it('snapshots the full pre-delete entry on unarchive (seal/reason/actor survive the erase)', async () => {
    const host = createFakeHost({
      feedItems: [{ sessionId: 'session-a', updatedAt: 1 }],
      persistedIds: ['session-a'],
      archivedSessionIds: ['session-a'],
    })
    await writeJsonAtomic(join(host.home, 'dsh-session-archive', 'archive-ledger.json'), {
      version: 1,
      entries: {
        'session-a': {
          archivedAt: 1_700_000_000_000,
          source: 'override',
          reason: 'judge-said-no-xyz',
          seal: 'UNSEALED:no transcript',
          actor: 'session-judge-abc',
        },
      },
    })
    const service = await settledService(host)
    try {
      const response = await service.unarchive(['session-a'])
      expect(response.results).toEqual([{ id: 'session-a', status: 'ok' }])
      expect(service.ledgerSnapshot().entries['session-a']).toBeUndefined()

      const raw = readFileSync(journalPath(host), 'utf8')
      const row = readRows(journalPath(host))[0]
      expect(row.op).toBe('unarchive')
      // Raw grep over the JSONL line: every field the delete erased is in it.
      expect(raw).toContain('judge-said-no-xyz')
      expect(raw).toContain('UNSEALED:no transcript')
      expect(raw).toContain('session-judge-abc')
      expect(raw).toContain('"source":"override"')
      expect(row.entry).toMatchObject({
        archivedAt: 1_700_000_000_000,
        source: 'override',
        reason: 'judge-said-no-xyz',
        seal: 'UNSEALED:no transcript',
        actor: 'session-judge-abc',
      })
    } finally {
      service.stop()
    }
  })

  it('fails open when the journal path is unwritable: warn only, archive result intact', async () => {
    const host = createFakeHost({ feedItems: [{ sessionId: 'session-a', updatedAt: 1 }], persistedIds: ['session-a'] })
    // EISDIR trap: a directory squatting on the journal path makes every append fail.
    mkdirSync(join(host.home, 'dsh-session-archive', 'archive-events.jsonl'), { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const service = await settledService(host)
      const response = await service.archive(['session-a'], 'manual', undefined, 'manual-test')
      expect(response.results).toEqual([{ id: 'session-a', status: 'ok' }])
      expect(host.registry.archivedSessionIds).toEqual(['session-a'])
      expect(service.ledgerSnapshot().entries['session-a']).toBeDefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('journal append failed'))
      service.stop()
    } finally {
      warn.mockRestore()
    }
  })

  it('writes one row per successful id in a batch, skips add nothing, and creates no snapshot files', async () => {
    const host = createFakeHost({
      feedItems: [
        { sessionId: 'session-a', updatedAt: 1 },
        { sessionId: 'session-b', updatedAt: 2 },
        { sessionId: 'session-c', updatedAt: 3 },
      ],
      persistedIds: ['session-a', 'session-b', 'session-c'],
    })
    const service = await settledService(host)
    try {
      const batch = await service.archive(['session-a', 'session-b', 'session-c'], 'manual', undefined, 'manual-test')
      expect(batch.results.filter((result) => result.status === 'ok')).toHaveLength(3)
      expect(readRows(journalPath(host))).toHaveLength(3)

      // Re-batch: every id skips (already-archived) → zero new rows.
      const repeat = await service.archive(['session-a', 'session-b'], 'manual', undefined, 'manual-test')
      expect(repeat.results.every((result) => result.status === 'skipped')).toBe(true)
      expect(readRows(journalPath(host))).toHaveLength(3)

      // Negative (user-named): the batch produced no snapshot/backup files —
      // only the ledger, the journal and (maybe) the run state.
      const files = readdirSync(join(host.home, 'dsh-session-archive'))
      expect(files).toContain('archive-ledger.json')
      expect(files).toContain('archive-events.jsonl')
      expect(files.filter((file) => /bak|snap|\.1$|\.tmp/i.test(file))).toEqual([])
    } finally {
      service.stop()
    }
  })

  it('touches no file at all for an all-skipped batch', async () => {
    const host = createFakeHost({ feedItems: [{ sessionId: 'session-a', updatedAt: 1 }], persistedIds: ['session-a'] })
    const service = await settledService(host)
    try {
      const response = await service.unarchive(['session-a']) // not archived → skipped
      expect(response.results).toEqual([{ id: 'session-a', status: 'skipped', reason: 'not-archived' }])
      expect(existsSync(journalPath(host))).toBe(false)
    } finally {
      service.stop()
    }
  })

  it('journals auto-cycle archives as op=archive without an actor', async () => {
    const host = createFakeHost({
      feedItems: [{ sessionId: 'session-stale', updatedAt: Date.now() - 40 * DAY }],
      persistedIds: ['session-stale'],
    })
    const service = await settledService(host, { autoArchiveEnabled: true, autoArchiveDays: 30 })
    try {
      const stats = await service.runAutoCycle('archive', undefined)
      expect(stats.ok).toBe(1)
      const rows = readRows(journalPath(host))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: 'session-stale', op: 'archive', entry: { source: 'auto' } })
      expect(rows[0].actor).toBeUndefined()
    } finally {
      service.stop()
    }
  })
})

describe('appendJournal writer', () => {
  it('rolls the journal at the size threshold, keeping one generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-journal-roll-'))
    const path = join(dir, 'archive-events.jsonl')
    const oldRow: JournalEvent = { id: 'session-old', op: 'archive', at: 1 }
    const newRow: JournalEvent = { id: 'session-new', op: 'unarchive', at: 2 }
    // The first row alone passes rollBytes, so the next append must roll it to .1.
    await appendJournal(path, [oldRow], { rollBytes: 40 })
    await appendJournal(path, [newRow], { rollBytes: 40 })
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('session-old')
    const current = readFileSync(path, 'utf8')
    expect(current).toContain('session-new')
    expect(current).not.toContain('session-old')
  })

  it('warns but still appends when the roll rename fails (fail-open)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-journal-roll-fail-'))
    const path = join(dir, 'archive-events.jsonl')
    writeFileSync(path, 'x'.repeat(100), 'utf8')
    mkdirSync(`${path}.1`) // destination is a directory → rename must fail
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        appendJournal(path, [{ id: 'session-a', op: 'archive', at: 3 }], { rollBytes: 40 }),
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('journal roll failed'))
      expect(readFileSync(path, 'utf8')).toContain('session-a')
    } finally {
      warn.mockRestore()
    }
  })
})
