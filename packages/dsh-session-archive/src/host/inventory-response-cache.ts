/**
 * Whole-response TTL cache for `GET /api/dsh-session-archive/inventory`.
 *
 * One inventory pass costs a full session-feed scan plus a ~0.9 MB JSON
 * serialization (measured on the production home: 11–21 s warm, 35 s at the
 * day's max, 706 s in an extreme window, and a 500 when the 30 s route
 * timeout fires — forensics `archive-lag-forensics-1110.md` §八). The taskbot
 * janitor polls this route every 10 minutes behind a 10-second HTTP timeout,
 * so *every* rebuild it pays is a FAIL-CLOSED round; panel pollers re-request
 * the same document continuously while each rebuild starves the shared event
 * loop.
 *
 * Reads never pay the rebuild once a snapshot exists (stale-while-revalidate):
 * - inside the TTL window the retained payload is served verbatim;
 * - past the window, or after an invalidation, the retained payload is still
 *   served immediately and a single-flight background rebuild refreshes it —
 *   reader latency stays sub-millisecond even when a rebuild outlives the
 *   taskbot's whole timeout;
 * - only a reader that finds no snapshot at all (first build after boot)
 *   pays a synchronous rebuild, and concurrent cold readers coalesce into
 *   one.
 *
 * Freshness never depends on the window alone: the owner (ArchiveService)
 * invalidates after every mutating operation, and invalidation wins over an
 * in-flight rebuild — a rebuild started before the invalidation is never
 * retained, so a refreshed snapshot cannot carry pre-mutation rows once the
 * refresh lands. The trade-off is bounded and explicit: between a mutation
 * and the refresh landing (one rebuild duration) GET readers may see the
 * pre-mutation snapshot; every mutating route keeps building its own fresh
 * inventory under the operation lock, so archive/restore/delete decisions are
 * never made from this cache.
 *
 * Nothing here polls or accumulates: one entry, one in-flight rebuild, and a
 * refresh is always one call away.
 *
 * @module @linxin666/dsh-session-archive/host/inventory-response-cache
 */

/** One built inventory response, serialized once (what `build` returns). */
export interface InventoryResponseSnapshot {
  /** The response body, pre-served on a hit; produced once per rebuild. */
  payload: string
  /** When this payload was produced (same scale as Date.now()). */
  generatedAt: number
}

/** A retained snapshot plus the cache generation it may answer under. */
interface RetainedSnapshot extends InventoryResponseSnapshot {
  /** Cache generation the snapshot was retained under (invalidation guard). */
  generation: number
}

/** What one reader is served, with cache observability for the wire headers. */
export interface InventoryResponseServe {
  payload: string
  /** True when a retained snapshot answered; false when this read paid the rebuild. */
  hit: boolean
  /**
   * True when the retained snapshot answered but is past the TTL window or
   * was dropped by an invalidation — a background refresh is under way.
   */
  stale: boolean
  /** How old the served snapshot is, in milliseconds (0 on a rebuild). */
  ageMs: number
}

/** Collaborators of one response cache instance. */
export interface InventoryResponseCacheOptions {
  /** How long a built response may be served as fresh, in milliseconds. */
  ttlMs: number
  /** Performs the real rebuild (inventory pass + serialization). */
  build: () => Promise<InventoryResponseSnapshot>
  /** Clock reading; defaults to wall time. Injected for deterministic tests. */
  now?: () => number
}

export class InventoryResponseCache {
  private readonly ttlMs: number
  private readonly build: () => Promise<InventoryResponseSnapshot>
  private readonly now: () => number
  private entry: RetainedSnapshot | undefined
  private inflight: { promise: Promise<InventoryResponseSnapshot>; generation: number } | undefined
  private generation = 0
  private buildCount = 0

  constructor(options: InventoryResponseCacheOptions) {
    this.ttlMs = options.ttlMs
    this.build = options.build
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * The current response. Inside the window the retained payload is served
   * verbatim; past it (or after an invalidation) the retained payload is
   * served anyway while one background rebuild refreshes it; a reader that
   * finds no usable snapshot pays the rebuild itself, coalescing with any
   * rebuild already running.
   */
  async serve(): Promise<InventoryResponseServe> {
    const at = this.now()
    const entry = this.entry
    if (entry !== undefined && at >= entry.generatedAt) {
      const ageMs = at - entry.generatedAt
      if (entry.generation === this.generation && ageMs < this.ttlMs) {
        return { payload: entry.payload, hit: true, stale: false, ageMs }
      }
      // Retained but past the window or dropped by an invalidation: answer
      // verbatim now and refresh behind the reader, so this read never pays
      // the rebuild. The refresh is single-flighted and generation-guarded.
      this.kick()
      return { payload: entry.payload, hit: true, stale: true, ageMs }
    }
    // No snapshot, or the clock stepped back past its produced-at (never
    // trust a future-dated body as fresh): pay the rebuild, coalescing with
    // one already running.
    const inflight = this.inflight
    if (inflight !== undefined && inflight.generation === this.generation) {
      // Coalesced reader: this one waited for a rebuild it did not start, so
      // it is reported as a miss (it paid latency, not a retained snapshot).
      const built = await inflight.promise
      return { payload: built.payload, hit: false, stale: false, ageMs: 0 }
    }
    const generation = this.generation
    const promise = (async () => {
      this.buildCount += 1
      return this.build()
    })()
    this.inflight = { promise, generation }
    try {
      const built = await promise
      // An invalidation that landed while this rebuild ran forbids retaining
      // its result (it may predate the mutation the invalidation followed).
      if (this.generation === generation) {
        this.entry = { payload: built.payload, generatedAt: built.generatedAt, generation }
      }
      return { payload: built.payload, hit: false, stale: false, ageMs: 0 }
    } finally {
      if (this.inflight?.promise === promise) this.inflight = undefined
    }
  }

  /**
   * Start a background refresh if none is running. Errors are swallowed —
   * the retained snapshot keeps answering until a later serve retries — but
   * the build counter still records the attempt for tests.
   */
  private kick(): void {
    if (this.inflight !== undefined && this.inflight.generation === this.generation) return
    const generation = this.generation
    const promise = (async () => {
      this.buildCount += 1
      return this.build()
    })()
    this.inflight = { promise, generation }
    void promise.then(
      (built) => {
        if (this.generation === generation) {
          this.entry = { payload: built.payload, generatedAt: built.generatedAt, generation }
        }
      },
      () => { /* keep the retained snapshot; the next serve retries */ },
    ).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = undefined
    })
  }

  /**
   * Drop the current snapshot from freshness (it may be served stale while a
   * refresh runs); the next serve refreshes behind its reader. A rebuild that
   * started before this invalidation must not answer readers that arrive
   * after it — an already-joined reader still receives the body it is
   * awaiting, it is just never retained.
   */
  invalidate(): void {
    this.generation += 1
    this.inflight = undefined
  }

  /** Number of real rebuilds this instance performed; diagnostics for tests. */
  get builds(): number {
    return this.buildCount
  }
}
