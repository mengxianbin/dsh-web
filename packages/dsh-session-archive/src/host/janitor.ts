/**
 * The dsh-session-archive host service. Owns the archive-time ledger, the
 * batch archive/restore/physical-delete pipelines, the automatic policy
 * cycles, and the scheduler. Mutating operations serialize through one
 * operation lock; every per-session step is failure-isolated so one broken
 * session never aborts a batch; physical deletion follows the strict order
 * archive markers -> workspace rows -> storage (rdb rows, files) -> projection
 * cache -> ledger, so an interrupted batch can only ever leave a session
 * present-but-unlisted (retryable), never half-deleted.
 * @module @linxin666/dsh-session-archive/host/janitor
 */

import { existsSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  autoArchiveCandidates,
  autoDeleteSeedCandidates,
} from '../core/auto-rules.ts'
import { planDelete } from '../core/cascade.ts'
import { resolveAutoConfig, type ResolvedAutoConfig } from '../core/config.ts'
import type {
  ArchiveSessionRow,
  AutoPreviewView,
  AutoStateView,
  BatchResponse,
  InventoryView,
  OpResult,
  RunStats,
  SealCheckResult,
  SessionPreviewView,
} from '../core/types.ts'
import { buildInventory, ledgerEntryFor, readProjcacheIndex, type BuiltInventory, type InventorySources, type ProjcacheFileEntry, type ProjcacheIndex } from './inventory.ts'
import {
  capEntries,
  deserializeAutoState,
  deserializeLedger,
  normalizeOverrideReason,
  writeJsonAtomic,
  type AutoStateDocument,
  type LedgerDocument,
  type LedgerEntry,
  type LedgerSource,
} from './ledger.ts'
import { analyzeSeal, isGreenSeal, isStaleSeal, sealMarker, sealRefOf, type AnalyzeSealOptions } from './seal.ts'
import { mayArchive, readIdentityTable, resolveActorClass, type IdentityClass } from './identity.ts'
import { createSealStateSync, type SealStateOptions, type SealStateSync } from './seal-state.ts'
import { DirIndexCache } from './dir-index-cache.ts'
import { AsyncTtlMemo } from './ttl-memo.ts'
import { InventoryResponseCache, type InventoryResponseServe } from './inventory-response-cache.ts'
import { canonicalSessionId, deleteRdbSession, indexSessionDirs, isSessionRdb, rdbDbPaths, removeSessionDir, resolveSessionDirs } from './session-files.ts'
import { dshHome as resolveDshHome } from '../dsh-home.ts'
import { archiveSession, removeFromWorkspaceRows, unarchiveSessions, unarchiveSeamAvailable } from './workspace-store.ts'
import { appendJournal, type JournalEvent } from './journal.ts'
import { REAP_SCAN_INTERVAL_MS, runReapCycle } from './reaper.ts'

/** Thrown when the caller's expected delete total disagrees with the host plan. */
export class PlanMismatchError extends Error {
  readonly plan: ReturnType<typeof planDelete>
  constructor(plan: ReturnType<typeof planDelete>) {
    super('delete plan mismatch')
    this.plan = plan
  }
}

/** Thrown when another mutating operation holds the lock. */
export class BusyError extends Error {
  constructor() {
    super('another archive operation is running')
  }
}

/** Optional face of the live session store (`ctx.sessions`), used defensively. */
interface LiveStoreFace {
  list?(): unknown[]
  get?(id: string): unknown
}

export interface ArchiveServiceOptions {
  dshHome?: string
  /**
   * The turn-end seal compute seam (seal-light-host-state-1109 护栏 ②): specs
   * inject a deterministic fake; production defaults to the off-loop worker.
   */
  sealCompute?: SealStateOptions['compute']
}

/**
 * The archive seal gate (contract C2), passed only by `POST /archive` — the
 * automatic cycles and every other caller stay ungated (C6: `auto/run` is out
 * of scope). Absent gate = historical behaviour, no seal reads at all.
 */
export interface ArchiveGate {
  /**
   * Forced pass-through for the whole batch. The route validates that a
   * `force:true` request carries a non-empty reason before this exists, so
   * the reason here is always real words (裁定③: force 一视同仁 + 真实理由).
   */
  force?: { readonly reason: string }
}

/** One row of the `POST /archive-override` response: the entry as written (contract C4). */
export interface ArchiveOverrideRow {
  readonly id: string
  readonly status: 'ok'
  readonly archivedAt: number
  readonly source: LedgerSource
  readonly reason?: string
  readonly seal?: string
}

const PREVIEW_MESSAGE_CAP = 6
const PREVIEW_TEXT_CAP = 400

/**
 * How long one sessions-root directory scan may be reused. The panel loads the
 * inventory, then issues one batch request per chunk (each rebuilding the
 * inventory), then refreshes; every one of those passes re-walked the same
 * unchanged tree. The window covers that burst without letting a scan go stale
 * enough to matter for the sizes and directory map it supplies, and the
 * service invalidates the cache itself after a physical delete.
 */
const DIR_INDEX_TTL_MS = 2_000

/**
 * How long one parse of the projection-cache index may be reused. The index is
 * re-read and re-parsed in full by every inventory pass, and one action issues
 * several passes, so the same burst window as the directory scan applies; once
 * the walk is reused the parse is what is left of a warm pass. The service
 * invalidates the memo itself after the delete pipeline rewrites the index.
 */
const PROJCACHE_INDEX_TTL_MS = 2_000

/**
 * How long one whole inventory response may be served as fresh before a
 * background refresh runs (stale reads keep answering verbatim — see
 * `inventory-response-cache.ts`).
 *
 * Sized by the taskbot cadence, not the panel's: `archive-janitor` polls
 * every 10 minutes behind a 10-second HTTP timeout, and one rebuild costs
 * 11–21 s warm (up to 35 s, 500 at the 30 s route timeout — forensics
 * `archive-lag-forensics-1110.md` §八), so a window shorter than the poll
 * interval makes every other janitor round pay a rebuild it cannot survive.
 * 15 minutes covers two full janitor intervals with margin; mutations still
 * invalidate explicitly, so this plugin's own archive/restore/delete results
 * are refreshed behind the very next read. State changed by anything other
 * than this plugin (feed activity, another client) surfaces on GET within
 * the window plus one rebuild; mutating routes never read this cache.
 */
const INVENTORY_RESPONSE_TTL_MS = 15 * 60_000

/**
 * How long a retained structured inventory may back restore/delete/auto
 * planning and preview before the consumer must pay a fresh pass
 * (archive-inline-inventory-1111 方向② 新鲜度上限). Archive/restore never
 * read this memo for their decisions — they take targeted per-id state — so
 * the cap only bounds staleness for the whole-row consumers.
 */
const FRESH_BUILT_TTL_MS = 15_000

/**
 * Per-target state for archive/restore decisions (方向① targeted read): what
 * one id needs from the inventory — existence, archived flag, the
 * harness-native spelling, and the sessions-root directory the seal gate
 * reads. Nothing here requires a whole-inventory rebuild.
 */
interface TargetState {
  /** Canonical session id. */
  id: string
  /** Whether any authoritative source lists the session (existence). */
  found: boolean
  /** Whether the archive set already contains it. */
  archived: boolean
  /** Feed-reported running flag; only populated when a whole-row source answered. */
  running?: boolean
  /** Harness-native id spelling when it differs from the canonical form. */
  nativeId?: string
  /** Absolute sessions-root directory, when one exists (seal-gate input). */
  dir?: string
  /**
   * Legacy bare-layout directory basename (canonical id = `session-<x>`,
   * directory = `<x>`). It equals the stored header id — what the harness's
   * `sessionKnown` keys on — but the feed's spelling wins whenever the feed
   * answers, so this is only used as the backstop when no feed row exists.
   */
  dirSpelling?: string
}

export class ArchiveService {
  private readonly ctx: Context
  private readonly dshHome: string
  private readonly ledgerPath: string
  private readonly statePath: string
  /** Append-only event journal path (B′, archive-audit-journal-1114). */
  private readonly journalPath: string
  /** Last journal batch timestamp; keeps journal batches strictly ordered in-process. */
  private lastBatchAt = 0
  /**
   * Last subagent-reaper scan (archive-cascade-reap-1114): in-memory 24h
   * throttle, never persisted — a restart scans again, idempotent by design
   * (design §四 频率). Set only after a fully successful cycle.
   */
  private lastReapAt = 0

  private ledger: LedgerDocument = { version: 1, entries: {} }
  private autoState: AutoStateDocument = { version: 1 }
  private config: ResolvedAutoConfig = resolveAutoConfig(undefined)
  /** Per-session projection-cache file facts, memoized across inventory passes. */
  private readonly projcacheFiles = new Map<string, ProjcacheFileEntry | null>()
  /**
   * Sessions-root directory index reused across nearby inventory passes. The
   * scan is the dominant cost of a pass, and one user action triggers several
   * (a chunk per batch request plus the refresh that follows). Invalidation
   * after a physical delete keeps the reuse from reporting removed storage.
   */
  private readonly dirIndex = new DirIndexCache({
    ttlMs: DIR_INDEX_TTL_MS,
    scan: () => indexSessionDirs(join(this.dshHome, 'sessions')),
  })
  /**
   * Parsed projection-cache index reused across nearby inventory passes. The
   * harness file only changes when another writer touches it, while every pass
   * re-reads and re-parses the whole document; the delete pipeline invalidates
   * the memo after it rewrites the index, so a removed session's facts cannot
   * resurface from memory. Async since 0.4.12: the read+parse yields the event
   * loop instead of holding it, and concurrent passes coalesce into one parse.
   */
  private readonly projcacheIndex = new AsyncTtlMemo<ProjcacheIndex>({
    ttlMs: PROJCACHE_INDEX_TTL_MS,
    load: () => readProjcacheIndex(this.dshHome),
  })
  /**
   * The cached whole inventory response the route serves. Mutating operations
   * invalidate it when they release the operation lock (every one of them
   * changes archive state, or may have changed it partially before failing),
   * so the next GET rebuilds; reads that start during an operation serve the
   * pre-operation snapshot until it ends.
   */
  private readonly responseCache = new InventoryResponseCache({
    ttlMs: INVENTORY_RESPONSE_TTL_MS,
    build: async (signal) => {
      const built = await this.buildFull(signal)
      return { payload: JSON.stringify(this.viewOf(built)), generatedAt: Date.now() }
    },
  })
  /**
   * The most recent structured full inventory, retained inside
   * {@link FRESH_BUILT_TTL_MS} so nearby whole-row consumers (preview, the
   * response-cache rebuild it shares its source with) skip a duplicate pass,
   * and patched in place by archive/restore instead of dropped (方向③ 定向
   * 更新, hooked at the same lock-release point as the SWR invalidation).
   * Guarded by {@link stateGen}: a pass retains its result only if no
   * mutation landed while it ran.
   */
  private freshBuilt: { built: BuiltInventory; at: number } | undefined
  /** Mutation generation, bumped on every operation-lock release (方向③). */
  private stateGen = 0

  private loaded = false
  private disposed = false
  /** Fail-fast flag: mutating operations reject with BusyError while held. */
  private lockHeld = false
  /** Sessions currently inside an archive/restore/delete pipeline. */
  private readonly busy = new Set<string>()
  private cycleRunning = false
  private schedulerTimer: ReturnType<typeof setTimeout> | undefined
  /** The turn-end seal sync, alive exactly while this service is mounted. */
  private sealState: SealStateSync | undefined
  private readonly sealCompute: SealStateOptions['compute']

  constructor(ctx: Context, options: ArchiveServiceOptions = {}) {
    this.ctx = ctx
    this.dshHome = options.dshHome ?? resolveDshHome()
    this.sealCompute = options.sealCompute
    this.ledgerPath = join(this.dshHome, 'dsh-session-archive', 'archive-ledger.json')
    this.statePath = join(this.dshHome, 'dsh-session-archive', 'state.json')
    this.journalPath = join(this.dshHome, 'dsh-session-archive', 'archive-events.jsonl')
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async start(): Promise<void> {
    const [rawLedger, rawState] = await Promise.all([
      this.readFile(this.ledgerPath),
      this.readFile(this.statePath),
    ])
    if (rawLedger !== undefined) {
      try {
        this.ledger = deserializeLedger(rawLedger)
      } catch {
        this.ledger = { version: 1, entries: {} }
      }
    }
    if (rawState !== undefined) {
      try {
        this.autoState = deserializeAutoState(rawState)
      } catch {
        this.autoState = { version: 1 }
      }
    }
    this.loaded = true
    this.armScheduler(true)
    // Turn-end seal sync (seal-light-host-state-1109 裁点1A): computes once
    // per turn end off the event loop, records the verdict, and lets the
    // `seal` projection carry it to the Host — soft-registered through
    // ctx.inject, so a host without the projection registry simply never
    // mounts the key.
    this.sealState = createSealStateSync(this.ctx, {
      resolveDir: async (id) => (await this.dirIndex.get()).byId.get(id),
      ...(this.sealCompute === undefined ? {} : { compute: this.sealCompute }),
    })
    this.sealState.start()
  }

  stop(): void {
    this.disposed = true
    this.sealState?.stop()
    this.sealState = undefined
    if (this.schedulerTimer !== undefined) clearTimeout(this.schedulerTimer)
    this.schedulerTimer = undefined
  }

  applyConfig(raw: unknown): void {
    this.config = resolveAutoConfig(raw as ResolvedAutoConfig)
    if (this.loaded) this.armScheduler(false)
  }

  get autoConfig(): ResolvedAutoConfig {
    return this.config
  }

  /** Read-only ledger view for tests and diagnostics. */
  ledgerSnapshot(): LedgerDocument {
    return this.ledger
  }

  // ------------------------------------------------------------------
  // Persistence helpers
  // ------------------------------------------------------------------

  private readFile(path: string): Promise<string | undefined> {
    return import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8')).catch(() => undefined)
  }

  private async flushLedger(): Promise<void> {
    if (!this.loaded) return
    await writeJsonAtomic(this.ledgerPath, this.ledger).catch(() => {})
  }

  private async flushState(): Promise<void> {
    if (!this.loaded) return
    await writeJsonAtomic(this.statePath, this.autoState).catch(() => {})
  }

  /**
   * Batch timestamp for journal rows: wall clock, nudged +1ms on an
   * in-process same-ms collision so journal batches stay strictly ordered
   * (design §二). Ledger timestamps are untouched — the nudge only lands on
   * the side log.
   */
  private nextBatchAt(): number {
    const now = Date.now()
    this.lastBatchAt = now > this.lastBatchAt ? now : this.lastBatchAt + 1
    return this.lastBatchAt
  }

  /**
   * Best-effort journal append (B′, archive-audit-journal-1114): never
   * throws — a failed write only warns, so the archive/unarchive result is
   * never flipped (fail-open, same loud-but-non-blocking shape as C4).
   */
  private async journal(events: readonly JournalEvent[]): Promise<void> {
    if (events.length === 0) return
    try {
      await appendJournal(this.journalPath, events)
    } catch (error) {
      console.warn(`[dsh-session-archive] journal append failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ------------------------------------------------------------------
  // Sources and protection
  // ------------------------------------------------------------------

  private async sources(): Promise<InventorySources> {
    const feed = this.serviceFace<{ list(request: unknown, signal: AbortSignal): Promise<{ items?: unknown[] }> }>('sessionController')
    const registry = this.serviceFace<{ list(): unknown[]; archivedSessionIds: readonly string[]; archivedAtById?: Record<string, number> }>('workspaceRegistry')
    return {
      feed: feed as never,
      registry: registry as never,
      dshHome: this.dshHome,
      ledger: this.ledger,
      projcacheFiles: this.projcacheFiles,
      dirIndex: await this.dirIndex.get(),
      // Awaited here (not in buildInventory): the memo's derivation is async
      // since the projection-cache index stopped being read synchronously.
      projcacheIndex: await this.projcacheIndex.get(),
    }
  }

  private serviceFace<T>(name: string): T | undefined {
    try {
      return (this.ctx as unknown as { get(name: string): unknown }).get(name) as T | undefined
    } catch {
      return undefined
    }
  }

  /** Live session ids (attached in this host process) — treated as in-use. */
  private liveSessionIds(): Set<string> {
    const store = this.serviceFace<LiveStoreFace>('sessions')
    const ids = new Set<string>()
    if (store === undefined || typeof store.list !== 'function') return ids
    try {
      for (const session of store.list() ?? []) {
        const id = (session as { id?: unknown })?.id
        if (typeof id === 'string') ids.add(canonicalSessionId(id))
      }
    } catch {
      // A failing store read degrades to feed-only protection.
    }
    return ids
  }

  /** Protection map shared by manual delete and auto cycles. */
  private protectedReason(currentSessionId: string | undefined, rows?: readonly ArchiveSessionRow[]): Map<string, string> {
    const map = new Map<string, string>()
    // Live-store members are held open by the running harness process even
    // when the feed reports them idle — a distinct, honest skip reason.
    for (const id of this.liveSessionIds()) map.set(id, 'attached')
    // Feed-reported running agents are protected even when the live store
    // lookup fails or lags.
    if (rows !== undefined) {
      for (const row of rows) {
        if (row.running && !map.has(row.id)) map.set(row.id, 'running')
      }
    }
    // The client reports the current session in the harness's native spelling;
    // rows are canonical.
    if (currentSessionId !== undefined && currentSessionId !== '') map.set(canonicalSessionId(currentSessionId), 'current')
    for (const id of this.busy) map.set(id, 'in-flight')
    return map
  }

  private statsFrom(results: readonly OpResult[], at: number): RunStats {
    let ok = 0
    let skipped = 0
    let failed = 0
    const entries: OpResult[] = []
    for (const result of results) {
      if (result.status === 'ok') ok += 1
      else if (result.status === 'skipped') {
        skipped += 1
        entries.push(result)
      } else {
        failed += 1
        entries.push(result)
      }
    }
    return { at, total: results.length, ok, skipped, failed, entries: capEntries(entries) }
  }

  // ------------------------------------------------------------------
  // Inventory
  // ------------------------------------------------------------------

  async inventory(): Promise<InventoryView> {
    return this.viewOf(await this.buildFull())
  }

  /** The wire view of one built inventory (serialized by the response cache). */
  private viewOf(built: BuiltInventory): InventoryView {
    return {
      generatedAt: Date.now(),
      rows: built.rows,
      workspaces: built.workspaces,
      archivedSessionIds: built.archivedSessionIds,
      auto: this.autoView(),
    }
  }

  /**
   * One whole-inventory pass, retained as the structured fresh source
   * (方向②). This is now the ONLY full-rebuild call site in the service, and
   * it is never invoked inside {@link withLock}: mutating routes either take
   * targeted per-id state (方向①) or call this before acquiring the lock,
   * time-capped by the same 30 s abort the pass always had.
   */
  private async buildFull(signal?: AbortSignal): Promise<BuiltInventory> {
    const generation = this.stateGen
    const abort = signal === undefined
      ? AbortSignal.timeout(30_000)
      : AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const built = await buildInventory(await this.sources(), abort)
    // Retain only when no mutation landed while this pass ran: a pre-mutation
    // snapshot must not answer post-mutation consumers.
    if (generation === this.stateGen) this.freshBuilt = { built, at: Date.now() }
    return built
  }

  /** The retained structured inventory while inside its freshness cap (方向②). */
  private peekFreshBuilt(maxAgeMs: number = FRESH_BUILT_TTL_MS): BuiltInventory | undefined {
    const retained = this.freshBuilt
    if (retained === undefined) return undefined
    const age = Date.now() - retained.at
    if (age < 0 || age > maxAgeMs) return undefined
    return retained.built
  }

  /**
   * Flip the archive state of exactly the ids one successful batch touched,
   * in the retained inventory (方向③ 定向失效受影响子集). The payload cache
   * still whole-invalidates through the SWR layer untouched; this only keeps
   * the structured memo honest so the next nearby consumer skips a rebuild.
   * Each touched row is rewritten the way a fresh pass would assemble it
   * (rows are immutable value objects): archive time prefers the host's
   * durable stamp over the ledger entry the batch just wrote, attribution
   * (source/reason/seal) rides that entry, and an unarchive drops every one
   * of those fields — the ledger entries are already deleted by the time
   * this runs — with `no-archive-time` following the same archived-only rule.
   */
  private patchFreshBuiltArchived(ids: readonly string[], archived: boolean, at: number): void {
    const retained = this.freshBuilt
    if (retained === undefined || ids.length === 0) return
    const wanted = new Set(ids.map((id) => canonicalSessionId(id)))
    // Host archive stamps, canonicalized the same way buildInventory does;
    // an absent face degrades to ledger-only times, never to a fabricated one.
    let hostTimes: Map<string, number> | undefined
    const registry = this.serviceFace<{ archivedAtById?: Record<string, number> }>('workspaceRegistry')
    if (archived && registry?.archivedAtById !== undefined) {
      try {
        hostTimes = new Map(Object.entries(registry.archivedAtById).map(([id, stamped]) => [canonicalSessionId(id), stamped]))
      } catch {
        hostTimes = undefined
      }
    }
    const rows = retained.built.rows
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!wanted.has(row.id)) continue
      // Destructure the four archive-attribution fields away so a stale
      // override reason/seal can never survive an entry that lacks them.
      const { archivedAt: _archivedAt, archivedAtSource: _source, reason: _reason, seal: _seal, ...rest } = row
      const issues = row.issues.includes('no-archive-time')
        ? row.issues.filter((issue) => issue !== 'no-archive-time')
        : row.issues
      if (archived) {
        const nativeId = retained.built.nativeIds[row.id]
        const entry = this.ledger.entries[row.id] ?? (nativeId !== undefined ? this.ledger.entries[nativeId] : undefined)
        const archivedAt = hostTimes?.get(row.id) ?? entry?.archivedAt ?? at
        rows[index] = {
          ...rest,
          archived: true,
          archivedAt,
          ...(entry !== undefined ? { archivedAtSource: entry.source } : {}),
          ...(entry?.reason !== undefined ? { reason: entry.reason } : {}),
          ...(entry?.seal !== undefined ? { seal: entry.seal } : {}),
          issues,
        }
      } else {
        rows[index] = { ...rest, archived: false, issues }
      }
    }
    const list = retained.built.archivedSessionIds
    for (const id of ids) {
      const canonical = canonicalSessionId(id)
      const index = list.findIndex((entry) => canonicalSessionId(entry) === canonical)
      if (archived && index === -1) list.push(id)
      if (!archived && index !== -1) list.splice(index, 1)
    }
  }

  /**
   * Per-target archive state from targeted reads — the direction①
   * replacement for a whole-inventory rebuild on the archive/restore request
   * path. Existence matches `buildInventory` exactly: archive set ∪ session
   * directories ∪ feed rows, where the feed is consulted only for ids
   * neither the registry nor a directory already answered (a bare-layout
   * directory also waits on the feed to confirm its spelling). The
   * harness-native spelling resolves the way a full pass harvested it: the
   * archive set, then the feed — `sessionKnown` keys on the stored header
   * id, which production shows equals the directory basename in both
   * layouts (sampled 2026-11-15), so the directory basename is only the
   * backstop for a session no feed row lists.
   */
  private async targetStates(ids: readonly string[]): Promise<Map<string, TargetState>> {
    const states = new Map<string, TargetState>()
    for (const raw of new Set(ids)) {
      const id = canonicalSessionId(raw)
      states.set(id, { id, found: false, archived: false })
    }
    // 1. The archive set (in-memory): archived state + its native spelling.
    const registry = this.serviceFace<{ archivedSessionIds: readonly string[] }>('workspaceRegistry')
    try {
      for (const raw of registry?.archivedSessionIds ?? []) {
        const state = states.get(canonicalSessionId(raw))
        if (state === undefined) continue
        state.archived = true
        state.found = true
        if (raw !== state.id) state.nativeId = raw
      }
    } catch {
      // A failing registry read degrades to directory/feed discovery below.
    }
    // 2. Targeted directory stat: existence + seal-gate dir. A basename that
    //    differs from the canonical id is the legacy bare layout; hold it
    //    back from `nativeId` until the feed has had its say (a full pass
    //    took native ids from the feed first, and the fixture pairs a
    //    stripped directory with a prefixed feed id).
    const dirs = resolveSessionDirs(join(this.dshHome, 'sessions'), [...states.keys()])
    for (const [id, dir] of dirs) {
      const state = states.get(id)
      if (state === undefined) continue
      state.found = true
      state.dir = dir
      const base = basename(dir)
      if (base !== id && canonicalSessionId(base) === id) state.dirSpelling = base
    }
    // 3. Feed discovery for ids still without existence, plus bare-layout
    //    directories whose spelling the feed can confirm. Thin first (fast),
    //    subagent scope only if something is still missing.
    const want = new Set(
      [...states.values()]
        .filter((state) => !state.found || (state.dirSpelling !== undefined && state.nativeId === undefined))
        .map((state) => state.id),
    )
    if (want.size > 0) {
      const feed = this.serviceFace<{ list(request: unknown, signal: AbortSignal): Promise<{ items?: readonly { sessionId?: string }[] }> }>('sessionController')
      if (feed !== undefined) {
        const absorb = (items: readonly { sessionId?: string }[] | undefined): void => {
          for (const item of items ?? []) {
            if (typeof item.sessionId !== 'string' || item.sessionId === '') continue
            const state = states.get(canonicalSessionId(item.sessionId))
            if (state === undefined || !want.has(state.id)) continue
            state.found = true
            if (state.nativeId === undefined && item.sessionId !== state.id) state.nativeId = item.sessionId
            want.delete(state.id)
          }
        }
        try {
          absorb((await feed.list({}, AbortSignal.timeout(30_000))).items)
          if (want.size > 0) absorb((await feed.list({ includeSubagents: true }, AbortSignal.timeout(30_000))).items)
        } catch {
          // A failing feed leaves the remaining ids not-found — the same
          // degraded outcome a whole pass produces when its feed call dies.
        }
      }
    }
    // 4. Backstop: an id the feed never answered (still in `want`) that has
    //    a bare-layout directory resolves to its stored header id — what
    //    `sessionKnown` keys on, and the case a full pass could not answer
    //    either. An id the feed DID answer keeps the feed's decision: its
    //    nativeId stays undefined exactly when the feed spelling is already
    //    canonical. Archived ids are excluded: their archive-set spelling
    //    already answered, or the registry holds the canonical form the
    //    restore verb matches against.
    for (const state of states.values()) {
      if (want.has(state.id) && !state.archived && state.dirSpelling !== undefined) {
        state.nativeId = state.dirSpelling
      }
    }
    return states
  }

  /** Whole-row source for the automatic path: rows → per-target state (方向②). */
  private statesFromBuilt(built: BuiltInventory, ids: readonly string[]): Map<string, TargetState> {
    const byId = new Map(built.rows.map((row) => [row.id, row]))
    const states = new Map<string, TargetState>()
    for (const raw of new Set(ids)) {
      const id = canonicalSessionId(raw)
      const row = byId.get(id)
      const native = built.nativeIds[id]
      const dir = built.dirIndex.byId.get(id)
      states.set(id, {
        id,
        found: row !== undefined,
        archived: row?.archived === true,
        ...(row !== undefined ? { running: row.running } : {}),
        ...(native !== undefined ? { nativeId: native } : {}),
        ...(dir !== undefined ? { dir } : {}),
      })
    }
    return states
  }

  /**
   * The inventory document as the route serves it: one rebuild serialized
   * once, then the same bytes served verbatim inside the TTL window
   * ({@link InventoryResponseCache}). Mutating operations invalidate the
   * window; `hit`/`ageMs` travel to the wire as `x-dsh-inventory-cache` and
   * `age` so a cache hit is observable without parsing the body.
   */
  inventoryCached(): Promise<InventoryResponseServe> {
    return this.responseCache.serve()
  }

  autoView(): AutoStateView {
    return {
      ...(this.autoState.lastArchiveRun !== undefined ? { lastArchiveRun: this.autoState.lastArchiveRun } : {}),
      ...(this.autoState.lastDeleteRun !== undefined ? { lastDeleteRun: this.autoState.lastDeleteRun } : {}),
      ...(this.autoState.nextCheckAt !== undefined ? { nextCheckAt: this.autoState.nextCheckAt } : {}),
      cycleRunning: this.cycleRunning,
    }
  }

  /**
   * The six-value seal grouping for a batch of ids — the single implementation
   * behind both archive channels (contract C1: 分组实现全插件仅此一份): the
   * native dialog consumes it through `POST /seal-check`, the REST hard gate
   * calls `analyzeSeal` directly through {@link archive}. Location probes
   * only the named ids against the sessions root (targeted read — no full
   * `indexSessionDirs` walk, no `dirSize`, see {@link resolveSessionDirs});
   * an id with no locatable transcript answers `UNKNOWN` (fail-closed, never
   * a silent pass).
   */
  sealCheck(ids: readonly string[], options?: AnalyzeSealOptions): SealCheckResult[] {
    const dirs = resolveSessionDirs(join(this.dshHome, 'sessions'), ids)
    return ids.map((id) => analyzeSeal(id, dirs.get(id), options))
  }

  // ------------------------------------------------------------------
  // Archive / unarchive
  // ------------------------------------------------------------------

  /** Fail-fast mutual exclusion: concurrent mutating callers get BusyError. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lockHeld) return Promise.reject(new BusyError())
    this.lockHeld = true
    const run = (async () => fn())()
    const release = (): void => {
      this.lockHeld = false
      // Every locked operation changes archive state (or changed it partially
      // before failing), so the cached whole response is dropped here, once,
      // and the next inventory GET rebuilds. Reads that started during the
      // operation keep serving the pre-operation snapshot until it ends.
      this.responseCache.invalidate()
      // The structured memo rides the same notification (方向③ 复用 SWR 失效
      // 通知): bump the generation so any pass still in flight refuses to
      // retain its pre-mutation rows.
      this.stateGen += 1
      // The per-session projection-cache file memo rides it too (扩面并入
      // 2026-11-16, archive-title-memo-1116): unlike its TTL'd siblings it
      // has no expiry of its own, so a session whose title lands after one
      // pass already cached its title-less entry would keep showing
      // `no-title` until process restart. Every locked operation drops the
      // whole file memo — mutations are rare, the next pass pays one cold
      // re-read, and the stale-title window closes with this notification.
      this.projcacheFiles.clear()
    }
    run.then(release, release)
    return run
  }

  /**
   * Archive a batch of sessions. Every call passes the triclass identity
   * gate first (user ruling, 2026-10-29): the actor resolves against the
   * attention ledger and each target decides on its own — a denied id gets
   * `skipped / identity-denied` with both classes in `detail`, the rest of
   * the batch proceeds (no taint). The actor is persisted into every ledger
   * entry it archives, so attribution reads from the ledger instead of
   * transcript archaeology. When a seal gate is passed, it decides per id
   * after the identity gate (contract C2: green/stale archive, true red and
   * UNKNOWN refuse with `seal-required`, no batch contagion either).
   * @param ids - canonical session ids.
   * @param source - ledger source tag (`manual` from the REST route).
   * @param currentSessionId - caller's currently open session (auto path protection).
   * @param actor - who ordered this archive (deciding session id or channel
   * name); absent resolves to no identity, which the gate always refuses —
   * the route 400s before this can happen.
   * @param gate - archive seal gate (contract C2); absent = no seal reads.
   */
  async archive(ids: readonly string[], source: 'manual' | 'auto', currentSessionId?: string, actor?: string, gate?: ArchiveGate): Promise<BatchResponse> {
    // Manual archives decide from targeted per-id state (方向①) — no whole
    // inventory rebuild anywhere on this request path. The automatic path is
    // candidate-grade (its caller hands ids chosen from whole rows), so it
    // builds its own fresh inventory OUTSIDE the lock (方向②, fail-fast when
    // the lock is already held) and re-verifies each target inside it.
    if (source === 'auto' && this.lockHeld) throw new BusyError()
    const built = source === 'auto' ? await this.buildFull() : undefined
    return this.withLock(async () => {
      const results: OpResult[] = []
      const events: JournalEvent[] = []
      const journalAt = this.nextBatchAt()
      const now = Date.now()
      const states = built === undefined ? await this.targetStates(ids) : this.statesFromBuilt(built, ids)
      // Identity gate, resolved once per batch from the dispatch plugin's
      // attention ledger ($DSH_HOME/session-attention.json).
      const identity = await readIdentityTable(this.dshHome)
      const actorClass = resolveActorClass(actor, identity)
      // Protection for the automatic path only: live-store/current/in-flight
      // come from in-memory state, the target's running flag rides its row.
      const protectedBase = source === 'auto' ? this.protectedReason(currentSessionId) : undefined
      const okIds: string[] = []
      for (const id of ids) {
        const state = states.get(id)
        if (state === undefined || !state.found) {
          results.push({ id, status: 'skipped', reason: 'not-found' })
          continue
        }
        const targetClass: IdentityClass = identity.get(id) ?? 'human'
        if (!mayArchive(actorClass, targetClass)) {
          results.push({
            id,
            status: 'skipped',
            reason: 'identity-denied',
            detail: `actor ${actorClass ?? 'unclassified'} cannot archive ${targetClass} session`,
          })
          continue
        }
        if (state.archived) {
          results.push({ id, status: 'skipped', reason: 'already-archived' })
          continue
        }
        if (protectedBase !== undefined) {
          const reason = protectedBase.get(id) ?? (state.running === true ? 'running' : undefined)
          if (reason !== undefined) {
            results.push({ id, status: 'skipped', reason: reason as OpResult['reason'] })
            continue
          }
        }
        // Seal gate (contract C2): decided per id after the existence checks,
        // so one refused session never drags its batch down (批内不连坐).
        let entrySource: LedgerSource = source
        let entryReason: string | undefined
        let entrySeal: string | undefined
        // C′ 归档即停轮 (2026-11-19 裁定, 加固B): only a **fresh-green** seal —
        // DONE (endorsement rechecked green just now) or N_A, both a
        // last-turn sentinel the gate re-read — may order the archive with
        // `stopActivity`, so an in-turn self-archive lands and its own turn
        // stops after the write. Force overrides the seal but not this
        // decision (the human channel for stopping a live turn stays the
        // native stop-and-archive dialog); NEUTRAL/LEGACY are green for
        // archiving but carry no fresh sentinel, and the stale tier means
        // the conversation resumed after the save — neither may stop a turn.
        let stopTurn = false
        if (gate !== undefined) {
          // recheck (archive-seal-falsered-1116 段2): this REST gate decides at
          // click time, so a memoized no-endorsement red is re-probed instead
          // of served frozen to the transcript stamp.
          const seal = analyzeSeal(id, state.dir, { recheck: true })
          if (gate.force !== undefined) {
            // Forced pass: the whole batch archives under the caller's stated
            // reason, each entry carrying the seal judgement it overrode.
            entrySource = 'override'
            entryReason = gate.force.reason
            entrySeal = sealMarker(seal)
          } else if (isGreenSeal(seal.verdict)) {
            // Green tier: archives exactly as before — no seal field, source manual.
            stopTurn = seal.verdict === 'DONE' || seal.verdict === 'N_A'
          } else if (isStaleSeal(seal)) {
            // Stale tier (裁定①): pass through with the pinned marker.
            entrySeal = 'stale'
          } else {
            // True red (UNSEALED) and UNKNOWN: refuse this id with its
            // grouping — the receipt carries what to fix (seal-remedy-1119).
            results.push({ id, status: 'skipped', reason: 'seal-required', seal: sealRefOf(seal) })
            continue
          }
        }
        this.busy.add(id)
        try {
          // The registry records the harness's native id spelling; rows and
          // ledger keys stay canonical. `stopTurn` reaches the wrapper's 加固A
          // activity check (turn family alone) before any stop is ordered.
          await archiveSession(this.ctx, state.nativeId ?? id, { stopTurn })
          this.ledger.entries[id] = {
            archivedAt: now,
            source: entrySource,
            ...(entryReason !== undefined ? { reason: entryReason } : {}),
            ...(entrySeal !== undefined ? { seal: entrySeal } : {}),
            ...(actor !== undefined ? { actor } : {}),
          }
          results.push({ id, status: 'ok' })
          okIds.push(id)
          events.push({ id, op: 'archive', at: journalAt, ...(actor !== undefined ? { actor } : {}), entry: { ...this.ledger.entries[id] } })
        } catch (error) {
          results.push({ id, status: 'failed', reason: 'error', detail: error instanceof Error ? error.message.slice(0, 200) : String(error) })
        } finally {
          this.busy.delete(id)
        }
      }
      await this.flushLedger()
      this.patchFreshBuiltArchived(okIds, true, now)
      await this.journal(events)
      return { results, freedBytes: 0 }
    })
  }

  async unarchive(ids: readonly string[]): Promise<BatchResponse> {
    return this.withLock(async () => {
      const results: OpResult[] = []
      const events: JournalEvent[] = []
      const journalAt = this.nextBatchAt()
      // Targeted per-id state (方向①): existence and archived-ness come from
      // the in-memory archive set and a directory stat — no full rebuild.
      const states = await this.targetStates(ids)
      const toUnarchive: string[] = []
      for (const id of ids) {
        const state = states.get(id)
        if (state === undefined || !state.found) {
          results.push({ id, status: 'skipped', reason: 'not-found' })
          continue
        }
        if (!state.archived) {
          results.push({ id, status: 'skipped', reason: 'not-archived' })
          continue
        }
        toUnarchive.push(id)
      }
      try {
        // The registry records the harness's native id spelling; rows and
        // ledger keys stay canonical.
        await unarchiveSessions(this.ctx.workspaceRegistry, toUnarchive.map((id) => states.get(id)?.nativeId ?? id))
        for (const id of toUnarchive) {
          // B′: snapshot the whole entry before the delete erases it — the
          // journal keeps whatever seal/source/reason/actor the ledger drops.
          const erased = this.ledger.entries[id] ?? this.ledger.entries[states.get(id)?.nativeId ?? id]
          delete this.ledger.entries[id]
          const native = states.get(id)?.nativeId
          if (native !== undefined && native !== id) delete this.ledger.entries[native]
          results.push({ id, status: 'ok' })
          events.push({ id, op: 'unarchive', at: journalAt, ...(erased !== undefined ? { entry: { ...erased } } : {}) })
        }
      } catch (error) {
        for (const id of toUnarchive) {
          results.push({ id, status: 'failed', reason: 'missing-seam', detail: error instanceof Error ? error.message.slice(0, 200) : String(error) })
        }
      }
      await this.flushLedger()
      this.patchFreshBuiltArchived(toUnarchive.filter((id) => results.find((r) => r.id === id)?.status === 'ok'), false, Date.now())
      await this.journal(events)
      return { results, freedBytes: 0 }
    })
  }

  // ------------------------------------------------------------------
  // Native-channel write-back (archive-override)
  // ------------------------------------------------------------------

  /**
   * Native-channel ledger write-back (contract C4). `mode: "force"` ends the
   * entry in `source: "override"` with its reason (blank/missing normalizes to
   * `override:no-reason` at the write layer) and the seal judgement; `mode:
   * "note"` adds the pinned `seal: "stale"` marker of the stale pass-through
   * tier without touching an existing entry's source. Both modes are idempotent
   * write-ups: an existing `archivedAt` is never reset (a write-back must not
   * refresh the 30-day retention countdown), and repeated identical calls
   * write nothing. Rows that already carry an archive time — the host's stamp
   * or a ledger entry — keep it, so write-back and the host stamp leave
   * exactly one entry (contract C5).
   *
   * Deliberately lock-free: one ledger document, atomic whole-file writes,
   * single-process read-modify-write.
   *
   * Targeted read (方向①, archive-override-noscan-1117): the native channel
   * always travels with its own seal and `note` never judges one, so the full
   * sessions-root index is only needed to *compute* a seal when a force
   * write-back carries none — that case probes just the named ids (the lookup
   * `sealCheck` already uses, equal to the full index restricted to them),
   * instead of re-walking the whole tree on every write-back (warm walk ran
   * ~1.3 s, cold ~14.5 s on a 2127-session root — the cost the native UI's
   * 5 s abort used to trip over).
   */
  async archiveOverride(
    ids: readonly string[],
    mode: 'force' | 'note',
    options: { reason?: string; seal?: string } = {},
  ): Promise<{ results: readonly ArchiveOverrideRow[] }> {
    const now = Date.now()
    const providedSeal = typeof options.seal === 'string' && options.seal.trim() !== '' ? options.seal.trim() : undefined
    // Only a seal-less force needs transcript dirs at all; nothing else in
    // this method reads the sessions tree.
    const dirs = mode === 'force' && providedSeal === undefined
      ? resolveSessionDirs(join(this.dshHome, 'sessions'), ids)
      : undefined
    const results: ArchiveOverrideRow[] = []
    let changed = false
    for (const id of ids) {
      const existing = this.ledger.entries[id]
      let next: LedgerEntry
      if (mode === 'force') {
        next = {
          archivedAt: existing?.archivedAt ?? now,
          source: 'override',
          reason: normalizeOverrideReason(options.reason),
          seal: providedSeal ?? sealMarker(analyzeSeal(id, dirs?.get(id), { recheck: true })),
        }
      } else {
        next = existing !== undefined
          ? { ...existing, seal: 'stale' }
          : { archivedAt: now, source: 'observed', seal: 'stale' }
      }
      if (JSON.stringify(existing) !== JSON.stringify(next)) {
        this.ledger.entries[id] = next
        changed = true
      }
      const entry = this.ledger.entries[id] as LedgerEntry
      results.push({
        id,
        status: 'ok',
        archivedAt: entry.archivedAt,
        source: entry.source,
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        ...(entry.seal !== undefined ? { seal: entry.seal } : {}),
      })
    }
    if (changed) await this.flushLedger()
    return { results }
  }

  // ------------------------------------------------------------------
  // Physical delete
  // ------------------------------------------------------------------

  /**
   * Plan and execute one physical-delete batch. The plan is computed from a
   * fresh inventory with the full protection map; `expectedTotal` (the number
   * the user confirmed) must match or the whole batch aborts with a plan
   * mismatch so the UI can re-confirm.
   */
  async deleteSessions(ids: readonly string[], options: { currentSessionId?: string; expectedTotal?: number; source?: 'manual' | 'auto' } = {}): Promise<BatchResponse> {
    // Whole-row plan (cascade children, sizes, protection) needs a full
    // pass; it now runs OUTSIDE the lock (方向②) so a slow rebuild never
    // blocks concurrent archive/restore behind BusyError — the lock covers
    // plan verification and execution only. Always a fresh pass, never the
    // retained memo: cascade-child discovery must see rows this very moment
    // (recorded deviation from direction②'s reuse clause — a ≤15 s-old memo
    // could miss a child born inside the window and leak it past the delete).
    if (this.lockHeld) throw new BusyError()
    const built = await this.buildFull()
    return this.withLock(async () => {
      const protectedMap = this.protectedReason(options.currentSessionId, built.rows)
      const plan = planDelete(built.rows, ids, protectedMap)
      // A mismatch only matters when the host would delete MORE than the user
      // confirmed. Fewer targets mean the host protected sessions the client
      // did not know about — those surface as skipped results, never as an
      // error that blocks the whole batch.
      if (typeof options.expectedTotal === 'number' && plan.targets.length > options.expectedTotal) {
        throw new PlanMismatchError(plan)
      }
      if (!unarchiveSeamAvailable(this.ctx.workspaceRegistry)) {
        return {
          results: plan.targets.map((id) => ({ id, status: 'failed' as const, reason: 'missing-seam' as const, detail: 'workspace registry seam unavailable' })),
          freedBytes: 0,
        }
      }
      for (const id of plan.targets) this.busy.add(id)
      try {
        const response = await this.executeDelete(plan, built, options.source ?? 'manual')
        // Rows left storage: the retained memo cannot answer for them again.
        this.freshBuilt = undefined
        return response
      } finally {
        for (const id of plan.targets) this.busy.delete(id)
      }
    })
  }

  /**
   * The deletion pipeline, in the crash-safe order: archive markers, then
   * workspace rows, then per-session storage (rdb rows and files), then the
   * projection cache, then the archive ledger. A crash between steps leaves
   * the session unlisted but present — a retry finishes the job; it never
   * leaves a half-deleted session behind.
   */
  private async executeDelete(
    plan: ReturnType<typeof planDelete>,
    built: Awaited<ReturnType<typeof buildInventory>>,
    source: 'manual' | 'auto',
  ): Promise<BatchResponse> {
    const results = new Map<string, OpResult>()
    const targets = plan.targets
    const sizeById = new Map(built.rows.map((row) => [row.id, row.sizeBytes]))

    // 1. Archive markers (one public verb call per target).
    try {
      await unarchiveSessions(this.ctx.workspaceRegistry, targets.map((id) => built.nativeIds[id] ?? id))
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 200) : String(error)
      return { results: targets.map((id) => ({ id, status: 'failed' as const, reason: 'missing-seam' as const, detail })), freedBytes: 0 }
    }

    // 2. Workspace rows.
    try {
      await removeFromWorkspaceRows(this.ctx.workspaceRegistry, targets)
    } catch {
      // Row cleanup failure does not stop storage deletion; the projection
      // already drops ids whose header is gone, and the next retry cleans up.
    }

    // 3. Storage: rdb rows and/or the session directory.
    const rdbPaths = rdbDbPaths(this.dshHome).filter((path) => isSessionRdb(path))
    const rowById = new Map(built.rows.map((row) => [row.id, row]))
    const deleted = new Set<string>()
    for (const id of targets) {
      try {
        const native = built.nativeIds[id]
        for (const dbPath of rdbPaths) {
          deleteRdbSession(dbPath, id)
          if (native !== undefined && native !== id) deleteRdbSession(dbPath, native)
        }
        const dir = built.dirIndex.byId.get(id)
        if (dir !== undefined) {
          removeSessionDir(dir, join(this.dshHome, 'sessions'))
        } else if (rdbPaths.length === 0 && rowById.get(id)?.issues.includes('no-data') !== true) {
          // The feed still lists this session but no storage answered —
          // refusing keeps the feed and the disk consistent.
          results.set(id, { id, status: 'failed', reason: 'unreadable', detail: 'no session storage found' })
          continue
        }
        deleted.add(id)
        results.set(id, { id, status: 'ok' })
      } catch (error) {
        results.set(id, { id, status: 'failed', reason: 'error', detail: error instanceof Error ? error.message.slice(0, 200) : String(error) })
      }
    }

    // The directories this batch removed are gone from here on; a later
    // inventory pass must re-walk rather than reuse the batch's own scan.
    if (deleted.size > 0) this.dirIndex.invalidate()

    // 4. Projection cache (index entry + per-session file), both spellings.
    await this.scrubProjcache(deleted, built.nativeIds)

    // 5. Archive ledger, both spellings.
    for (const id of deleted) {
      delete this.ledger.entries[id]
      const native = built.nativeIds[id]
      if (native !== undefined && native !== id) delete this.ledger.entries[native]
    }
    await this.flushLedger()

    let freedBytes = 0
    for (const id of deleted) {
      const size = sizeById.get(id)
      if (typeof size === 'number') freedBytes += size
    }
    void source
    // Protected members never entered the target set; surface their skip
    // reasons next to the per-target results.
    return { results: [...plan.skipped, ...targets.map((id): OpResult => results.get(id) ?? { id, status: 'failed', reason: 'error' })], freedBytes }
  }

  /** Best-effort projection-cache scrub; a stale cache entry is cosmetic. */
  private async scrubProjcache(ids: ReadonlySet<string>, nativeIds: Record<string, string> = {}): Promise<void> {
    const indexPath = join(this.dshHome, 'storages', 'session_projcache.json')
    // The index this pass rewrites is the memo's input: drop the retained parse
    // first, so a pass that follows a physical delete cannot answer with the
    // removed sessions' facts even while the window is still open.
    if (ids.size > 0) this.projcacheIndex.invalidate()
    // The index read is async since 0.4.12: the document is multi-megabyte,
    // and this scrub runs inside the delete pipeline on the shared event
    // loop — a synchronous read+parse here stalled every request while a
    // batch deleted. Missing (undefined) and corrupt both leave it alone.
    const raw = await this.readFile(indexPath)
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as { tables?: { sessions?: Record<string, unknown> } }
        const sessions = parsed.tables?.sessions
        if (sessions !== undefined) {
          for (const id of ids) {
            delete sessions[id]
            const native = nativeIds[id]
            if (native !== undefined && native !== id) delete sessions[native]
          }
          // Awaited so the scrub lands on disk before deleteSessions reports
          // success; a fire-and-forget write raced the caller's readers.
          await writeJsonAtomic(indexPath, parsed)
        }
      } catch {
        // A corrupt index is left alone; the harness owns it.
      }
    }
    const perSessionDir = join(this.dshHome, 'storages', 'session_projcache', 'sessions')
    try {
      for (const id of ids) {
        for (const spelling of [id, nativeIds[id]]) {
          if (spelling === undefined) continue
          const file = join(perSessionDir, `${spelling}.json`)
          if (existsSync(file)) unlinkSync(file)
        }
      }
    } catch {
      // Same best-effort contract.
    }
  }

  // ------------------------------------------------------------------
  // Automatic policies
  // ------------------------------------------------------------------

  async autoPreview(): Promise<AutoPreviewView> {
    const built = await this.buildFull()
    const now = Date.now()
    const protectedSet = new Set(this.protectedReason(undefined, built.rows).keys())
    const archiveCandidates = this.config.autoArchiveEnabled
      ? autoArchiveCandidates(built.rows, { days: this.config.autoArchiveDays, now, protectedIds: protectedSet })
      : []
    // A preview never writes: rows already carry their archive time (host
    // stamp first, ledger fallback — archive-at-host-time-1114), so these
    // candidates are the ones the next real cycle will compute.
    const deleteSeeds = this.config.autoDeleteEnabled
      ? autoDeleteSeedCandidates(built.rows, { retainDays: this.config.autoDeleteDays, now, runStartedAt: now, protectedIds: protectedSet })
      : []
    const plan = planDelete(built.rows, deleteSeeds.map((seed) => seed.id), this.protectedReason(undefined, built.rows))
    let deleteBytes = 0
    for (const id of plan.targets) {
      const size = built.rows.find((row) => row.id === id)?.sizeBytes
      if (typeof size === 'number') deleteBytes += size
    }
    return {
      archiveCandidates,
      deleteCandidates: plan.targets
        .map((id) => {
          const row = built.rows.find((entry) => entry.id === id)
          return { id, archivedAt: row?.archivedAt ?? 0, ...(row?.sizeBytes !== undefined ? { sizeBytes: row.sizeBytes } : {}) }
        }),
      deleteBytes,
    }
  }

  /**
   * Run one automatic cycle now (scheduler tick or manual trigger). The two
   * policies are independent: archive seeds from last-activity, delete seeds
   * from the recorded archive time strictly before this cycle started, so a
   * session archived by this very cycle is never deleted in it.
   */
  async runAutoCycle(kind: 'archive' | 'delete', currentSessionId?: string): Promise<RunStats> {
    // Candidate selection is inherently a whole-row scan; the pass runs
    // OUTSIDE the lock (方向②, fail-fast when already held) so a cycle never
    // holds the operation lock through an 11–21 s rebuild, and the ids it
    // chose are re-verified against live archive state inside the lock.
    if (this.lockHeld) throw new BusyError()
    const built = await this.buildFull()
    return this.withLock(async () => {
      this.cycleRunning = true
      const startedAt = Date.now()
      try {
        if (kind === 'archive') {
          const protectedSet = new Set(this.protectedReason(currentSessionId, built.rows).keys())
          const candidates = autoArchiveCandidates(built.rows, { days: this.config.autoArchiveDays, now: startedAt, protectedIds: protectedSet })
          // Targeted re-verify (方向②): a manual archive that landed while
          // this cycle's pass ran must not be re-stamped with a fresh ledger
          // entry (the harness verb is idempotent; the ledger clock is not).
          const liveArchived = new Set(
            (this.serviceFace<{ archivedSessionIds: readonly string[] }>('workspaceRegistry')?.archivedSessionIds ?? [])
              .map((id) => canonicalSessionId(id)),
          )
          const fresh = candidates.filter((entry) => !liveArchived.has(canonicalSessionId(entry.id)))
          const response = await this.archiveInternal(fresh.map((entry) => entry.id), 'auto', built.nativeIds)
          const stats = this.statsFrom(response.results, startedAt)
          this.autoState.lastArchiveRun = stats
          await this.flushState()
          return stats
        }
        const protectedMap = this.protectedReason(currentSessionId, built.rows)
        const protectedSet = new Set(protectedMap.keys())
        // Rows carry their archive time from the host stamp (ledger fallback),
        // so planning starts straight from them; the existing
        // `archivedAt >= runStartedAt` rule still keeps anything stamped at or
        // after this cycle's start out of this cycle's delete set.
        const seeds = autoDeleteSeedCandidates(built.rows, { retainDays: this.config.autoDeleteDays, now: startedAt, runStartedAt: startedAt, protectedIds: protectedSet })
        // `lastDeleteRun` is a DELETION record: an archive time is not a
        // deleted session, and counting it as an `ok` entry would report
        // "N sessions cleaned up" for a run that removed nothing. That number is
        // also the field users read to tell whether auto-delete works at all, so
        // inflating it would fake the very signal issue #1908 was diagnosed with.
        if (seeds.length === 0) {
          const stats: RunStats = { at: startedAt, total: 0, ok: 0, skipped: 0, failed: 0, entries: [] }
          this.autoState.lastDeleteRun = stats
          await this.flushState()
          return stats
        }
        const plan = planDelete(built.rows, seeds.map((seed) => seed.id), protectedMap)
        const response = await this.executeDelete(plan, built, 'auto')
        this.freshBuilt = undefined
        const stats = this.statsFrom(response.results, startedAt)
        this.autoState.lastDeleteRun = stats
        await this.flushState()
        return stats
      } finally {
        this.cycleRunning = false
      }
    })
  }

  /** Archive without re-acquiring the lock (used inside cycles). */
  private async archiveInternal(ids: readonly string[], source: 'manual' | 'auto', nativeIds: Readonly<Record<string, string>>): Promise<BatchResponse> {
    const results: OpResult[] = []
    const events: JournalEvent[] = []
    const journalAt = this.nextBatchAt()
    const now = Date.now()
    const okIds: string[] = []
    for (const id of ids) {
      this.busy.add(id)
      try {
        await archiveSession(this.ctx, nativeIds[id] ?? id)
        this.ledger.entries[id] = { archivedAt: now, source }
        results.push({ id, status: 'ok' })
        okIds.push(id)
        events.push({ id, op: 'archive', at: journalAt, entry: { ...this.ledger.entries[id] } })
      } catch (error) {
        results.push({ id, status: 'failed', reason: 'error', detail: error instanceof Error ? error.message.slice(0, 200) : String(error) })
      } finally {
        this.busy.delete(id)
      }
    }
    await this.flushLedger()
    this.patchFreshBuiltArchived(okIds, true, now)
    await this.journal(events)
    return { results, freedBytes: 0 }
  }

  // ------------------------------------------------------------------
  // Scheduler
  // ------------------------------------------------------------------

  private armScheduler(catchUp: boolean): void {
    if (this.schedulerTimer !== undefined) clearTimeout(this.schedulerTimer)
    if (this.disposed) return
    const intervalMs = Math.max(15, this.config.checkIntervalMin) * 60_000
    const due = this.autoState.nextCheckAt
    // Catch-up: a persisted next check in the past fires shortly after boot.
    const delay = catchUp && due !== undefined && due <= Date.now()
      ? 2_000
      : Math.max(2_000, due === undefined ? intervalMs : due - Date.now())
    this.autoState.nextCheckAt = Date.now() + delay
    void this.flushState()
    this.schedulerTimer = setTimeout(() => {
      void this.tick()
    }, delay)
  }

  /**
   * One throttled subagent-reaper + cascade-ledger-reconcile pass
   * (archive-cascade-reap-1114, design §四/§五). Public for tests, like
   * `runAutoCycle`; `tick` is the production caller. Runs under the operation
   * lock like every other ledger-writing archive path (design §四 串行与失败
   * 形态): a held lock skips this round with `BusyError` and leaves the 24h
   * throttle unset; anything else propagates to `tick`, which logs loud and
   * still arms the next check. `lastReapAt` is set only after a fully
   * successful cycle (feed read → both passes → ledger flush), so a failure
   * retries on the next tick instead of waiting a day.
   */
  async reapIdleSubagents(): Promise<void> {
    const now = Date.now()
    if (now - this.lastReapAt < REAP_SCAN_INTERVAL_MS) return
    const feed = this.serviceFace<{ list(request: unknown, signal: AbortSignal): Promise<{ items?: unknown[] }> }>('sessionController')
    const registry = this.serviceFace<{ archivedSessionIds: readonly string[]; archivedAtById?: Record<string, number> }>('workspaceRegistry')
    if (feed === undefined) throw new Error('sessionController face unavailable')
    if (registry === undefined) throw new Error('workspaceRegistry face unavailable')
    await this.withLock(() => runReapCycle({
      now: Date.now,
      // inventory.ts 同款请求形 (design §四 扫描数据源): direct face, never
      // `sources()` — that would pull dirIndex/projcache, the banned big heads.
      listFeed: () => feed.list({ includeArchived: true, includeSubagents: true, trimHeavyProjections: true }, AbortSignal.timeout(30_000)),
      archivedSessionIds: () => registry.archivedSessionIds,
      archivedAtById: () => registry.archivedAtById,
      // Built inside the lock: live+busy at scan time; `running` rides each feed row.
      protectedIds: new Set(this.protectedReason(undefined).keys()),
      ledger: this.ledger,
      archive: (nativeId) => archiveSession(this.ctx, nativeId),
      // Rejecting on purpose (unlike the silent `flushLedger` helper): a flush
      // failure must leave the throttle unset so the next tick retries it.
      flushLedger: async () => {
        if (!this.loaded) return
        await writeJsonAtomic(this.ledgerPath, this.ledger)
      },
    }))
    this.lastReapAt = Date.now()
  }

  private async tick(): Promise<void> {
    if (this.disposed) return
    const anythingEnabled = this.config.autoArchiveEnabled || this.config.autoDeleteEnabled
    if (anythingEnabled) {
      // runAutoCycle serializes through the lock; a held lock (manual batch)
      // delays this cycle without failing it — catch-up happens next tick.
      const currentSessionId = undefined
      try {
        if (this.config.autoArchiveEnabled) await this.runAutoCycle('archive', currentSessionId)
      } catch (error) {
        if (!(error instanceof BusyError)) {
          this.autoState.lastArchiveRun = {
            at: Date.now(),
            total: 0, ok: 0, skipped: 0, failed: 1,
            entries: [{ id: 'cycle', status: 'failed', reason: 'error', detail: error instanceof Error ? error.message.slice(0, 200) : String(error) }],
          }
          await this.flushState()
        }
      }
      try {
        if (this.config.autoDeleteEnabled) await this.runAutoCycle('delete', currentSessionId)
      } catch (error) {
        if (!(error instanceof BusyError)) {
          this.autoState.lastDeleteRun = {
            at: Date.now(),
            total: 0, ok: 0, skipped: 0, failed: 1,
            entries: [{ id: 'cycle', status: 'failed', reason: 'error', detail: error instanceof Error ? error.message.slice(0, 200) : String(error) }],
          }
          await this.flushState()
        }
      }
    }
    // Subagent reaper + cascade-ledger reconcile (archive-cascade-reap-1114,
    // design §四/§五): runs every tick regardless of the two cycle gates
    // above; a held lock skips this round (BusyError), anything else logs
    // loud and fails open — the schedule below still arms.
    try {
      await this.reapIdleSubagents()
    } catch (error) {
      if (!(error instanceof BusyError)) {
        console.error(`[dsh-session-archive] reaper cycle failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.autoState.nextCheckAt = Date.now() + Math.max(15, this.config.checkIntervalMin) * 60_000
    await this.flushState()
    this.armScheduler(false)
  }

  // ------------------------------------------------------------------
  // Preview
  // ------------------------------------------------------------------

  async preview(id: string): Promise<SessionPreviewView> {
    const controller = this.serviceFace<{ inspect?(sessionId: string, signal?: AbortSignal): Promise<{ meta?: { createdAt?: number; cwd?: string }; events?: readonly unknown[] }> }>('sessionController')
    // Structured fresh source first (方向②③): a memo hit skips the whole
    // pass; a memo miss for THIS id falls back to a fresh pass before
    // declaring not-found, so a session born inside the window never 404s.
    const retained = this.peekFreshBuilt()
    let built = retained ?? await this.buildFull()
    let row: ArchiveSessionRow | undefined = built.rows.find((entry) => entry.id === id)
    if (row === undefined && retained !== undefined) {
      built = await this.buildFull()
      row = built.rows.find((entry) => entry.id === id)
    }
    if (row === undefined) {
      throw new Error('session not found')
    }
    let meta = { createdAt: row.createdAt, cwd: row.cwd }
    let excerpt: SessionPreviewView['excerpt'] = []
    let messageCount = 0
    if (controller !== undefined && typeof controller.inspect === 'function') {
      try {
        // The harness knows the session under its native id spelling.
        const inspect = await controller.inspect(built.nativeIds[id] ?? id, AbortSignal.timeout(15_000))
        if (meta.createdAt === undefined && inspect.meta?.createdAt !== undefined) meta = { ...meta, createdAt: inspect.meta.createdAt }
        if (meta.cwd === undefined && inspect.meta?.cwd !== undefined) meta = { ...meta, cwd: inspect.meta.cwd }
        const messages = extractMessages(inspect.events ?? [])
        messageCount = messages.total
        excerpt = messages.excerpt
      } catch {
        // Preview failure keeps the basic-info view; the UI offers a retry.
      }
    }
    return {
      id,
      ...(row.title !== undefined ? { title: row.title } : {}),
      ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
      ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
      ...(row.sizeBytes !== undefined ? { sizeBytes: row.sizeBytes } : {}),
      messageCount,
      excerpt,
    }
  }
}

/**
 * Tolerant message extraction from session events: user/assistant message
 * events with string or block-array content. Unknown shapes are ignored, so
 * a malformed event never breaks the preview.
 */
export function extractMessages(events: readonly unknown[]): { total: number; excerpt: { role: string; text: string }[] } {
  const excerpt: { role: string; text: string }[] = []
  let total = 0
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    const record = event as { type?: unknown; data?: unknown }
    if (typeof record.type !== 'string') continue
    if (record.type !== 'user/message' && record.type !== 'assistant/message') continue
    const text = messageText(record.data)
    if (text === undefined) continue
    total += 1
    if (excerpt.length < PREVIEW_MESSAGE_CAP) {
      excerpt.push({ role: record.type === 'user/message' ? 'user' : 'assistant', text: text.length > PREVIEW_TEXT_CAP ? `${text.slice(0, PREVIEW_TEXT_CAP)}…` : text })
    }
  }
  return { total, excerpt }
}

function messageText(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { text?: unknown; content?: unknown; message?: unknown }
  if (typeof record.text === 'string') return record.text
  const content = record.content ?? record.message
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') parts.push(block)
      else if (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text)
      }
    }
    const joined = parts.join('\n').trim()
    return joined === '' ? undefined : joined
  }
  return undefined
}
