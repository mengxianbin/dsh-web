/**
 * Whole-response TTL cache for `GET /api/dsh-session-archive/inventory`.
 *
 * One inventory pass costs a full session-feed scan plus a ~0.8 MB JSON
 * serialization (measured 2026-10-30: 8.4–15.3 s per pass on the production
 * home), and the browser panel re-requests the document on every poll and
 * refresh. This cache retains the *serialized* body for a short window so a
 * cache-hit request costs neither the rebuild nor the stringify, and it
 * coalesces a cold burst into one rebuild (single flight) instead of one
 * rebuild per waiting request.
 *
 * Reuse is only sound while nothing rewrote archive state underneath it, so
 * the window is short and the owner (ArchiveService) invalidates explicitly
 * after every mutating operation. Invalidation also wins over an in-flight
 * rebuild: a rebuild that started before the invalidation is never retained,
 * so a deleted session cannot resurface from memory. Nothing here polls or
 * accumulates: one entry, and a rebuild is always one call away.
 *
 * @module @linxin666/dsh-session-archive/host/inventory-response-cache
 */

/** One built inventory response, serialized once. */
export interface InventoryResponseSnapshot {
  /** The response body, pre-serialized; served verbatim on a hit. */
  payload: string
  /** When this payload was produced (same scale as Date.now()). */
  generatedAt: number
}

/** What one reader is served, with cache observability for the wire headers. */
export interface InventoryResponseServe {
  payload: string
  /** True when the retained snapshot answered; false when this read paid the rebuild. */
  hit: boolean
  /** How old the served snapshot is, in milliseconds (0 on a rebuild). */
  ageMs: number
}

/** Collaborators of one response cache instance. */
export interface InventoryResponseCacheOptions {
  /** How long a built response may be reused, in milliseconds. */
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
  private entry: InventoryResponseSnapshot | undefined
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
   * verbatim; outside it one rebuild runs, and readers arriving while it runs
   * join it rather than starting their own.
   */
  async serve(): Promise<InventoryResponseServe> {
    const at = this.now()
    const entry = this.entry
    if (entry !== undefined && at - entry.generatedAt < this.ttlMs && at >= entry.generatedAt) {
      return { payload: entry.payload, hit: true, ageMs: at - entry.generatedAt }
    }
    const inflight = this.inflight
    if (inflight !== undefined && inflight.generation === this.generation) {
      // Coalesced reader: this one waited for a rebuild it did not start, so
      // it is reported as a miss (it paid latency, not a retained snapshot).
      const built = await inflight.promise
      return { payload: built.payload, hit: false, ageMs: 0 }
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
      if (this.generation === generation) this.entry = built
      return { payload: built.payload, hit: false, ageMs: 0 }
    } finally {
      if (this.inflight?.promise === promise) this.inflight = undefined
    }
  }

  /** Drop the retained response; the next {@link serve} rebuilds. */
  invalidate(): void {
    this.entry = undefined
    this.generation += 1
    // A rebuild that started before this invalidation must not answer readers
    // that arrive after it; an already-joined reader still receives the body
    // it is awaiting, it is just never retained.
    this.inflight = undefined
  }

  /** Number of real rebuilds this instance performed; diagnostics for tests. */
  get builds(): number {
    return this.buildCount
  }
}
