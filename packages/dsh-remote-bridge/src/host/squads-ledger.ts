/**
 * The read-only ledger fallback of the squads channel.
 *
 * `dsh-agents` is the only writer of this document, and this bridge reads the
 * same bytes under the same rules: a document of an unknown generation, a
 * revision that is not a whole number, or a team/run set this build cannot read
 * is refused rather than repaired. Nothing here writes, locks, creates or
 * quarantines anything — a Host whose loopback route cannot answer still shows
 * the user's own definitions, and never edits them from behind the plugin's back.
 *
 * The rows themselves are mapped by `core/squads.ts`, exactly as a loopback
 * answer is: the two paths meet in one mapping, so a fallback body cannot drift
 * from a served one.
 * @module dsh-remote-bridge/host/squads-ledger
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CODE_SQUADS_UNAVAILABLE } from '../core/protocol.ts'
import { SquadRefusal } from '../core/squads.ts'

/** Ledger file name inside the plugin's own directory. */
export const SQUAD_LEDGER_FILE = 'ledger.json'

/** Owner lock beside it; it is what carries the owning pid. */
export const SQUAD_LEDGER_LOCK_FILE = 'ledger.json.lock'

/** The one ledger generation this build reads. */
export const SQUAD_LEDGER_SCHEMA_VERSION = 1

/** One state document read off the ledger, in the plugin's own key names. */
export interface SquadLedgerDocument {
  teams: readonly unknown[]
  runs: readonly unknown[]
  host: { ownerPid?: number }
}

/** The plugin's own code for a ledger this build cannot read. */
const CODE_LEDGER_CORRUPT = 'ledger-corrupt'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function corrupt(reason: string): SquadRefusal {
  return new SquadRefusal(CODE_LEDGER_CORRUPT, 'the dsh-agents ledger ' + reason)
}

/**
 * Read the owning pid from the ledger lock.
 *
 * The lock is the plugin's own record of who is writing; a missing or unreadable
 * one leaves the pid absent, because a channel with no owner to name is not a
 * failure of the read.
 * @param directory - the plugin-owned directory.
 * @returns `{ownerPid}` when the lock names one, or an empty object.
 */
async function ownerOf(directory: string): Promise<{ ownerPid?: number }> {
  try {
    const parsed = record(JSON.parse(await readFile(join(directory, SQUAD_LEDGER_LOCK_FILE), 'utf8')))
    const pid = parsed?.pid
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { ownerPid: pid } : {}
  } catch {
    return {}
  }
}

/**
 * Read the ledger document without touching it.
 * @param directory - the plugin-owned directory (`$DSH_HOME/dsh-agents`).
 * @returns the definitions and runs as stored, plus the owning pid when the lock
 *   names one.
 * @throws {SquadRefusal} `squads-unavailable` when there is no readable ledger, or
 *   the plugin's own `ledger-corrupt` when the bytes are not the document this
 *   build reads.
 */
export async function readSquadLedger(directory: string): Promise<SquadLedgerDocument> {
  const file = join(directory, SQUAD_LEDGER_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new SquadRefusal(CODE_SQUADS_UNAVAILABLE, 'this host serves no dsh-agents squad domain over loopback and holds no ledger at ' + file + ': ' + messageOf(error))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw corrupt('at ' + file + ' is not valid JSON: ' + messageOf(error))
  }
  const document = record(parsed)
  if (document === undefined) throw corrupt('is not a JSON object')
  if (document.schemaVersion !== SQUAD_LEDGER_SCHEMA_VERSION) {
    throw corrupt('declares generation ' + String(document.schemaVersion) + ', and this build reads ' + String(SQUAD_LEDGER_SCHEMA_VERSION))
  }
  if (typeof document.revision !== 'number' || !Number.isInteger(document.revision) || document.revision < 0) {
    throw corrupt('carries no usable revision')
  }
  if (!Array.isArray(document.teams) || !Array.isArray(document.runs)) throw corrupt('holds no team/run arrays')
  return { teams: document.teams, runs: document.runs, host: await ownerOf(directory) }
}
