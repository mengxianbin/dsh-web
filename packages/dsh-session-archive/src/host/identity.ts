/**
 * Archive identity gate: the triclass decision table that every plugin
 * archive passes before touching a session (user ruling, 2026-10-29).
 *
 * The table reads `$DSH_HOME/session-attention.json` — the dispatch
 * plugin's attention ledger — so the archive channel and the pin channel
 * answer "who is this session" from one account. Three classes exist:
 * `human`, `bot-boss` (duty: rotation shifts, watchdog takeovers), and
 * `bot-worker` (bot-dispatched task work); a row with the legacy two-value
 * `bot` class counts as `bot-worker`, and a session with no record at all
 * counts as `human` (the fail-toward-protection default shared with the
 * attention ledger itself).
 *
 * The decision table, with no exemptions (worker archived by boss, boss
 * archived by the successor boss, everything else by a human):
 *
 * | actor \ target | human | bot-boss | bot-worker |
 * |----------------|-------|----------|------------|
 * | `human`        | allow | allow    | allow      |
 * | `bot-boss`     | deny  | allow    | allow      |
 * | `bot-worker`   | deny  | deny     | deny       |
 *
 * An `actor` resolves as follows: absent or blank denies (the route also
 * answers 400 before reaching here, so a denial means a caller bypassed the
 * contract); a `session-…` id (or a bare uuid, the harness's native
 * spelling) looks itself up in the table and an unrecorded session actor is
 * denied — an unclassified identity archives nothing; anything else is a
 * channel name declared by a human caller and resolves to `human`. The
 * actor is self-reported over the loopback REST — the same trust model as
 * `recordManualArchive`: this gate stops honest-but-mistaken automation
 * (the 13:53 R16 misarchive), not a lying caller.
 * @module @linxin666/dsh-session-archive/host/identity
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One session identity class, mirroring the attention ledger's SessionClass. */
export type IdentityClass = 'human' | 'bot-boss' | 'bot-worker'

const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve the acting identity of one archive call against the table.
 * @param actor - caller-declared session id or channel name (from `POST /archive`).
 * @param table - identity classes by canonical session id.
 * @returns the actor's class, or `undefined` when the actor is absent,
 * blank, or a session id with no record (an unclassified identity archives
 * nothing).
 */
export function resolveActorClass(actor: string | undefined, table: ReadonlyMap<string, IdentityClass>): IdentityClass | undefined {
  if (actor === undefined) return undefined
  const trimmed = actor.trim()
  if (trimmed === '') return undefined
  const canonical = trimmed.startsWith('session-')
    ? trimmed
    : BARE_UUID.test(trimmed)
      ? `session-${trimmed}`
      : undefined
  if (canonical === undefined) return 'human' // channel name declared by a human caller
  return table.get(canonical)
}

/**
 * The decision table itself (triclass ruling, 2026-10-29).
 * @param actorClass - resolved actor class; `undefined` denies.
 * @param targetClass - the target session's class (`human` when unrecorded).
 * @returns whether this archive may proceed.
 */
export function mayArchive(actorClass: IdentityClass | undefined, targetClass: IdentityClass): boolean {
  if (actorClass === undefined) return false
  if (actorClass === 'human') return true
  if (actorClass === 'bot-boss') return targetClass !== 'human'
  return false // a bot-worker archives nothing
}

/**
 * Read the attention ledger as an identity table. Tolerant by construction:
 * an absent, unreadable, or corrupt file yields an empty table, which the
 * rules above turn into "every target counts human, every session actor is
 * denied" — fail toward refusing automation, while channel (`manual`)
 * actors keep human-driven archives working.
 * @param dshHome - resolved DSH home directory.
 * @returns identity classes keyed by canonical session id.
 */
export async function readIdentityTable(dshHome: string): Promise<Map<string, IdentityClass>> {
  const table = new Map<string, IdentityClass>()
  let raw: string
  try {
    raw = await readFile(join(dshHome, 'session-attention.json'), 'utf8')
  } catch {
    return table
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return table
  }
  if (typeof parsed !== 'object' || parsed === null) return table
  const sessions = (parsed as { sessions?: unknown }).sessions
  if (typeof sessions !== 'object' || sessions === null) return table
  for (const [id, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (id === '' || typeof value !== 'object' || value === null) continue
    const cls = (value as { class?: unknown }).class
    if (cls === 'human' || cls === 'bot-boss' || cls === 'bot-worker') table.set(id, cls)
    else if (cls === 'bot') table.set(id, 'bot-worker') // pre-triclass row
  }
  return table
}
