/**
 * Append-only archive event journal (B′, archive-audit-journal-1114): one
 * JSONL line per successful archive/unarchive under
 * `$DSH_HOME/dsh-session-archive/archive-events.jsonl`, keeping a full
 * serialization of the ledger entry an unarchive is about to erase. The
 * journal is a pure side log — it never reads or writes the ledger document,
 * never blocks the archive chain, and the caller owns the fail-open policy
 * (a throw here is caught upstream and only warned).
 *
 * Row-level rolling (design §四): a single generation (`<file>.1`) is kept
 * when the file passes `rollBytes`; this is line-level scrolling of the one
 * journal file, not the rejected whole-snapshot rotation.
 * @module @linxin666/dsh-session-archive/host/journal
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One journal line. `entry` is the whole in-memory ledger entry, stringified verbatim. */
export interface JournalEvent {
  /** Canonical session id (the ledger entry key). */
  id: string
  op: 'archive' | 'unarchive'
  /** Batch timestamp (epoch ms); batches are strictly ordered in-process. */
  at: number
  /** Who ordered this archive (REST actor); absent on auto/unarchive rows. */
  actor?: string
  /** Full serialization of the ledger entry at the moment of the operation. */
  entry?: Record<string, unknown>
}

/** Roll the journal to `<path>.1` once it passes 32 MiB (≈28 years at 10 ops/day, ≈3 at 100). */
export const JOURNAL_ROLL_BYTES = 32 * 1024 * 1024

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Append `events` to the journal as one ordered batch (single `O_APPEND`
 * write). Empty batches touch no filesystem at all. Failures throw; the
 * caller (janitor) warns and continues — fail-open by contract.
 *
 * @param path - journal file path (`archive-events.jsonl`).
 * @param events - one row per successful operation, already timestamped.
 * @param opts.rollBytes - roll threshold; overridable for tests.
 */
export async function appendJournal(
  path: string,
  events: readonly JournalEvent[],
  opts: { rollBytes?: number } = {},
): Promise<void> {
  if (events.length === 0) return
  await mkdir(dirname(path), { recursive: true })
  // Row-level roll: rename the whole file aside, keep one generation. A roll
  // failure is a size-hygiene problem, never a write blocker (fail-open):
  // warn loudly and append to the current file anyway; ENOENT is just a
  // fresh journal with nothing to roll.
  try {
    const size = (await stat(path)).size
    if (size >= (opts.rollBytes ?? JOURNAL_ROLL_BYTES)) {
      await rename(path, `${path}.1`)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(`[dsh-session-archive] journal roll failed: ${describe(error)}`)
    }
  }
  const payload = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  await appendFile(path, payload, 'utf8')
}
