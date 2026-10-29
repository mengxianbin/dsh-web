/**
 * Session attention classification ("human" vs "bot" origin) plus the
 * once-per-Session default-pin pass that consumes it.
 *
 * The class answers who a Session serves, not who typed first:
 * human-dispatched task Sessions are `human`, bot duty Sessions (rotation,
 * watchdog takeover) are `human`, bot-dispatched task Sessions are `bot`
 * (user ruling, 2026-10-29). Callers declare the class on
 * `POST /api/session-dispatch`; anything undeclared — a Session created in
 * the UI, or a Session that predates this ledger — is classified `human`,
 * which fails toward attention: an unwanted pin is one click away, while a
 * buried human Session is the problem this ledger exists to solve.
 *
 * The default applies at most once per Session (`defaultApplied`). Three
 * triggers race for that single application — the startup pass over every
 * current workspace member, the dispatch declaration at creation, and the
 * first real user message on anything the first two missed — and once any of
 * them records `defaultApplied: true`, no later pass ever touches that pin
 * again. There is deliberately no re-pin sweep and no manual-override side
 * channel: the default is a one-time nudge, not a standing policy (user
 * ruling, 2026-10-29: "every session once; manual changes survive every
 * restart").
 *
 * State lives at `$DSH_HOME/session-attention.json`, written atomically
 * (temp + fsync + rename, the bindings ledger's writer) and loaded once per
 * process; a corrupt file is quarantined to `<path>.corrupt-<epoch>` and
 * rebuilt empty — the fail-open shape of the bindings ledger beside it.
 * Losing records degrades to `human` on the next startup pass (fail toward
 * pinning), never to a crash, and a rejected pin keeps
 * `defaultApplied: false` so the next trigger retries instead of pretending
 * the default landed.
 * @module dsh-session-dispatch/host/attention
 */

import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalSessionId, writeJsonAtomic } from './bindings.ts'
import type { SessionClass } from './routes.ts'

/** Where a Session's class (and its default) first came from. */
export type AttentionSource = 'startup' | 'dispatch' | 'first-message'

/** One Session's attention record. */
export interface AttentionRecord {
  readonly class: SessionClass
  /** True once this Session's default pin state has been applied successfully. */
  readonly defaultApplied: boolean
  readonly source: AttentionSource
  readonly updatedAt: string
}

/** Persisted ledger document. Full rewrite per write, like the bindings ledger. */
export interface AttentionDocument {
  readonly version: 1
  readonly sessions: Record<string, AttentionRecord>
}

export function createAttentionDocument(): AttentionDocument {
  return { version: 1, sessions: {} }
}

/**
 * Tolerant deserialize: a foreign document yields `undefined` so the caller
 * can quarantine the file and rebuild; individual malformed rows are dropped
 * (they re-declare as `human` on the next startup pass — fail toward
 * pinning).
 * @param raw - file contents.
 * @returns the parsed document, or undefined when the file itself is corrupt.
 */
export function deserializeAttention(raw: string): AttentionDocument | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const doc = parsed as { version?: unknown; sessions?: unknown }
  if (doc.version !== 1 || typeof doc.sessions !== 'object' || doc.sessions === null || Array.isArray(doc.sessions)) {
    return undefined
  }
  const sessions: Record<string, AttentionRecord> = {}
  for (const [id, value] of Object.entries(doc.sessions as Record<string, unknown>)) {
    if (id === '') continue
    if (typeof value !== 'object' || value === null) continue
    const row = value as { class?: unknown; defaultApplied?: unknown; source?: unknown; updatedAt?: unknown }
    if (row.class !== 'human' && row.class !== 'bot') continue
    if (typeof row.defaultApplied !== 'boolean') continue
    const source: AttentionSource = row.source === 'dispatch' || row.source === 'first-message' ? row.source : 'startup'
    sessions[id] = {
      class: row.class,
      defaultApplied: row.defaultApplied,
      source,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    }
  }
  return { version: 1, sessions }
}

/** Resolve the attention ledger path under a DSH home directory. */
export function defaultAttentionPath(dshHome: string): string {
  return join(dshHome, 'session-attention.json')
}

/**
 * Structural workspace-registry surface the ledger consumes, so the package
 * stays decoupled from the registry package's version (same convention as
 * `DispatchSessionApi`). Ids are plain strings here; the real registry's
 * branded `SessionId` satisfies every member bivariantly.
 */
export interface AttentionRegistry {
  /** All active Workspaces (only `sessionIds` is read). */
  list(): readonly { readonly sessionIds: readonly string[] }[]
  /** Registry-global archive set (pinning an archived Session throws). */
  readonly archivedSessionIds: readonly string[]
  pinSession(sessionId: string): Promise<void>
  unpinSession(sessionId: string): Promise<void>
}

/** Options for the ledger. */
export interface AttentionLedgerOptions {
  readonly registry: AttentionRegistry
  /** Ledger document path, typically `$DSH_HOME/session-attention.json`. */
  readonly attentionPath: string
  /** Clock seam for `updatedAt` (test injection). */
  readonly now?: () => string
}

/**
 * File-backed attention ledger. Every operation runs on one internal chain
 * (load first, then mutate + persist), so the startup pass, dispatch
 * declarations, and first-message hooks can all fire without interleaving a
 * read-modify-write. Membership is re-read from the registry on every
 * operation: only Sessions listed in some workspace and not archived are
 * ever classified or pinned — subagent children, side threads, and forks
 * never join a workspace list, so they stay out of the pin set by
 * construction.
 */
export class AttentionLedger {
  private readonly registry: AttentionRegistry
  private readonly attentionPath: string
  private readonly now: () => string
  private table: AttentionDocument | undefined
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: AttentionLedgerOptions) {
    this.registry = options.registry
    this.attentionPath = options.attentionPath
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /** Run one operation exclusively behind the chain (the previous step's failure never wedges the next). */
  private tx<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async load(): Promise<AttentionDocument> {
    if (this.table !== undefined) return this.table
    let raw: string
    try {
      raw = await readFile(this.attentionPath, 'utf8')
    } catch {
      this.table = createAttentionDocument()
      return this.table
    }
    const doc = deserializeAttention(raw)
    if (doc !== undefined) {
      this.table = doc
      return doc
    }
    // Corrupt ledger: quarantine it as evidence, then start fresh.
    const quarantine = `${this.attentionPath}.corrupt-${Date.now()}`
    await rename(this.attentionPath, quarantine).catch(() => {})
    this.table = createAttentionDocument()
    return this.table
  }

  /**
   * Canonical id -> the id as the workspace lists it, for every current,
   * non-archived member. Pinning uses the listed spelling because that is
   * the row id the client matches against `pinnedSessionIds`; the canonical
   * key keeps one record per Session across either spelling.
   */
  private members(): Map<string, string> {
    const archived = new Set(this.registry.archivedSessionIds.map(canonicalSessionId))
    const members = new Map<string, string>()
    for (const workspace of this.registry.list()) {
      for (const id of workspace.sessionIds) {
        const canonical = canonicalSessionId(String(id))
        if (archived.has(canonical)) continue
        if (!members.has(canonical)) members.set(canonical, String(id))
      }
    }
    return members
  }

  /**
   * Apply one Session's default pin state: `human` pins, `bot` unpins.
   * @returns false when the registry refused (session unknown right now, or
   * archived mid-race) so the caller keeps `defaultApplied` false and the
   * next trigger retries.
   */
  private async applyDefault(sessionClass: SessionClass, sessionId: string): Promise<boolean> {
    try {
      if (sessionClass === 'human') await this.registry.pinSession(sessionId)
      else await this.registry.unpinSession(sessionId)
      return true
    } catch {
      return false
    }
  }

  /** Record a fresh classification, apply its default, and persist. */
  private async settle(table: AttentionDocument, canonical: string, sessionId: string, sessionClass: SessionClass, source: AttentionSource): Promise<void> {
    const applied = await this.applyDefault(sessionClass, sessionId)
    table.sessions[canonical] = { class: sessionClass, defaultApplied: applied, source, updatedAt: this.now() }
    await writeJsonAtomic(this.attentionPath, table)
  }

  /** Retry a record whose default never landed; no write when nothing changed. */
  private async applyPending(table: AttentionDocument, canonical: string, pinTarget: string, record: AttentionRecord): Promise<void> {
    const applied = await this.applyDefault(record.class, pinTarget)
    if (applied === record.defaultApplied) return
    table.sessions[canonical] = { ...record, defaultApplied: applied, updatedAt: this.now() }
    await writeJsonAtomic(this.attentionPath, table)
  }

  /**
   * Startup pass: classify every current workspace member that predates the
   * ledger as `human` (one default pin), and retry any record whose default
   * has not landed. Sessions already marked applied are untouched — that is
   * the ruling's "once per Session" guarantee.
   * @returns resolution after the pass (rejections surface store failures; callers fail open).
   */
  startupPass(): Promise<void> {
    return this.tx(async () => {
      const table = await this.load()
      for (const [canonical, sessionId] of this.members()) {
        const record = table.sessions[canonical]
        if (record === undefined) await this.settle(table, canonical, sessionId, 'human', 'startup')
        else if (!record.defaultApplied) await this.applyPending(table, canonical, sessionId, record)
      }
    })
  }

  /**
   * Dispatch declaration: record the declared class for a freshly created
   * Session and apply its default at once. Always called (with the wire
   * default `human` when the field is absent) before the first prompt is
   * queued, so a bot-declared Session can never win a first-message race
   * against its own classification.
   * @param sessionId - id as created by the Host session service.
   * @param sessionClass - the dispatcher's declared class.
   * @returns resolution after the record is persisted (a store failure rejects).
   */
  declare(sessionId: string, sessionClass: SessionClass): Promise<void> {
    return this.tx(async () => {
      const table = await this.load()
      const canonical = canonicalSessionId(sessionId)
      const listed = this.members().get(canonical) ?? sessionId
      const record = table.sessions[canonical]
      if (record === undefined) {
        await this.settle(table, canonical, listed, sessionClass, 'dispatch')
        return
      }
      // A pre-existing record keeps its applied state; only a pending default
      // is retried, under the freshest declared class.
      if (!record.defaultApplied) await this.applyPending(table, canonical, listed, { ...record, class: sessionClass, source: 'dispatch' })
    })
  }

  /**
   * First real user message: give an undeclared Session the `human` default
   * (and retry a pending record). Workspace membership gates this path —
   * subagent children emit user messages too but are not workspace members,
   * so they are never recorded or pinned.
   * @param sessionId - id as reported by the session event stream.
   * @returns resolution after the check (rejections surface store failures; callers fail open).
   */
  ensureFirstMessage(sessionId: string): Promise<void> {
    return this.tx(async () => {
      const table = await this.load()
      const canonical = canonicalSessionId(sessionId)
      const listed = this.members().get(canonical)
      if (listed === undefined) return
      const record = table.sessions[canonical]
      if (record === undefined) {
        await this.settle(table, canonical, listed, 'human', 'first-message')
        return
      }
      if (!record.defaultApplied) await this.applyPending(table, canonical, listed, record)
    })
  }
}
