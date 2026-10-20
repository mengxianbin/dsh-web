// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { capEntries, deserializeAutoState, deserializeLedger, writeJsonAtomic } from '../src/host/ledger.ts'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('ledger serialization', () => {
  it('round-trips entries', () => {
    const doc = { version: 1 as const, entries: { 'session-a': { archivedAt: 123, source: 'auto' as const } } }
    const restored = deserializeLedger(JSON.stringify(doc))
    expect(restored).toEqual(doc)
  })

  it('starts fresh on corrupt or foreign documents', () => {
    expect(deserializeLedger('not json at all')).toEqual({ version: 1, entries: {} })
    expect(deserializeLedger('{"version":2,"entries":{}}')).toEqual({ version: 1, entries: {} })
    expect(deserializeLedger('{"version":1,"entries":{"x":{"archivedAt":"nope"}}}')).toEqual({ version: 1, entries: {} })
  })

  it('tolerates a corrupt auto-state document', () => {
    expect(deserializeAutoState('garbage')).toEqual({ version: 1 })
    expect(deserializeAutoState('{"version":1,"nextCheckAt":123}').nextCheckAt).toBe(123)
  })
})


describe('ledger source whitelist', () => {
  it('operator keeps a backfilled observed entry through a reload', () => {
    // Given a ledger document holding an entry backfilled at observation time
    const doc = { version: 1, entries: { 'session-obs': { archivedAt: 4242, source: 'observed' } } }

    // When that document is deserialized
    const restored = deserializeLedger(JSON.stringify(doc))

    // Then the observed source survives instead of being dropped to a fresh document
    expect(restored.entries).toEqual({ 'session-obs': { archivedAt: 4242, source: 'observed' } })
  })

  it('operator keeps pre-existing manual and auto documents reading unchanged', () => {
    // Given a ledger written before the observed source existed
    const legacy = JSON.stringify({
      version: 1,
      entries: {
        'session-m': { archivedAt: 100, source: 'manual' },
        'session-a': { archivedAt: 200, source: 'auto' },
      },
    })

    // When that document is deserialized
    const restored = deserializeLedger(legacy)

    // Then both legacy sources pass the widened whitelist untouched
    expect(restored.entries).toEqual({
      'session-m': { archivedAt: 100, source: 'manual' },
      'session-a': { archivedAt: 200, source: 'auto' },
    })
  })

  it('operator gets an unknown source dropped instead of trusted', () => {
    // Given a document whose entry carries a source this plugin never writes
    const raw = JSON.stringify({ version: 1, entries: { 'session-x': { archivedAt: 7, source: 'imported' } } })

    // When that document is deserialized
    const restored = deserializeLedger(raw)

    // Then the foreign entry is discarded, exactly as before the widening
    expect(restored.entries).toEqual({})
  })

  it('operator gets every valid entry when one foreign entry shares the document', () => {
    // Given a document mixing an observed entry with an unsupported source
    const raw = JSON.stringify({
      version: 1,
      entries: {
        'session-obs': { archivedAt: 11, source: 'observed' },
        'session-bad': { archivedAt: 12, source: 'imported' },
      },
    })

    // When that document is deserialized
    const restored = deserializeLedger(raw)

    // Then only the whitelisted entry is kept
    expect(Object.keys(restored.entries)).toEqual(['session-obs'])
  })
})
describe('capEntries', () => {
  it('caps the failure list', () => {
    const entries = Array.from({ length: 80 }, (_, index) => ({ id: `session-${index}`, status: 'failed' as const, reason: 'error' as const }))
    expect(capEntries(entries)).toHaveLength(50)
  })
})

describe('writeJsonAtomic', () => {
  it('writes atomically and leaves no temp files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-session-archive-'))
    const path = join(dir, 'state.json')
    await writeJsonAtomic(path, { ok: 1 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ok: 1 })
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
