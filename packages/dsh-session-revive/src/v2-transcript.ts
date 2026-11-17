/**
 * Archive-transcript readability: the fail-closed first gate of the revival v2
 * chain (design session-revival-v2-alert-inbox-1116, section four). The
 * archive-relay save reads the OLD session's transcript after the archive, so
 * before the machine may revive anything it must PROVE that an archived
 * session's transcript still decodes - archive is not delete, and this module
 * is where that claim is checked instead of assumed. When the gate fails the
 * machine halts and reports; it never proceeds on a hunch.
 *
 * Transcripts are multi-frame zstd append logs: every flush writes a new frame
 * prefixed with the magic 28 B5 2F FD, so one `zstdDecompressSync` call only
 * yields the first frame (the 196-byte session header). The reader walks magic
 * boundaries and decodes frame by frame, the same walk as m-note
 * `scripts/dsh/session-status.mjs` `walkBuf`.
 *
 * The gate is strict on purpose (fail-closed, not fail-open): a frame that
 * will not decode means the transcript is not fully readable, and the relay
 * save would silently lose events. A torn tail therefore halts the machine
 * and reports rather than risking a partial代劳 save.
 * @module dsh-session-revive/v2-transcript
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { dshHome } from './dsh-home.ts'

/** First frame magic of a zstd stream (little-endian 0xFD2FB528). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Archive ledger location under the DSH home (dsh-session-archive package). */
export const ARCHIVE_LEDGER_FILE = 'dsh-session-archive/archive-ledger.json'

/** One transcript walk result: decodable frames, parsed events, failures. */
export interface TranscriptReadResult {
  ok: boolean
  frames: number
  /** Frames whose zstd payload would not decode (must be 0 for `ok`). */
  badFrames: number
  /** Parsed JSON events across every frame (must be >= 1 for `ok`). */
  events: number
  detail?: string
}

/**
 * Walk one multi-frame zstd transcript and count what actually decodes.
 * Strict: `ok` requires zero bad frames and at least one parsed event.
 * @param file - absolute path of a `session.v*.jsonl.zstd` file.
 * @returns the walk counts plus a failure detail when not readable.
 */
export function readTranscriptEvents(file: string): TranscriptReadResult {
  let buf: Buffer
  try {
    buf = readFileSync(file)
  } catch (error) {
    return { ok: false, frames: 0, badFrames: 0, events: 0, detail: `read-failed: ${shortError(error)}` }
  }
  if (buf.length < ZSTD_MAGIC.length) {
    return { ok: false, frames: 0, badFrames: 0, events: 0, detail: 'too-small' }
  }
  let frames = 0
  let badFrames = 0
  let events = 0
  for (let i = 0; i + ZSTD_MAGIC.length <= buf.length; ) {
    const at = buf.indexOf(ZSTD_MAGIC, i)
    if (at === -1) break
    const next = buf.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)
    const end = next === -1 ? buf.length : next
    let text: string
    try {
      text = zstdDecompressSync(buf.subarray(at, end)).toString('utf8')
      frames += 1
    } catch {
      badFrames += 1
      i = at + ZSTD_MAGIC.length
      continue
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed[0] !== '{') continue
      try {
        JSON.parse(trimmed)
        events += 1
      } catch {
        // A partial line inside a decoded frame counts as nothing; the frame
        // itself decoded, so this is not a bad frame.
      }
    }
    i = end
  }
  if (frames === 0) {
    return { ok: false, frames, badFrames, events, detail: 'no-decodable-frame' }
  }
  if (badFrames > 0) {
    return { ok: false, frames, badFrames, events, detail: `bad-frames:${badFrames}` }
  }
  if (events === 0) {
    return { ok: false, frames, badFrames, events, detail: 'no-events' }
  }
  return { ok: true, frames, badFrames, events }
}

/**
 * Locate a session's transcript file under `<dsh-home>/sessions`.
 * Segment dirs appear either as `<uuid>` or `session-<uuid>` (the archive
 * package's `canonicalSessionId` rule), inside one cwd-encoded project dir.
 * @param home - resolved DSH home (injectable for tests).
 * @param sessionId - canonical `session-<uuid>` id.
 * @returns the absolute transcript path, or undefined when absent.
 */
export function locateTranscript(home: string, sessionId: string): string | undefined {
  const sessionsRoot = join(home, 'sessions')
  if (!existsSync(sessionsRoot)) return undefined
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  const candidates = [sessionId, `session-${bare}`, bare]
  let projects: string[]
  try {
    projects = readdirSync(sessionsRoot)
  } catch {
    return undefined
  }
  for (const project of projects) {
    const projectPath = join(sessionsRoot, project)
    let projectStat
    try {
      projectStat = statSync(projectPath)
    } catch {
      continue
    }
    if (!projectStat.isDirectory()) continue
    for (const segment of candidates) {
      const dir = join(projectPath, segment)
      let dirStat
      try {
        dirStat = statSync(dir)
      } catch {
        continue
      }
      if (!dirStat.isDirectory()) continue
      const file = findTranscriptFile(dir)
      if (file !== undefined) return file
    }
  }
  return undefined
}

/** The `session.v*.jsonl.zstd` file inside one session dir, if present. */
function findTranscriptFile(dir: string): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const match = entries.find((name) => name.startsWith('session.v') && name.endsWith('.jsonl.zstd'))
  if (match === undefined) return undefined
  return join(dir, match)
}

/** The first-gate verdict the machine is constructed with. */
export interface TranscriptFirstGate {
  ok: boolean
  detail: string
  /** The session the gate proved readable; absent when nothing was provable. */
  sessionId?: string
  events?: number
}

/**
 * The fail-closed first gate: prove that an ARCHIVED session's transcript
 * still decodes, before any revival attempt can exist (design section four:
 * the relay save depends on this line completely).
 *
 * - No sessions root or an empty ledger means nothing archived yet, so there
 *   is nothing that could be unreadable: the gate passes with that detail.
 * - A non-empty ledger whose ids resolve to no transcript fails: the ledger
 *   says archived but nothing is readable, which is exactly the state the
 *   relay save could not survive.
 * - Otherwise the smallest archived transcript is walked in full; any bad
 *   frame or zero events fails the gate.
 * @param home - resolved DSH home (defaults to the live environment).
 * @returns the verdict with a reportable detail string.
 */
export function runTranscriptFirstGate(home: string = dshHome()): TranscriptFirstGate {
  const sessionsRoot = join(home, 'sessions')
  if (!existsSync(sessionsRoot)) {
    return { ok: true, detail: 'no-sessions-root: nothing archived yet' }
  }
  let ledgerRaw: string
  try {
    ledgerRaw = readFileSync(join(home, ARCHIVE_LEDGER_FILE), 'utf8')
  } catch {
    return { ok: true, detail: 'no-archive-ledger: nothing archived yet' }
  }
  let entries: Record<string, unknown>
  try {
    const parsed = JSON.parse(ledgerRaw) as { entries?: unknown }
    entries = typeof parsed.entries === 'object' && parsed.entries !== null ? (parsed.entries as Record<string, unknown>) : {}
  } catch {
    return { ok: false, detail: 'archive-ledger-unparseable' }
  }
  const ids = Object.keys(entries)
  if (ids.length === 0) return { ok: true, detail: 'archive-ledger-empty' }
  const segments = collectSegments(sessionsRoot)
  if (segments.size === 0) return { ok: false, detail: 'ledger-has-entries-but-no-session-dirs' }
  let best: { sessionId: string; file: string; size: number } | undefined
  for (const id of ids) {
    const dir = segments.get(canonicalOf(id))
    if (dir === undefined) continue
    const file = findTranscriptFile(dir)
    if (file === undefined) continue
    let size: number
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    if (best === undefined || size < best.size) best = { sessionId: id, file, size }
  }
  if (best === undefined) {
    return { ok: false, detail: `no-readable-transcript-for ${ids.length} archived sessions` }
  }
  const read = readTranscriptEvents(best.file)
  if (!read.ok) {
    return { ok: false, detail: `archived transcript unreadable (${best.sessionId}): ${read.detail ?? 'unknown'}` }
  }
  return {
    ok: true,
    detail: `archived transcript readable: ${best.sessionId} frames=${read.frames} events=${read.events}`,
    sessionId: best.sessionId,
    events: read.events,
  }
}

/**
 * Verify one specific session's transcript before the chain archives it: the
 * per-run re-check of the same fail-closed claim, aimed at the session that
 * is about to lose its ability to save itself.
 * @param sessionId - the session the chain is about to archive.
 * @param home - resolved DSH home (defaults to the live environment).
 * @returns readability verdict for that session.
 */
export function verifyTranscriptReadable(
  sessionId: string,
  home: string = dshHome(),
): { ok: boolean; detail: string } {
  const file = locateTranscript(home, sessionId)
  if (file === undefined) return { ok: false, detail: `transcript-not-found: ${sessionId}` }
  const read = readTranscriptEvents(file)
  if (!read.ok) return { ok: false, detail: `transcript-unreadable: ${read.detail ?? 'unknown'}` }
  return { ok: true, detail: `readable frames=${read.frames} events=${read.events}` }
}

/** Map every session segment dir under the sessions root to its canonical id. */
function collectSegments(sessionsRoot: string): Map<string, string> {
  const out = new Map<string, string>()
  let projects: string[]
  try {
    projects = readdirSync(sessionsRoot)
  } catch {
    return out
  }
  for (const project of projects) {
    const projectPath = join(sessionsRoot, project)
    let projectStat
    try {
      projectStat = statSync(projectPath)
    } catch {
      continue
    }
    if (!projectStat.isDirectory()) continue
    let segments: string[]
    try {
      segments = readdirSync(projectPath)
    } catch {
      continue
    }
    for (const segment of segments) {
      const dir = join(projectPath, segment)
      let dirStat
      try {
        dirStat = statSync(dir)
      } catch {
        continue
      }
      if (!dirStat.isDirectory()) continue
      const canonical = canonicalOf(segment)
      if (!out.has(canonical)) out.set(canonical, dir)
    }
  }
  return out
}

/** Canonical `session-<uuid>` form of one segment name (archive package rule). */
function canonicalOf(segment: string): string {
  return segment.startsWith('session-') ? segment : `session-${segment}`
}

/** One-line error text for gate details. */
function shortError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 200)
}
