import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARCHIVE_LEDGER_FILE,
  locateTranscript,
  readTranscriptEvents,
  runTranscriptFirstGate,
  verifyTranscriptReadable,
} from '../src/v2-transcript.ts'

/** Temp homes created per test, removed after each one. */
const homes: string[] = []

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revive-v2-gate-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One zstd frame holding the given events as JSON lines (multi-frame = append). */
function frame(events: readonly unknown[]): Buffer {
  const body = events.map((event) => JSON.stringify(event)).join('\n')
  return zstdCompressSync(Buffer.from(`${body}\n`, 'utf8'))
}

/** Write a transcript file under `home/sessions/<project>/<segment>/`. */
function writeTranscript(home: string, segment: string, frames: readonly Buffer[], project = 'proj'): string {
  const dir = join(home, 'sessions', project, segment)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat([...frames]))
  return file
}

/** Write an archive ledger whose entry keys are the given session ids. */
function writeLedger(home: string, ids: readonly string[]): void {
  const dir = join(home, 'dsh-session-archive')
  mkdirSync(dir, { recursive: true })
  const entries: Record<string, unknown> = {}
  for (const id of ids) entries[id] = { archivedAt: 1_760_000_000_000 }
  writeFileSync(join(home, ARCHIVE_LEDGER_FILE), JSON.stringify({ entries }), 'utf8')
}

describe('multi-frame transcript walk (readTranscriptEvents)', () => {
  it('walks every appended frame and counts the events across them', () => {
    const home = makeHome()
    const file = writeTranscript(home, 'abc', [
      frame([{ type: 'session', id: 'session-abc' }]),
      frame([{ type: 'turn/end' }, { type: 'assistant/message' }]),
      frame([{ type: 'tool/result' }]),
    ])
    const read = readTranscriptEvents(file)
    expect(read).toMatchObject({ ok: true, frames: 3, badFrames: 0, events: 4 })
  })

  it('fails closed on a frame that will not decode, even when others are fine', () => {
    const home = makeHome()
    const garbage = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not-a-zstd-payload', 'utf8')])
    const file = writeTranscript(home, 'abc', [frame([{ type: 'session' }]), garbage])
    const read = readTranscriptEvents(file)
    expect(read.ok).toBe(false)
    expect(read.badFrames).toBe(1)
    expect(read.detail).toBe('bad-frames:1')
  })

  it('fails closed on a file with no decodable frame at all', () => {
    const home = makeHome()
    const dir = join(home, 'sessions', 'proj', 'abc')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, Buffer.from('plain text, no magic', 'utf8'))
    expect(readTranscriptEvents(file)).toMatchObject({ ok: false, detail: 'no-decodable-frame' })
  })

  it('fails closed on a decoded frame that holds zero events', () => {
    const home = makeHome()
    const file = writeTranscript(home, 'abc', [frame([])])
    expect(readTranscriptEvents(file)).toMatchObject({ ok: false, detail: 'no-events', frames: 1 })
  })

  it('reports a missing file instead of throwing', () => {
    const read = readTranscriptEvents(join(tmpdir(), 'definitely-absent-transcript.zstd'))
    expect(read.ok).toBe(false)
    expect(read.detail).toContain('read-failed')
  })
})

describe('transcript location (locateTranscript)', () => {
  it('finds bare-uuid and session-prefixed segment dirs alike', () => {
    const home = makeHome()
    const bare = writeTranscript(home, '11111111-2222-3333-4444-555555555555', [frame([{ type: 'session' }])])
    expect(locateTranscript(home, 'session-11111111-2222-3333-4444-555555555555')).toBe(bare)
    const prefixed = writeTranscript(home, 'session-99999999-8888-7777-6666-555555555555', [frame([{ type: 'session' }])])
    expect(locateTranscript(home, 'session-99999999-8888-7777-6666-555555555555')).toBe(prefixed)
  })

  it('returns undefined when the session has no transcript', () => {
    const home = makeHome()
    mkdirSync(join(home, 'sessions', 'proj'), { recursive: true })
    expect(locateTranscript(home, 'session-00000000-0000-0000-0000-000000000000')).toBeUndefined()
  })
})

describe('fail-closed first gate (runTranscriptFirstGate)', () => {
  it('passes when nothing is archived yet: no sessions root', () => {
    const home = makeHome()
    expect(runTranscriptFirstGate(home)).toMatchObject({ ok: true, detail: 'no-sessions-root: nothing archived yet' })
  })

  it('passes when a sessions root exists but no archive ledger does', () => {
    const home = makeHome()
    mkdirSync(join(home, 'sessions'), { recursive: true })
    expect(runTranscriptFirstGate(home)).toMatchObject({ ok: true, detail: 'no-archive-ledger: nothing archived yet' })
  })

  it('passes on an empty ledger (nothing archived to prove)', () => {
    const home = makeHome()
    mkdirSync(join(home, 'sessions'), { recursive: true })
    writeLedger(home, [])
    expect(runTranscriptFirstGate(home)).toMatchObject({ ok: true, detail: 'archive-ledger-empty' })
  })

  it('fails when the ledger says archived but no session dirs exist', () => {
    const home = makeHome()
    mkdirSync(join(home, 'sessions'), { recursive: true })
    writeLedger(home, ['session-aaaa'])
    expect(runTranscriptFirstGate(home)).toMatchObject({ ok: false, detail: 'ledger-has-entries-but-no-session-dirs' })
  })

  it('fails when an archived id resolves to no readable transcript (fail-closed, not pass)', () => {
    const home = makeHome()
    // A segment dir exists (so the ledger is not vacuously empty) but holds no
    // transcript file - the exact shape the relay save could not survive.
    mkdirSync(join(home, 'sessions', 'proj', 'bbbb'), { recursive: true })
    writeLedger(home, ['session-bbbb'])
    expect(runTranscriptFirstGate(home)).toMatchObject({
      ok: false,
      detail: 'no-readable-transcript-for 1 archived sessions',
    })
  })

  it('fails on an unparseable ledger', () => {
    const home = makeHome()
    mkdirSync(join(home, 'sessions'), { recursive: true })
    mkdirSync(join(home, 'dsh-session-archive'), { recursive: true })
    writeFileSync(join(home, ARCHIVE_LEDGER_FILE), '{not json', 'utf8')
    expect(runTranscriptFirstGate(home)).toMatchObject({ ok: false, detail: 'archive-ledger-unparseable' })
  })

  it('passes only after walking a real multi-frame archived transcript', () => {
    const home = makeHome()
    const id = 'session-cccc'
    writeTranscript(home, 'cccc', [frame([{ type: 'session', id }]), frame([{ type: 'turn/end' }])])
    writeLedger(home, [id])
    const verdict = runTranscriptFirstGate(home)
    expect(verdict.ok).toBe(true)
    expect(verdict.sessionId).toBe(id)
    expect(verdict.events).toBe(2)
    expect(verdict.detail).toContain('archived transcript readable')
  })

  it('fails when the archived transcript itself is corrupt (torn tail halts)', () => {
    const home = makeHome()
    const id = 'session-dddd'
    writeTranscript(home, 'dddd', [
      Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('torn', 'utf8')]),
    ])
    writeLedger(home, [id])
    const verdict = runTranscriptFirstGate(home)
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain('archived transcript unreadable')
    expect(verdict.detail).toContain(id)
  })
})

describe('per-run pre-flight (verifyTranscriptReadable)', () => {
  it('refuses a session whose transcript is absent - the chain stops before archive', () => {
    const home = makeHome()
    mkdirSync(join(home, 'sessions', 'proj'), { recursive: true })
    const result = verifyTranscriptReadable('session-eeee', home)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('transcript-not-found')
  })

  it('refuses a corrupt transcript and accepts a readable one', () => {
    const home = makeHome()
    writeTranscript(home, 'ffff', [frame([{ type: 'session' }])])
    expect(verifyTranscriptReadable('session-ffff', home).ok).toBe(true)
    writeTranscript(home, 'gggg', [Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('x', 'utf8')])])
    const bad = verifyTranscriptReadable('session-gggg', home)
    expect(bad.ok).toBe(false)
    expect(bad.detail).toContain('transcript-unreadable')
  })
})
