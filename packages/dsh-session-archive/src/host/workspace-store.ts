/**
 * Workspace-domain mutations for dsh-session-archive. Archive and unarchive
 * both go through public registry verbs: `archiveSession` existed at
 * 0.1.5-rc.1, and 0.1.6-alpha.1 added `unarchiveSession`, which retired the
 * earlier workaround that reached into the registry's private
 * `requireState`/`setState` domain handles to edit the archive set itself.
 * Workspace-row cleanup (physical delete only) still uses the entity
 * `mutate` path, which has no public equivalent. Every write flows through
 * the domain storage, so the workspace feed publishes follow frames and every
 * connected browser sees the change without a reload. The seams are
 * feature-detected and pinned to the SDK cohort; when absent, operations fail
 * with `missing-seam` instead of guessing at files.
 * @module @linxin666/dsh-session-archive/host/workspace-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the workspaceRegistry Context merge (dsh-workspace face)
// and the `workspace/session-stop` archive-admission event declaration.
import type {} from '@deepseek-ai/dsh-workspace'
import { canonicalSessionId } from './session-files.ts'

/** Minimal runtime shape the registry must expose for durable archive-set writes. */
interface RegistrySeam {
  unarchiveSession?(sessionId: string): Promise<void>
  archivedSessionIds: readonly string[]
  list(): WorkspaceEntityLike[]
}

interface WorkspaceEntityLike {
  id: string
  path: string
  title: string
  sessionIds: readonly string[]
  mutate?(fn: (record: WorkspaceRecordLike) => WorkspaceRecordLike): Promise<void>
}

export interface WorkspaceRecordLike {
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

/** Whether the public unarchive verb is present on this registry instance. */
export function unarchiveSeamAvailable(registry: unknown): boolean {
  const seam = registry as RegistrySeam
  return typeof seam?.unarchiveSession === 'function'
}

/**
 * Remove ids from the registry-global archive set through the public
 * `workspaceRegistry.unarchiveSession` verb. Idempotent for ids that are not
 * archived (the verb resolves without writing). Callers pass the harness's
 * native id spelling, because the stored set mixes spellings.
 */
export async function unarchiveSessions(registry: unknown, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const seam = registry as RegistrySeam
  if (!unarchiveSeamAvailable(seam)) {
    throw new Error('workspace registry does not expose unarchiveSession')
  }
  for (const id of ids) await seam.unarchiveSession?.(id)
}

/**
 * Archive one session through the public verb. Idempotent for already
 * archived ids; throws when the session does not exist live or in
 * persistence.
 */
export async function archiveSession(ctx: Context, id: string): Promise<void> {
  const registry = ctx.workspaceRegistry as unknown as {
    archiveSession?(sessionId: string): Promise<void>
  }
  if (typeof registry?.archiveSession !== 'function') {
    throw new Error('workspace registry does not expose archiveSession')
  }
  await registry.archiveSession(id)
  // The registry dispatches `workspace/session-stop` only for archives ordered
  // with `stopActivity`; this wrapper archives without it — the activity check
  // already refused a session with running work, so on this path the seam
  // would otherwise never reach its providers. Dispatch it here, after the
  // durable write and with the same payload the registry uses, so archive-time
  // reclamation (win_bash's persistent shell) covers manual, override and
  // janitor archives alike; an already-archived id is a registry no-op and
  // stopping its residual work is the same outcome the stopActivity path
  // produces. A rejecting provider — or a host that cannot dispatch at all —
  // must not undo the archive: the registry logs provider failures and keeps
  // the write, and this dispatch follows that rule.
  try {
    await ctx.parallel('workspace/session-stop', { sessionId: id as SessionId })
  } catch (error: unknown) {
    ctx.logger?.warn?.(`workspace: archive stop dispatch for '${id}' failed: ${String(error)}`)
  }
}

/**
 * Remove ids from every workspace's durable `sessionIds` account. Goes
 * through the entity `mutate` path (durable table update + record refresh +
 * feed upsert). Returns the ids actually removed from at least one row.
 */
export async function removeFromWorkspaceRows(registry: unknown, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const seam = registry as RegistrySeam
  const drop = new Set(ids.map(canonicalSessionId))
  const matches = (id: string): boolean => drop.has(canonicalSessionId(id))
  const touched: string[] = []
  let entities: WorkspaceEntityLike[]
  try {
    entities = seam.list()
  } catch {
    return []
  }
  for (const entity of entities) {
    if (typeof entity.mutate !== 'function') continue
    if (!entity.sessionIds.some(matches)) continue
    await entity.mutate((record) => ({
      ...record,
      sessionIds: record.sessionIds.filter((id) => !matches(id)),
    }))
    touched.push(entity.id)
  }
  return touched
}
