import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PENDING_MAX_ENTRIES,
  REVIVE_PENDING_FILE,
  RevivePendingWriter,
  readPendingEntries,
  type RevivePendingWrite,
} from '../src/pending-state.ts'
import type { RevivePendingEntry, RevivePendingExport } from '../src/v2-machine.ts'

const homes: string[] = []

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revive-pending-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The releaseDue input set, exactly as the machine persists it. */
const ENTRY: RevivePendingEntry = {
  plannedAt: 1_760_000_000_000,
  code: 'TRANSPORT',
  channel: 'fresh',
  route: { provider: 'mimo', model: 'mimo-v2-flash' },
  cooldownUntil: 1_760_000_060_000,
}

function doc(at: number, sessions: Record<string, RevivePendingEntry>): RevivePendingExport {
  return { at, sessions }
}

/** A writer with a recorded write seam: no real home is touched. */
function recordingWriter(options: { seed?: Readonly<Record<string, RevivePendingEntry>> } = {}): {
  writer: RevivePendingWriter
  writes: Array<{ path: string; payload: string }>
} {
  const writes: Array<{ path: string; payload: string }> = []
  const write: RevivePendingWrite = (path, payload) => {
    writes.push({ path, payload })
  }
  const writer = new RevivePendingWriter({
    path: join(makeHome(), REVIVE_PENDING_FILE),
    write,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  })
  return { writer, writes }
}

describe('boot read (design §4.2 rule one, fail-closed)', () => {
  it('treats a missing file as a clean empty read (first boot)', () => {
    const read = readPendingEntries(join(makeHome(), REVIVE_PENDING_FILE))
    expect(read).toEqual({ ok: true, entries: {} })
  })

  it('round-trips a valid ledger with the full releaseDue input set', () => {
    const path = join(makeHome(), REVIVE_PENDING_FILE)
    writeFileSync(path, `${JSON.stringify({ at: 5, sessions: { 'session-a': ENTRY, 'session-b': { plannedAt: 7, channel: 'progress-retry', cooldownUntil: 0 } } })}\n`, 'utf8')
    const read = readPendingEntries(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.entries).toEqual({
      'session-a': ENTRY,
      'session-b': { plannedAt: 7, channel: 'progress-retry', cooldownUntil: 0 },
    })
    // Byte-stable: the entries re-stringify in canonical field order, which is
    // what the seeded writer's change-only comparison relies on.
    expect(JSON.stringify(read.entries)).toBe(
      JSON.stringify({
        'session-a': ENTRY,
        'session-b': { plannedAt: 7, channel: 'progress-retry', cooldownUntil: 0 },
      }),
    )
  })

  it('fails closed on a parse error instead of guessing', () => {
    const path = join(makeHome(), REVIVE_PENDING_FILE)
    writeFileSync(path, '{corrupt', 'utf8')
    const read = readPendingEntries(path)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toContain('parse-failed')
  })

  it('fails closed when sessions is not an object', () => {
    const path = join(makeHome(), REVIVE_PENDING_FILE)
    writeFileSync(path, JSON.stringify({ at: 1, sessions: [ENTRY] }), 'utf8')
    const read = readPendingEntries(path)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toContain('sessions is not an object')
  })

  it('fails closed on any malformed entry — one bad row rejects the whole file', () => {
    const path = join(makeHome(), REVIVE_PENDING_FILE)
    const bad: unknown[] = [
      { plannedAt: 'soon', channel: 'fresh', cooldownUntil: 0 },
      { plannedAt: 1, channel: 'sometimes', cooldownUntil: 0 },
      { plannedAt: 1, channel: 'fresh', cooldownUntil: Number.NaN },
      { plannedAt: 1, channel: 'fresh', cooldownUntil: 0, route: { provider: 5 } },
      { plannedAt: 1, channel: 'fresh', cooldownUntil: 0, code: 42 },
      'not-an-object',
    ]
    for (const entry of bad) {
      writeFileSync(path, JSON.stringify({ at: 1, sessions: { 'session-a': entry } }), 'utf8')
      const read = readPendingEntries(path)
      expect(read.ok, `entry rejected: ${JSON.stringify(entry)}`).toBe(false)
      if (!read.ok) expect(read.error).toContain('bad entry for session-a')
    }
  })

  it('fails closed on a ledger past the entry bound (hostile or corrupt)', () => {
    const path = join(makeHome(), REVIVE_PENDING_FILE)
    const sessions: Record<string, unknown> = {}
    for (let i = 0; i <= PENDING_MAX_ENTRIES; i++) sessions[`session-${i}`] = { plannedAt: 1, channel: 'fresh', cooldownUntil: 0 }
    writeFileSync(path, JSON.stringify({ at: 1, sessions }), 'utf8')
    const read = readPendingEntries(path)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toContain(`exceed the ${PENDING_MAX_ENTRIES} bound`)
  })

  it('fails closed on a non-ENOENT read error (e.g. the path is a directory)', () => {
    const dir = join(makeHome(), 'a-directory')
    mkdirSync(dir)
    const read = readPendingEntries(dir)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).not.toContain('parse-failed')
  })
})

describe('change-only writer (mirrors the v2-state contract)', () => {
  it('writes the document as { at, sessions } with the rows verbatim', () => {
    const { writer, writes } = recordingWriter()
    expect(writer.sync(doc(1_000, { 'session-a': ENTRY }))).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0].path.endsWith(REVIVE_PENDING_FILE)).toBe(true)
    const parsed = JSON.parse(writes[0].payload) as RevivePendingExport
    expect(Object.keys(parsed).sort()).toEqual(['at', 'sessions'])
    expect(parsed.at).toBe(1_000)
    expect(parsed.sessions['session-a']).toEqual(ENTRY)
  })

  it('writes on the first real flip and stays silent while only `at` moves', () => {
    const { writer, writes } = recordingWriter()
    expect(writer.sync(doc(1, { 'session-a': ENTRY }))).toBe(true)
    expect(writer.sync(doc(2, { 'session-a': ENTRY }))).toBe(false)
    expect(writes).toHaveLength(1)
    expect(writer.sync(doc(3, { 'session-a': { ...ENTRY, plannedAt: ENTRY.plannedAt + 10_000 } }))).toBe(true)
    expect(writes).toHaveLength(2)
    expect(writer.sync(doc(4, {}))).toBe(true)
    expect(writes).toHaveLength(3)
  })

  it('seeds from the boot read so a replayed ledger costs zero writes', () => {
    const { writer, writes } = recordingWriter({ seed: { 'session-a': ENTRY } })
    // The machine restores the very entries it read: byte-identical → no write.
    expect(writer.sync(doc(9, { 'session-a': ENTRY }))).toBe(false)
    expect(writes).toHaveLength(0)
    // A real decision flip after the replay still lands.
    expect(writer.sync(doc(10, { 'session-a': { ...ENTRY, channel: 'zero-cost' } }))).toBe(true)
    expect(writes).toHaveLength(1)
  })

  it('retries after a failed write instead of latching the baseline', () => {
    const writes: Array<{ path: string; payload: string }> = []
    let failNext = true
    const writer = new RevivePendingWriter({
      path: join(makeHome(), REVIVE_PENDING_FILE),
      write: (path, payload) => {
        if (failNext) {
          failNext = false
          throw new Error('disk hiccup')
        }
        writes.push({ path, payload })
      },
    })
    const snapshot = doc(1, { 'session-a': ENTRY })
    expect(writer.sync(snapshot)).toBe(false)
    expect(writes).toHaveLength(0)
    expect(writer.sync(snapshot)).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writer.sync(snapshot)).toBe(false)
    expect(writes).toHaveLength(1)
  })

  it('refuses an over-bound snapshot: a stale-but-readable ledger beats an unreadable one', () => {
    const { writer, writes } = recordingWriter()
    const sessions: Record<string, RevivePendingEntry> = {}
    for (let i = 0; i <= PENDING_MAX_ENTRIES; i++) sessions[`session-${i}`] = { plannedAt: 1, channel: 'fresh', cooldownUntil: 0 }
    expect(writer.sync(doc(1, sessions))).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it('full loop: writer output re-reads into the entries the next writer seeds from', () => {
    const path = join(makeHome(), REVIVE_PENDING_FILE)
    const first = new RevivePendingWriter({ path })
    expect(first.sync(doc(1, { 'session-a': ENTRY, 'session-b': { plannedAt: 7, channel: 'zero-cost', cooldownUntil: 0 } }))).toBe(true)
    const read = readPendingEntries(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    // Simulated restart: the next writer is seeded from the ONE boot read and
    // the machine replays the same entries — zero writes until a real flip.
    const second = new RevivePendingWriter({ path, seed: read.entries })
    expect(second.sync(doc(2, read.entries))).toBe(false)
    expect(second.sync(doc(3, { ...read.entries, 'session-c': { plannedAt: 9, channel: 'fresh', cooldownUntil: 0 } }))).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as RevivePendingExport
    expect(Object.keys(onDisk.sessions).sort()).toEqual(['session-a', 'session-b', 'session-c'])
  })
})
