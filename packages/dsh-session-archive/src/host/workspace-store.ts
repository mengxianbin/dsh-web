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
 * Caller choices for {@link archiveSession} (C′ 归档即停轮, 2026-11-19 裁定).
 */
export interface ArchiveSessionCallOptions {
  /**
   * Order the archive with the registry's `stopActivity` — the archive set
   * is written first, then the native `workspace/session-stop` dispatches —
   * so an archive issued from inside a running turn can land at all (the
   * plain verb refuses a running turn: the 回合并归档死结 this ruling closes).
   * 加固A: the stop is taken only when the activity waterfall reports the
   * `turn` family alone; any other running family (job / subagent /
   * schedule / probe), an empty list (nothing running — the plain path
   * archives freely anyway) or a failed query falls back to the plain
   * archive, whose own activity check refuses exactly as before.
   */
  readonly stopTurn?: boolean
}

/**
 * 加固A (C′, ruling 2026-11-19): whether `workspace/session-activity`
 * reports the `turn` family and nothing else. A failed query answers
 * `false` — the caller falls back to the plain archive, whose own check
 * decides (fail-closed toward today's behaviour, never toward a wider stop).
 * The `kind` union reads through this package's view of the harness map
 * (providers merge their keys from packages this plugin does not compile
 * against), so the structural string read is the wire shape that matters.
 */
async function turnFamilyAlone(ctx: Context, id: string): Promise<boolean> {
  try {
    const activity: readonly { readonly kind: string }[] = await ctx.waterfall(
      'workspace/session-activity',
      { sessionId: id as SessionId },
      () => Promise.resolve([]),
    )
    return activity.length > 0 && activity.every((entry) => entry.kind === 'turn')
  } catch (error: unknown) {
    ctx.logger?.warn?.(`workspace: session-activity query for '${id}' failed: ${String(error)} — falling back to plain archive`)
    return false
  }
}

/**
 * Archive one session through the public verb. Idempotent for already
 * archived ids; throws when the session does not exist live or in
 * persistence. With {@link ArchiveSessionCallOptions.stopTurn} and a
 * turn-only activity answer, the archive is ordered with `stopActivity`
 * (C′) and the registry issues the stop itself — see the option for the
 * 加固A fallback rules.
 */
export async function archiveSession(ctx: Context, id: string, options: ArchiveSessionCallOptions = {}): Promise<void> {
  const registry = ctx.workspaceRegistry as unknown as {
    archiveSession?(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
  }
  if (typeof registry?.archiveSession !== 'function') {
    throw new Error('workspace registry does not expose archiveSession')
  }
  const stopTurn = options.stopTurn === true && (await turnFamilyAlone(ctx, id))
  if (stopTurn) {
    // The registry writes the archive set first, then dispatches
    // `workspace/session-stop` itself (stopSessionActivity — the same event
    // this wrapper's manual dispatch below would send), so the manual
    // dispatch is skipped: one stop, issued after durability, provider
    // failures logged without undoing the write — identical to the native
    // stop-and-archive confirm's ordering.
    await registry.archiveSession(id, { stopActivity: true })
    return
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
