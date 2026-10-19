/**
 * The dispatch quick ledger ("kuai zhang"): durable task-to-session bindings
 * written when a dispatch carries an opaque `taskRef`, plus the live-alive
 * query the 409 dedupe gate and `GET /api/session-dispatch/bindings` share.
 *
 * This ledger records what a session is *doing* (the runtime occupancy
 * sensor); it is not the task account of record — the git board stays the
 * only authority. Bindings therefore live on local disk
 * (`$DSH_HOME/dispatch-bindings.json`), never in the repository, and a dead
 * binding is not deleted: the bindings endpoint reports `alive: false` and
 * the caller decides (reclaim, re-dispatch, or ignore).
 *
 * Aliveness reads `$DSH_HOME/storages/workspace.json`: a session is alive
 * when its id appears in some workspace's `sessionIds` and not in
 * `global.archivedSessionIds`. An unreadable workspace store fails open to
 * an empty alive set, which releases every 409 rather than blocking dispatch.
 * @module dsh-session-dispatch/host/bindings
 */

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DispatchBinding, DispatchBindingStore, DispatchBindingView } from './routes.ts'

/** Persisted ledger document. Append-only in practice; full rewrite per write. */
export interface BindingsDocument {
  version: 1
  bindings: DispatchBinding[]
}

export function createBindingsDocument(): BindingsDocument {
  return { version: 1, bindings: [] }
}

/** Canonical session-id spelling: the workspace store mixes bare uuids with `session-<uuid>`. */
export function canonicalSessionId(id: string): string {
  return id.startsWith('session-') ? id : `session-${id}`
}

/**
 * Tolerant deserialize: corrupt or foreign documents yield `undefined` so the
 * caller can quarantine the file and rebuild (fail-open with a trace).
 */
export function deserializeBindings(raw: string): BindingsDocument | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const doc = parsed as { version?: unknown; bindings?: unknown }
  if (doc.version !== 1 || !Array.isArray(doc.bindings)) return undefined
  const bindings: DispatchBinding[] = []
  for (const value of doc.bindings) {
    if (typeof value !== 'object' || value === null) continue
    const b = value as { taskRef?: unknown; sessionId?: unknown; workspaceId?: unknown; title?: unknown; createdAt?: unknown }
    if (typeof b.taskRef !== 'string' || b.taskRef === '') continue
    if (typeof b.sessionId !== 'string' || b.sessionId === '') continue
    if (typeof b.workspaceId !== 'string' || b.workspaceId === '') continue
    if (typeof b.createdAt !== 'string' || b.createdAt === '') continue
    if (b.title !== undefined && typeof b.title !== 'string') continue
    bindings.push({
      taskRef: b.taskRef,
      sessionId: b.sessionId,
      workspaceId: b.workspaceId,
      ...(typeof b.title === 'string' ? { title: b.title } : {}),
      createdAt: b.createdAt,
    })
  }
  return { version: 1, bindings }
}

/** Extract the alive set from a parsed workspace-store document (structural read). */
export function aliveSessionIdsFromWorkspaceStore(parsed: unknown): Set<string> {
  const alive = new Set<string>()
  if (typeof parsed !== 'object' || parsed === null) return alive
  const doc = parsed as { global?: { archivedSessionIds?: unknown }; tables?: { workspaces?: unknown } }
  const archived = new Set<string>()
  if (Array.isArray(doc.global?.archivedSessionIds)) {
    for (const id of doc.global.archivedSessionIds) {
      if (typeof id === 'string') archived.add(canonicalSessionId(id))
    }
  }
  const workspaces = doc.tables?.workspaces
  if (typeof workspaces === 'object' && workspaces !== null) {
    for (const row of Object.values(workspaces as Record<string, unknown>)) {
      const sessionIds = (row as { sessionIds?: unknown } | null)?.sessionIds
      if (!Array.isArray(sessionIds)) continue
      for (const id of sessionIds) {
        if (typeof id !== 'string') continue
        const canonical = canonicalSessionId(id)
        if (!archived.has(canonical)) alive.add(canonical)
      }
    }
  }
  return alive
}

/** Atomic JSON write: unique temp file, fsync, rename. Mirrors the archive ledger. */
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

/** Options for the file-backed store. */
export interface FileBindingStoreOptions {
  /** Ledger document path, typically `$DSH_HOME/dispatch-bindings.json`. */
  readonly bindingsPath: string
  /** Workspace-store path, typically `$DSH_HOME/storages/workspace.json`. */
  readonly workspaceStorePath: string
}

/**
 * File-backed binding store. Every operation re-reads disk, so a reader
 * always sees the state behind the last atomic rename and no cache can drift
 * from the workspace store's aliveness. A corrupt ledger is quarantined to
 * `<path>.corrupt-<epoch>` (the trace) and rebuilt empty — fail-open, never a
 * crash loop.
 */
export class FileBindingStore implements DispatchBindingStore {
  private readonly bindingsPath: string
  private readonly workspaceStorePath: string

  constructor(options: FileBindingStoreOptions) {
    this.bindingsPath = options.bindingsPath
    this.workspaceStorePath = options.workspaceStorePath
  }

  private async readDocument(): Promise<BindingsDocument> {
    let raw: string
    try {
      raw = await readFile(this.bindingsPath, 'utf8')
    } catch {
      return createBindingsDocument()
    }
    const doc = deserializeBindings(raw)
    if (doc !== undefined) return doc
    // Corrupt ledger: quarantine it as evidence, then start fresh.
    const quarantine = `${this.bindingsPath}.corrupt-${Date.now()}`
    await rename(this.bindingsPath, quarantine).catch(() => {})
    return createBindingsDocument()
  }

  private async readAlive(): Promise<Set<string>> {
    try {
      const raw = await readFile(this.workspaceStorePath, 'utf8')
      return aliveSessionIdsFromWorkspaceStore(JSON.parse(raw))
    } catch {
      // Fail open: an unreadable workspace store releases the dedupe gate
      // instead of wedging dispatch behind a broken store.
      return new Set()
    }
  }

  async findAlive(taskRef: string): Promise<DispatchBinding | undefined> {
    const doc = await this.readDocument()
    const matches = doc.bindings.filter((binding) => binding.taskRef === taskRef)
    if (matches.length === 0) return undefined
    const alive = await this.readAlive()
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const binding = matches[i]!
      if (alive.has(canonicalSessionId(binding.sessionId))) return binding
    }
    return undefined
  }

  async record(binding: DispatchBinding): Promise<void> {
    const doc = await this.readDocument()
    doc.bindings.push(binding)
    await writeJsonAtomic(this.bindingsPath, doc)
  }

  async list(): Promise<DispatchBindingView[]> {
    const doc = await this.readDocument()
    const alive = await this.readAlive()
    return doc.bindings.map((binding) => ({
      ...binding,
      alive: alive.has(canonicalSessionId(binding.sessionId)),
    }))
  }
}

/** Resolve the default store paths under a DSH home directory. */
export function defaultStorePaths(dshHome: string): { bindingsPath: string; workspaceStorePath: string } {
  return {
    bindingsPath: join(dshHome, 'dispatch-bindings.json'),
    workspaceStorePath: join(dshHome, 'storages', 'workspace.json'),
  }
}
