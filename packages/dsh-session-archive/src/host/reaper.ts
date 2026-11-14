/**
 * Subagent idle reaper + cascade ledger reconcile (archive-cascade-reap-1114).
 *
 * Pure decision logic — the scheduler wiring (24h throttle, operation lock,
 * service-face access) lives in `janitor.ts` (`reapIdleSubagents`, design §四).
 * Two passes share one feed projection per cycle (design §四/§五):
 *
 * 1. **reap** — archive subagents idle past {@link REAP_IDLE_MS} and write the
 *    ledger entry synchronously (⛔ critical constraint, design §四台账条目):
 *    `{ archivedAt: now, source: 'auto', actor: <parent entry actor> ?? 'reaper',
 *    reason: 'idle-2d' }`.
 * 2. **reconcile** — backfill ledger entries for subagent archives the harness
 *    cascade produced while the plugin was away (⛔ design §五): host
 *    `archivedAtById` supplies the time (never fabricated), the parent entry
 *    supplies the actor (`'cascade'` fallback), `reason: 'cascade'`.
 *
 * Neither pass writes journal rows — the journal design pins its three write
 * points (`archive()` / `unarchive()` / `archiveInternal()`); a reaper write
 * point would be an out-of-scope expansion of that single design (recorded
 * decision, design §四 journal 交互). Failure shapes: a refused archive logs
 * loudly and skips its entry (failure-isolated, the rest of the pass keeps
 * going); a feed read or ledger flush failure propagates so the caller leaves
 * its throttle unset and retries on the next tick (design §四 节流语义).
 * @module @linxin666/dsh-session-archive/host/reaper
 */

import type { LedgerDocument, LedgerEntry } from './ledger.ts'
import { canonicalSessionId } from './session-files.ts'

/** Idle threshold: 2 days in ms (判据源 = user 2026-11-14「idle 2天就可以自动归档了」). */
export const REAP_IDLE_MS = 172_800_000

/** In-memory scan throttle: one full pass per 24h (design §四 频率). */
export const REAP_SCAN_INTERVAL_MS = 86_400_000

/** One feed row after defensive parsing; ids kept in both spellings. */
interface ReaperItem {
  /** Native spelling as the feed reported it — what the archive seam expects. */
  native: string
  /** Canonical spelling used for every ledger/registry lookup. */
  canonical: string
  parentNative?: string
  parentCanonical?: string
  /** Feed projection `updatedAt` (ms) — the idle clock; absent = never reaped. */
  updatedAt?: number
  /** Row-level running flag (the live/running/busy protection's feed half). */
  running: boolean
  /** Only `subagent` rows ever enter either pass (top-level/blank stay out). */
  origin?: string
}

/** A cascade child that needs a backfilled ledger entry (design §五). */
interface ReconcileGap {
  canonical: string
  native: string
  parentCanonical: string
  parentNative?: string
  /** Host `archivedAtById` time for this child — the only legal timestamp. */
  hostAt: number
}

/** Counters returned by one cycle, for tests and diagnostics. */
export interface ReapStats {
  /** Subagents archived this cycle (their ledger entry written synchronously). */
  reaped: number
  /** Cascade-orphan ledger entries backfilled this cycle. */
  reconciled: number
}

/** Everything one cycle needs; the janitor assembles it under the op lock. */
export interface ReaperDeps {
  /** Clock; tests inject a fixed one. */
  now(): number
  /** The cycle's single feed read — everything else rides registry getters. */
  listFeed(): Promise<{ items?: unknown[] }>
  /** Fresh archived-session ids, either spelling (re-canonicalized here). */
  archivedSessionIds(): readonly string[]
  /** Fresh host archived-at map, keyed by either spelling. */
  archivedAtById(): Record<string, number> | undefined
  /** Protected (live/busy/…) canonical ids; `running` comes from each row. */
  protectedIds: ReadonlySet<string>
  /** Live ledger document — entries are written in place, then flushed. */
  ledger: LedgerDocument
  /** Archive seam (`archiveSession`); native spelling in, throws on refusal. */
  archive(nativeId: string): Promise<void>
  /** Persist the ledger; rejection propagates (caller's throttle stays unset). */
  flushLedger(): Promise<void>
}

/**
 * Ledger entry under either id spelling; canonical wins. Sibling of
 * `inventory.ts#ledgerEntryFor` — that helper's return type omits `actor`,
 * which is exactly what actor inheritance needs, so reaper keeps its own
 * full-`LedgerEntry` lookup instead of widening inventory's surface.
 */
function entryFor(ledger: LedgerDocument, canonicalId: string, nativeId?: string): LedgerEntry | undefined {
  return ledger.entries[canonicalId]
    ?? (nativeId !== undefined && nativeId !== canonicalId ? ledger.entries[nativeId] : undefined)
}

/** Parse + dedup the feed projection (first spelling of a session wins, as inventory's nativeIds do). */
function uniqueItems(raw: readonly unknown[] | undefined): ReaperItem[] {
  const byCanonical = new Map<string, ReaperItem>()
  for (const entry of raw ?? []) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { sessionId?: unknown; updatedAt?: unknown; running?: unknown; origin?: unknown; parentSessionId?: unknown }
    if (typeof record.sessionId !== 'string' || record.sessionId === '') continue
    const canonical = canonicalSessionId(record.sessionId)
    if (byCanonical.has(canonical)) continue
    const item: ReaperItem = { native: record.sessionId, canonical, running: record.running === true }
    if (typeof record.updatedAt === 'number') item.updatedAt = record.updatedAt
    if (typeof record.origin === 'string') item.origin = record.origin
    if (typeof record.parentSessionId === 'string' && record.parentSessionId !== '') {
      item.parentNative = record.parentSessionId
      item.parentCanonical = canonicalSessionId(record.parentSessionId)
    }
    byCanonical.set(canonical, item)
  }
  return [...byCanonical.values()]
}

/** Canonicalized archived set, fresh read (the archive seam mutates it mid-pass). */
function archivedSet(deps: ReaperDeps): Set<string> {
  return new Set(deps.archivedSessionIds().map(canonicalSessionId))
}

/**
 * Pass 1 (design §四 谓词/归档动作): archive idle unprotected unarchived
 * subagents through the seam and write each ledger entry synchronously —
 * entry and archive land in the same instant, entry first-checked-then-
 * written only after the archive succeeded (failure = no entry + loud log).
 * After each success the archived set is re-read, so a child the harness
 * cascade just carried away is left to the reconcile pass (`reason:'cascade'`
 * with the fresh parent attribution, not a mislabelled `'idle-2d'`).
 */
async function reapPhase(deps: ReaperDeps, items: readonly ReaperItem[], stats: ReapStats): Promise<void> {
  let archived = archivedSet(deps)
  for (const item of items) {
    // 网眼写死 (design §四): only subagent rows, never top-level/blank.
    if (item.origin !== 'subagent') continue
    if (deps.protectedIds.has(item.canonical)) continue
    if (item.running) continue
    // No updatedAt = cannot age the row; fail-open, never guess an idle clock.
    if (item.updatedAt === undefined) continue
    if (deps.now() - item.updatedAt <= REAP_IDLE_MS) continue
    if (archived.has(item.canonical)) continue
    try {
      await deps.archive(item.native)
    } catch (error) {
      console.error(`[dsh-session-archive] reaper archive of '${item.native}' failed: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    archived = archivedSet(deps)
    const parentEntry = item.parentCanonical !== undefined
      ? entryFor(deps.ledger, item.parentCanonical, item.parentNative)
      : undefined
    deps.ledger.entries[item.canonical] = {
      archivedAt: deps.now(),
      source: 'auto',
      actor: parentEntry?.actor ?? 'reaper',
      reason: 'idle-2d',
    }
    stats.reaped += 1
  }
}

/**
 * Pass 2 (design §五 对账): backfill entries for subagent archives whose
 * parent is archived too (the cascade signature) and that carry a host time.
 * Parent-alive single archives are native-direct archives — out of scope, not
 * backfilled; a missing host time skips (never fabricate an observation).
 *
 * Gaps fill parent-first in waves: a child whose parent is also a gap this
 * round waits so it inherits the parent's just-written actor (判据 1「actor
 * 归因随父」holds for multi-level cascades backfilled in one pass). Parent
 * chains are trees; the no-progress guard defuses a corrupt cyclic
 * `parentSessionId` by falling back to `'cascade'` instead of looping.
 */
function reconcilePhase(deps: ReaperDeps, items: readonly ReaperItem[], stats: ReapStats): void {
  const archived = archivedSet(deps)
  const hostTimes = new Map<string, number>()
  for (const [id, at] of Object.entries(deps.archivedAtById() ?? {})) {
    if (typeof at === 'number') hostTimes.set(canonicalSessionId(id), at)
  }
  const gaps: ReconcileGap[] = []
  const gapChildren = new Set<string>()
  for (const item of items) {
    if (item.origin !== 'subagent') continue
    if (!archived.has(item.canonical)) continue
    if (entryFor(deps.ledger, item.canonical, item.native) !== undefined) continue
    const parentCanonical = item.parentCanonical
    if (parentCanonical === undefined || !archived.has(parentCanonical)) continue
    const hostAt = hostTimes.get(item.canonical)
    if (hostAt === undefined) continue // host 时间缺场 → 跳过不补 (design §五)
    gaps.push({ canonical: item.canonical, native: item.native, parentCanonical, parentNative: item.parentNative, hostAt })
    gapChildren.add(item.canonical)
  }
  const write = (gap: ReconcileGap, actor: string): void => {
    deps.ledger.entries[gap.canonical] = {
      archivedAt: gap.hostAt,
      source: 'auto',
      actor,
      reason: 'cascade',
    }
    stats.reconciled += 1
  }
  let pending = gaps
  while (pending.length > 0) {
    const deferred: ReconcileGap[] = []
    for (const gap of pending) {
      const parentEntry = entryFor(deps.ledger, gap.parentCanonical, gap.parentNative)
      if (parentEntry === undefined && gapChildren.has(gap.parentCanonical)) {
        deferred.push(gap) // parent is a gap too — wait for its wave
        continue
      }
      write(gap, parentEntry?.actor ?? 'cascade')
    }
    if (deferred.length === pending.length) {
      for (const gap of deferred) write(gap, 'cascade') // cyclic parent data: honest fallback, no loop
      break
    }
    pending = deferred
  }
}

/**
 * One throttled reaper + reconcile pass (design §四/§五). The only feed read
 * of the cycle feeds both passes; the ledger is flushed unconditionally at the
 * end so a flush a previous cycle could not land is retried even when this
 * round writes nothing. A feed or flush rejection propagates — the caller's
 * 24h throttle stays unset and the next tick retries (design §四 节流语义).
 */
export async function runReapCycle(deps: ReaperDeps): Promise<ReapStats> {
  const response = await deps.listFeed()
  const items = uniqueItems(response.items)
  const stats: ReapStats = { reaped: 0, reconciled: 0 }
  await reapPhase(deps, items, stats)
  reconcilePhase(deps, items, stats)
  await deps.flushLedger()
  return stats
}
