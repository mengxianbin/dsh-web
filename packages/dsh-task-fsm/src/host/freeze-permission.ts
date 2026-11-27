/**
 * §6.2 freeze permission table (freeze-reclaim-design-1127, ruling `q-perm`)
 * — the rules that narrow the MACHINE's auto-freeze reach, as a pure
 * predicate with zero I/O of its own:
 *
 *   · **human sessions never enter the auto-freeze list** (the 底线: the
 *     machine does not freeze what a human is talking to);
 *   · **an undeclared session class degrades to `human`** — fail toward
 *     protection, the same direction the attention ledger itself takes
 *     (dsh-session-dispatch attention.ts: anything undeclared reads human);
 *   · **bot sessions freeze only inside a declared scope** (人开 scope 声明,
 *     `ScopeDecl`) — a row whose scope nobody declared stays out (bot 只在
 *     自己 scope 内);
 *   · **解冻永可用**: this module only ever *narrows* freezing. Human
 *     freezes (routes) and every wake/unfreeze path are NOT gated here —
 *     §6.2 explicitly keeps unfreeze available so the machine can never
 *     lock a human out (防自锁).
 *
 * The session-class source is a neutral structural surface (no package
 * dependency), mirroring `DispatchAttentionApi.classes()` in
 * dsh-session-dispatch. The production default reads the same ledger file
 * `$DSH_HOME/session-attention.json` those routes write — a multi-reader of
 * one file is the established pattern (dsh-session-archive reads it too),
 * and a torn/unreadable ledger answers `{}` = nobody auto-freezes.
 * @module dsh-task-fsm/host/freeze-permission
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskRecord } from '../core/schema.ts'

/** Session class — structural mirror of dsh-session-dispatch `SessionClass` (routes.ts). */
export type SessionClass = 'human' | 'bot-boss' | 'bot-worker'

/** canonical session id → class; an absent id is undeclared (reads human). */
export type AttentionTable = Readonly<Record<string, SessionClass>>

/**
 * §6.2 选行判据: may the machine auto-freeze this record right now?
 *
 * Pure — no file, no clock, no event. The E7 loop calls it per candidate
 * row AFTER its own state/session checks; a `false` answer means the row
 * keeps its current state (no history, no write).
 * @param record - the candidate task record (caller already checked
 *   `state === 'active'` and an active bound session).
 * @param attention - the session-class table for this tick.
 * @param declaredScopes - keys of `file.scopes` (人开 scope 声明).
 * @returns true only for a bot-class session inside a declared scope.
 */
export function mayAutoFreeze(
  record: TaskRecord,
  attention: AttentionTable,
  declaredScopes: ReadonlySet<string>,
): boolean {
  const id = record.session?.id
  if (id === undefined || id === '') return false
  // 底线: undeclared = human → protected; only an explicit bot class qualifies.
  const cls: SessionClass = attention[id] ?? 'human'
  if (cls === 'human') return false
  // bot 只在自己 scope 内: the row's scope must be a declared (人开) scope.
  return declaredScopes.has(record.scope)
}

/**
 * Tolerant synchronous read of the attention ledger → lookup table.
 *
 * One small-file read per sustained below-enter tick (the healthy path and
 * the 30s time-axis hold never call it). Every failure mode — missing file, torn JSON, foreign shape, legacy
 * `bot` rows — resolves to a partial table or `{}`, never a throw: the
 * failure direction is always "fewer rows freeze".
 * @param dshHome - DSH home holding `session-attention.json`.
 * @returns id → class (legacy `bot` normalizes to `bot-worker`, attention.ts 同约).
 */
export function readAttentionTable(dshHome: string): AttentionTable {
  try {
    const raw = readFileSync(join(dshHome, 'session-attention.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown; sessions?: unknown }
    if (parsed.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) return {}
    const table: Record<string, SessionClass> = {}
    for (const [id, row] of Object.entries(parsed.sessions as Record<string, unknown>)) {
      if (id === '') continue
      const cls = (row as { class?: unknown } | null)?.class
      if (cls === 'human' || cls === 'bot-boss' || cls === 'bot-worker') table[id] = cls
      else if (cls === 'bot') table[id] = 'bot-worker' // legacy two-value rows (attention.ts:97)
    }
    return table
  } catch {
    return {} // unreadable ledger = treat every session as human (fail toward 底线)
  }
}
