/**
 * The pending-decision ledger (design session-auto-revival-design-1102 §4.2
 * rule one, revive-restart-gap-1126): the independent file
 * `<dsh-home>/session-revive-pending.json` that carries a deferred revive
 * decision across a UI restart. The v2 machine's pending set was pure process
 * memory — a restart evaporated it and the session slept until a manual
 * continue (the 2026-11-26 incident: a TRANSPORT death deferred on a red
 * probe, the UI restarted, the pending died with the process, the boot sweep
 * only scans unclosed turns so the error-closed session was invisible).
 *
 * The persisted field set is the `releaseDue` input surface and nothing more:
 * pending (plannedAt/code/channel) + route evidence + cooldownUntil. Strikes,
 * stopped, attempt, relay and wave/breaker counters stay restart-cleared per
 * design §4.2 rule one (they are the ruled account's, not the release's).
 *
 * Mirror of the `v2-state.ts` contract, with one deliberate difference: the
 * reader is a SEPARATE fail-closed face. The shell reads the file ONCE at
 * activation (single-read availability gate), replays the entries through the
 * machine's idempotent `restorePending`, and seeds the writer with the very
 * entries it read — so a quiet machine costs zero writes and a replayed
 * ledger is never rewritten byte-identically. A read that fails or a file
 * past {@link PENDING_MAX_ENTRIES} entries is CORRUPT: the shell skips ALL
 * replay (宁漏不误复活) and creates no writer at all, so an unreadable ledger
 * is preserved for the next boot instead of being clobbered by an empty one.
 * @module dsh-session-revive/pending-state
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import type { RevivePendingEntry, RevivePendingExport } from './v2-machine.ts'

/** Ledger filename under the DSH home. */
export const REVIVE_PENDING_FILE = 'session-revive-pending.json'

/**
 * Entry-count bound: the file must stay finite, and a corrupt or hostile
 * file past this many sessions is rejected whole (fail-closed) rather than
 * replayed at scale. A real deferred set is a handful of sessions; 4096
 * clears any plausible mass-defer wave while bounding the parse.
 */
export const PENDING_MAX_ENTRIES = 4096

/** Injectable write seam so tests never touch the real DSH home. */
export type RevivePendingWrite = (path: string, payload: string) => void

/** The single boot read's result: entries to replay, or the corruption that skips ALL replay. */
export type RevivePendingRead =
  | { readonly ok: true; readonly entries: Record<string, RevivePendingEntry> }
  | { readonly ok: false; readonly error: string }

function atomicWrite(path: string, payload: string): void {
  const temp = `${path}.tmp`
  writeFileSync(temp, payload, 'utf8')
  renameSync(temp, path)
}

/** One entry's validation: any malformed field fails the WHOLE file (宁漏不误复活). */
function parseEntry(value: unknown): RevivePendingEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const { plannedAt, code, channel, route, cooldownUntil } = raw
  if (typeof plannedAt !== 'number' || !Number.isFinite(plannedAt)) return null
  if (channel !== 'fresh' && channel !== 'zero-cost' && channel !== 'progress-retry') return null
  if (code !== undefined && typeof code !== 'string') return null
  if (typeof cooldownUntil !== 'number' || !Number.isFinite(cooldownUntil)) return null
  let parsedRoute: { provider: string; model?: string } | undefined
  if (route !== undefined) {
    if (typeof route !== 'object' || route === null) return null
    const rawRoute = route as Record<string, unknown>
    if (typeof rawRoute.provider !== 'string') return null
    if (rawRoute.model !== undefined && typeof rawRoute.model !== 'string') return null
    parsedRoute = { provider: rawRoute.provider, ...(rawRoute.model === undefined ? {} : { model: rawRoute.model }) }
  }
  // Field order mirrors pendingSnapshot() so a replayed ledger re-stringifies
  // byte-identically (the writer's change-only comparison depends on it).
  return {
    plannedAt,
    ...(code === undefined ? {} : { code }),
    channel,
    ...(parsedRoute === undefined ? {} : { route: parsedRoute }),
    cooldownUntil,
  }
}

/**
 * The one boot read (design §4.2 rule one): parse and validate the ledger
 * once at activation. A missing file is a clean empty read (first boot); a
 * parse error, a malformed shape or an entry past the bound is CORRUPTION —
 * the caller must skip all replay and log loudly, never guess.
 * @param path - explicit file (tests); defaults to `<dsh-home>/session-revive-pending.json`.
 * @returns the validated entries, or the reason the whole file is unusable.
 */
export function readPendingEntries(path?: string): RevivePendingRead {
  const file = path ?? join(dshHome(), REVIVE_PENDING_FILE)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true, entries: {} }
    return { ok: false, error: `${code ?? 'read-failed'}: ${String(error).slice(0, 200)}` }
  }
  try {
    const parsed = JSON.parse(raw) as { sessions?: unknown }
    const sessions = parsed.sessions
    if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) {
      return { ok: false, error: 'malformed ledger: sessions is not an object' }
    }
    const entries = Object.entries(sessions as Record<string, unknown>)
    if (entries.length > PENDING_MAX_ENTRIES) {
      return { ok: false, error: `malformed ledger: ${entries.length} entries exceed the ${PENDING_MAX_ENTRIES} bound` }
    }
    const validated: Record<string, RevivePendingEntry> = {}
    for (const [sessionId, value] of entries) {
      const entry = parseEntry(value)
      if (entry === null) return { ok: false, error: `malformed ledger: bad entry for ${sessionId}` }
      validated[sessionId] = entry
    }
    return { ok: true, entries: validated }
  } catch (error) {
    return { ok: false, error: `parse-failed: ${String(error).slice(0, 200)}` }
  }
}

/**
 * The change-only writer: `sync` writes iff the sessions payload differs from
 * the seeded read (or the file has never been seeded/written), so a replayed
 * ledger costs zero writes and only a real decision flip lands. Writes are
 * atomic (temp then rename) and best-effort: a ledger hiccup must never bubble
 * into the revival chain — a failed write retries on the next real change.
 * A snapshot past {@link PENDING_MAX_ENTRIES} is NOT written: landing it would
 * produce a file the reader itself rejects on the next boot (self-inflicted
 * fail-closed), so the stale-but-readable ledger wins.
 */
export class RevivePendingWriter {
  private readonly path: string
  private readonly write: RevivePendingWrite
  private lastPayload: string | undefined

  constructor(
    options: {
      home?: string
      path?: string
      write?: RevivePendingWrite
      seed?: Readonly<Record<string, RevivePendingEntry>>
    } = {},
  ) {
    this.path = options.path ?? join(options.home ?? dshHome(), REVIVE_PENDING_FILE)
    this.write = options.write ?? atomicWrite
    // Seed from the single boot read (never re-read): byte-identical entries
    // stringify byte-identically, so the replay itself writes nothing.
    if (options.seed !== undefined) this.lastPayload = JSON.stringify(options.seed)
  }

  /**
   * Publish one snapshot iff its `sessions` payload flipped since the seeded
   * read. `at` only rides along — it is never part of the comparison.
   * @param snapshot - the machine's pending-decision document.
   * @returns true when a write happened.
   */
  sync(snapshot: RevivePendingExport): boolean {
    const payload = JSON.stringify(snapshot.sessions)
    if (payload === this.lastPayload) return false
    if (Object.keys(snapshot.sessions).length > PENDING_MAX_ENTRIES) return false
    try {
      this.write(this.path, `${JSON.stringify({ at: snapshot.at, sessions: snapshot.sessions })}\n`)
      this.lastPayload = payload
      return true
    } catch {
      // Best-effort: see module doc. The baseline stays at the last SUCCESSFUL
      // write, so a transient failure retries on the next real change.
      return false
    }
  }
}
