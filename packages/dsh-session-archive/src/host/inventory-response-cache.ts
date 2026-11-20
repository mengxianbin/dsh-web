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
 * - only a reader that finds no snapshot at all pays a synchronous rebuild,
 *   and concurrent cold readers coalesce into one. The owner's boot prewarm
 *   ({@link InventoryResponseCache.prewarm}) issues that first build in the
 *   background with no reader waiting, so the first panel open after a
 *   restart is a hit; an explicit refresh ({@link InventoryResponseCache.rebuild})
 *   is the one read that deliberately pays the rebuild for its caller.
 *
 * Freshness never depends on the window alone: the owner (ArchiveService)
 * invalidates after every mutating operation, and invalidation wins over an
 * in-flight rebuild — a rebuild started before the invalidation is never
 * retained, so a refreshed snapshot cannot carry pre-mutation rows once the
 * refresh lands. Since archive-inline-inventory-1111 方向④ invalidation goes
 * one step further and **aborts** the in-flight build: an orphaned full scan
 * dies at the moment its result stops being wanted instead of burning the
 * shared event loop to a discarded conclusion (a reader already joined on
 * that build simply retries under the new generation and still receives a
 * payload). The trade-off stays bounded and explicit: between a mutation and
 * the refresh landing GET readers may see the pre-mutation snapshot; mutating
 * routes never read decisions from this cache (archive/restore take targeted
 * per-id state, delete/auto build their own fresh inventory outside the
 * operation lock).
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
  /**
   * Performs the real rebuild (inventory pass + serialization). The signal
   * aborts when {@link InventoryResponseCache.invalidate} drops the in-flight
   * build, so an orphaned full scan is cancelled instead of finishing into a
   * retained nothing (archive-inline-inventory-1111 方向④).
   */
  build: (signal: AbortSignal) => Promise<InventoryResponseSnapshot>
  /** Clock reading; defaults to wall time. Injected for deterministic tests. */
  now?: () => number
}

/** One in-flight rebuild: its promise, the generation it started under, and its abort handle. */
interface InflightBuild {
  promise: Promise<InventoryResponseSnapshot>
  generation: number
  controller: AbortController
}

export class InventoryResponseCache {
  private readonly ttlMs: number
  private readonly build: (signal: AbortSignal) => Promise<InventoryResponseSnapshot>
  private readonly now: () => number
  private entry: RetainedSnapshot | undefined
  private inflight: InflightBuild | undefined
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
   * rebuild already running. A build aborted mid-flight by {@link invalidate}
   * is retried under the new generation — joined readers still end with a
   * payload, they just never receive the dead build's.
   */
  async serve(): Promise<InventoryResponseServe> {
    for (;;) {
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
      const joined = this.inflight
      if (joined !== undefined && joined.generation === this.generation) {
        // Coalesced reader: this one waited for a rebuild it did not start, so
        // it is reported as a miss (it paid latency, not a retained snapshot).
        try {
          const built = await joined.promise
          return { payload: built.payload, hit: false, stale: false, ageMs: 0 }
        } catch (error) {
          // Joined build died to an invalidation abort: retry under the new
          // generation rather than surfacing the cancellation as a 500.
          if (joined.controller.signal.aborted) continue
          throw error
        }
      }
      const generation = this.generation
      const controller = new AbortController()
      const promise = (async () => {
        this.buildCount += 1
        return this.build(controller.signal)
      })()
      const started: InflightBuild = { promise, generation, controller }
      this.inflight = started
      try {
        const built = await promise
        // An invalidation that landed while this rebuild ran forbids retaining
        // its result (it may predate the mutation the invalidation followed).
        if (this.generation === generation) {
          this.entry = { payload: built.payload, generatedAt: built.generatedAt, generation }
        }
        return { payload: built.payload, hit: false, stale: false, ageMs: 0 }
      } catch (error) {
        // invalidate() aborted this build: it never landed and must not count
        // as a real rebuild ("buildCount 不白计"); the retry loop picks the
        // fresh generation up.
        if (controller.signal.aborted) {
          this.buildCount -= 1
          continue
        }
        throw error
      } finally {
        if (this.inflight?.promise === promise) this.inflight = undefined
      }
    }
  }

  /**
   * Start the first build in the background with no reader waiting on it (the
   * boot prewarm): once it lands, the first panel open is a cache hit instead
   * of paying the 11–35 s rebuild inline. A no-op when a snapshot exists —
   * serve() already answers from it — and a no-op while a build runs: that is
   * the build a reader would join anyway. A failure is swallowed exactly like
   * a background refresh's: the first real reader retries it.
   */
  prewarm(): void {
    if (this.entry !== undefined) return
    this.kick()
  }

  /**
   * The explicit-refresh read (the panel's refresh button): drop the
   * generation so the retained bytes stop answering, then pay the rebuild for
   * THIS reader instead of serving them. Every other reader arriving meanwhile
   * still gets the retained bytes immediately (stale-while-revalidate), so a
   * refresh click never queues the taskbot's poll behind it; the caller waits
   * out the build and, when a mutation aborts it mid-flight, retries under the
   * new generation — it never receives the dead build's bytes.
   */
  async rebuild(): Promise<InventoryResponseServe> {
    this.invalidate()
    for (;;) {
      const inflight = this.kick()
      try {
        const built = await inflight.promise
        return { payload: built.payload, hit: false, stale: false, ageMs: 0 }
      } catch (error) {
        // invalidate() aborted this build (a mutation landed, or a second
        // refresh click): retry under the new generation rather than
        // surfacing the cancellation as a 500.
        if (inflight.controller.signal.aborted) continue
        throw error
      }
    }
  }

  /**
   * Start a background refresh if none is running, and hand back the build
   * that now covers the current generation (started or joined). Errors are
   * swallowed — the retained snapshot keeps answering until a later serve
   * retries — but the build counter still records the attempt for tests. A
   * refresh aborted by an invalidation is not an attempt that ever ran to an
   * outcome: its count is given back (方向④, "不白计").
   */
  private kick(): InflightBuild {
    const running = this.inflight
    if (running !== undefined && running.generation === this.generation) return running
    const generation = this.generation
    const controller = new AbortController()
    const promise = (async () => {
      this.buildCount += 1
      return this.build(controller.signal)
    })()
    const started: InflightBuild = { promise, generation, controller }
    this.inflight = started
    void promise.then(
      (built) => {
        if (this.generation === generation) {
          this.entry = { payload: built.payload, generatedAt: built.generatedAt, generation }
        }
      },
      () => {
        if (controller.signal.aborted) this.buildCount -= 1
        // else: keep the retained snapshot; the next serve retries (attempt counted).
      },
    ).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = undefined
    })
    return started
  }

  /**
   * Drop the current snapshot from freshness (it may be served stale while a
   * refresh runs); the next serve refreshes behind its reader. A rebuild that
   * started before this invalidation must not answer readers that arrive
   * after it — and since 方向④ it does not get to finish either: the
   * in-flight build is aborted on the spot (an already-joined reader retries
   * under the new generation and still receives a payload).
   */
  invalidate(): void {
    this.generation += 1
    const inflight = this.inflight
    this.inflight = undefined
    inflight?.controller.abort()
  }

  /** Number of real rebuilds this instance performed; diagnostics for tests. */
  get builds(): number {
    return this.buildCount
  }
}
