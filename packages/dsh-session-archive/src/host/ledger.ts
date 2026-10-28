/**
 * Host-side persistence for dsh-session-archive: the archive-time ledger and
 * the automatic-policy run state, both as atomic JSON documents under
 * `$DSH_HOME/dsh-session-archive/`. Every write goes through a unique temp
 * file + fsync + rename, so an interrupted write can never produce a
 * half-written document.
 * @module @linxin666/dsh-session-archive/host/ledger
 */

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RunStats } from '../core/types.ts'

/**
 * Where one ledger archive time came from.
 *
 * - `manual` / `auto`: this plugin performed the archive, so the time is the
 *   real archive moment.
 * - `observed`: the session was already archived when this plugin first saw it
 *   (archived from the official sidebar, which never reaches this plugin), and
 *   the time records the moment of observation — a conservative lower bound on
 *   the real archive moment, never a file timestamp.
 * - `override`: a forced archive that carried an explicit reason (contract
 *   C3) — either `force:true + reason` through `POST /archive`, or the native
 *   dialog's `POST /archive-override` write-back. The reason travels in
 *   {@link LedgerEntry.reason}, the seal judgement in {@link LedgerEntry.seal}.
 */
export type LedgerSource = 'manual' | 'auto' | 'observed' | 'override'

/** One archive-time record. The ledger stays the only archive-time fact source. */
export interface LedgerEntry {
  /** Epoch ms of the archive action (manual, automatic) or of the observation. */
  archivedAt: number
  source: LedgerSource
  /** Forced-archive reason (`source: "override"`); never written empty — see {@link normalizeOverrideReason}. */
  reason?: string
  /**
   * Seal marker recorded with the archive: `"stale"` for the degraded
   * pass-through tier (裁定①), `"<VERDICT>:<detail>"` for a forced archive's
   * seal judgement (contract C3).
   */
  seal?: string
}

export interface LedgerDocument {
  version: 1
  entries: Record<string, LedgerEntry>
}

/** Persisted automatic-policy run state; survives restarts. */
export interface AutoStateDocument {
  version: 1
  lastArchiveRun?: RunStats
  lastDeleteRun?: RunStats
  nextCheckAt?: number
}

export function createLedgerDocument(): LedgerDocument {
  return { version: 1, entries: {} }
}

/** Default marker for a forced archive without a stated reason (裁定②). */
export const OVERRIDE_NO_REASON = 'override:no-reason'

/**
 * Normalize a forced-archive reason at the write layer (contract C4): any
 * missing/blank reason becomes {@link OVERRIDE_NO_REASON}, so "forced but
 * never said why" stays recognizable and countable in the ledger instead of
 * colliding with entries that carry real words.
 */
export function normalizeOverrideReason(reason: unknown): string {
  if (typeof reason === 'string' && reason.trim() !== '') return reason.trim()
  return OVERRIDE_NO_REASON
}

/** Tolerant deserialize: corrupt or foreign documents start fresh. */
export function deserializeLedger(raw: string): LedgerDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return createLedgerDocument()
  }
  if (typeof parsed !== 'object' || parsed === null) return createLedgerDocument()
  const doc = parsed as { version?: unknown; entries?: unknown }
  if (doc.version !== 1 || typeof doc.entries !== 'object' || doc.entries === null) return createLedgerDocument()
  const entries: Record<string, LedgerEntry> = {}
  for (const [id, value] of Object.entries(doc.entries as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as { archivedAt?: unknown; source?: unknown; reason?: unknown; seal?: unknown }
    if (typeof entry.archivedAt !== 'number' || !Number.isFinite(entry.archivedAt)) continue
    // Documents written before `observed`/`override` existed keep deserializing
    // unchanged; an unknown source is still dropped. `override` (added with the
    // seal gate, 2026-10-28) MUST survive this whitelist: dropping it here
    // would be downgrade-lost accounting — see the note in deserializeLedger's
    // callers and the README "Downgrade note".
    if (entry.source !== 'manual' && entry.source !== 'auto' && entry.source !== 'observed' && entry.source !== 'override') continue
    const restored: LedgerEntry = { archivedAt: entry.archivedAt, source: entry.source }
    if (typeof entry.reason === 'string' && entry.reason !== '') restored.reason = entry.reason
    if (typeof entry.seal === 'string' && entry.seal !== '') restored.seal = entry.seal
    entries[id] = restored
  }
  return { version: 1, entries }
}

export function deserializeAutoState(raw: string): AutoStateDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { version: 1 }
  }
  if (typeof parsed !== 'object' || parsed === null) return { version: 1 }
  const doc = parsed as { version?: unknown; lastArchiveRun?: RunStats; lastDeleteRun?: RunStats; nextCheckAt?: number }
  if (doc.version !== 1) return { version: 1 }
  const state: AutoStateDocument = { version: 1 }
  if (isRunStats(doc.lastArchiveRun)) state.lastArchiveRun = doc.lastArchiveRun
  if (isRunStats(doc.lastDeleteRun)) state.lastDeleteRun = doc.lastDeleteRun
  if (typeof doc.nextCheckAt === 'number' && Number.isFinite(doc.nextCheckAt)) state.nextCheckAt = doc.nextCheckAt
  return state
}

function isRunStats(value: unknown): value is RunStats {
  if (typeof value !== 'object' || value === null) return false
  const stats = value as Partial<RunStats>
  return typeof stats.at === 'number'
    && typeof stats.total === 'number'
    && typeof stats.ok === 'number'
    && typeof stats.skipped === 'number'
    && typeof stats.failed === 'number'
    && Array.isArray(stats.entries)
}

/** Atomic JSON write: unique temp file, fsync, rename. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(JSON.stringify(value, null, 1), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** Cap the persisted failure list so state.json stays small. */
export function capEntries(entries: RunStats['entries'], cap = 50): RunStats['entries'] {
  return entries.slice(0, cap)
}
