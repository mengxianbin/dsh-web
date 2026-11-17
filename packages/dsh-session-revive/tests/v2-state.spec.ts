import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReviveV2StateWriter, REVIVE_V2_STATE_FILE, type ReviveV2StateWrite } from '../src/v2-state.ts'
import type { ReviveV2SessionExport, ReviveV2StateExport } from '../src/v2-machine.ts'

const homes: string[] = []

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revive-v2-state-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The section-seven field set, literal - the bilateral contract. */
const SESSION_FIELDS = [
  'episodeSpentTokens',
  'lastFailureAt',
  'lastFailureForm',
  'lastFailureTokens',
  'lastSuccessAt',
  'probe',
  'probeRedAlarmed',
  'probeRedSince',
  'progressRetry',
  'relayDepth',
  'relaySessionId',
  'stopped',
  'zeroCostStrikes',
] as const

function sessionExport(overrides: Partial<ReviveV2SessionExport> = {}): ReviveV2SessionExport {
  return {
    probe: 'green',
    probeRedSince: null,
    probeRedAlarmed: false,
    zeroCostStrikes: 0,
    relayDepth: 0,
    progressRetry: 0,
    stopped: null,
    lastFailureAt: null,
    lastFailureForm: null,
    lastFailureTokens: 0,
    episodeSpentTokens: 0,
    relaySessionId: null,
    lastSuccessAt: null,
    ...overrides,
  }
}

function snapshot(at: number, sessions: Record<string, ReviveV2SessionExport>): ReviveV2StateExport {
  return { at, sessions }
}

/** A writer with a recorded write seam: no real home is touched. */
function recordingWriter(options: { readExisting?: boolean } = {}): {
  writer: ReviveV2StateWriter
  writes: Array<{ path: string; payload: string }>
} {
  const writes: Array<{ path: string; payload: string }> = []
  const write: ReviveV2StateWrite = (path, payload) => {
    writes.push({ path, payload })
  }
  const writer = new ReviveV2StateWriter({
    path: join(makeHome(), REVIVE_V2_STATE_FILE),
    write,
    readExisting: options.readExisting ?? false,
  })
  return { writer, writes }
}

describe('section-seven contract shape', () => {
  it('carries exactly the bilateral field set, no more and no less', () => {
    expect(Object.keys(sessionExport()).sort()).toEqual([...SESSION_FIELDS].sort())
  })

  it('writes the document as { at, sessions } with the session rows verbatim', () => {
    const { writer, writes } = recordingWriter()
    const row = sessionExport({ zeroCostStrikes: 2, lastFailureForm: 'zero-token' })
    expect(writer.sync(snapshot(1_000, { 'session-a': row }))).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0].path.endsWith(REVIVE_V2_STATE_FILE)).toBe(true)
    const parsed = JSON.parse(writes[0].payload) as ReviveV2StateExport
    expect(Object.keys(parsed).sort()).toEqual(['at', 'sessions'])
    expect(parsed.at).toBe(1_000)
    expect(parsed.sessions['session-a']).toEqual(row)
  })
})

describe('change-only write (design section seven)', () => {
  it('writes on the first real change and then stays silent while nothing flips', () => {
    const { writer, writes } = recordingWriter()
    expect(writer.sync(snapshot(1, { 'session-a': sessionExport() }))).toBe(true)
    expect(writes).toHaveLength(1)
    // Only `at` moves: the comparison excludes it, so this is NOT a change.
    expect(writer.sync(snapshot(2, { 'session-a': sessionExport() }))).toBe(false)
    expect(writer.sync(snapshot(3, { 'session-a': sessionExport() }))).toBe(false)
    expect(writes).toHaveLength(1)
    // A real field flip writes again.
    expect(writer.sync(snapshot(4, { 'session-a': sessionExport({ zeroCostStrikes: 1 }) }))).toBe(true)
    expect(writes).toHaveLength(2)
  })

  it('writes when a session appears or disappears', () => {
    const { writer, writes } = recordingWriter()
    // Never-written baseline: the first sync lands the (still empty) document.
    expect(writer.sync(snapshot(1, {}))).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writer.sync(snapshot(2, { 'session-a': sessionExport() }))).toBe(true)
    expect(writer.sync(snapshot(3, { 'session-a': sessionExport() }))).toBe(false)
    expect(writer.sync(snapshot(4, {}))).toBe(true)
    expect(writes).toHaveLength(3)
  })

  it('retries after a failed write instead of latching the baseline', () => {
    const writes: Array<{ path: string; payload: string }> = []
    let failNext = true
    const writer = new ReviveV2StateWriter({
      path: join(makeHome(), REVIVE_V2_STATE_FILE),
      write: (path, payload) => {
        if (failNext) {
          failNext = false
          throw new Error('disk hiccup')
        }
        writes.push({ path, payload })
      },
      readExisting: false,
    })
    const doc = snapshot(1, { 'session-a': sessionExport() })
    expect(writer.sync(doc)).toBe(false) // write threw: reported as no-write
    expect(writes).toHaveLength(0)
    expect(writer.sync(doc)).toBe(true) // same payload retries and lands
    expect(writes).toHaveLength(1)
    expect(writer.sync(doc)).toBe(false) // then the baseline holds
    expect(writes).toHaveLength(1)
  })

  it('seeds from an existing file so a restarted host does not rewrite byte-identical state', () => {
    const home = makeHome()
    const path = join(home, REVIVE_V2_STATE_FILE)
    const row = sessionExport({ relayDepth: 1, relaySessionId: 'session-relay' })
    // A previous host run already landed this exact document.
    writeFileSync(path, `${JSON.stringify({ at: 9, sessions: { 'session-a': row } })}\n`, 'utf8')
    const seeded = new ReviveV2StateWriter({ path, readExisting: true })
    // Nothing to change: the on-disk document already holds this payload.
    expect(seeded.sync(snapshot(9, { 'session-a': row }))).toBe(false)
    // A flip is still detected against the seeded baseline.
    expect(
      seeded.sync(
        snapshot(10, { 'session-a': sessionExport({ relayDepth: 1, relaySessionId: 'session-relay', stopped: 'relay-recidive' }) }),
      ),
    ).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as ReviveV2StateExport
    expect(onDisk.at).toBe(10)
    expect(onDisk.sessions['session-a'].stopped).toBe('relay-recidive')
  })

  it('ignores a corrupt existing file (treated as never written)', () => {
    const home = makeHome()
    const path = join(home, REVIVE_V2_STATE_FILE)
    writeFileSync(path, '{corrupt', 'utf8')
    const writer = new ReviveV2StateWriter({ path, readExisting: true })
    expect(writer.sync(snapshot(1, { 'session-a': sessionExport() }))).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as ReviveV2StateExport
    expect(onDisk.sessions['session-a']).toBeDefined()
  })
})
