/**
 * Bounded reuse of one derived value across nearby readers.
 *
 * Two host-side derivations are recomputed by every inventory pass while
 * changing only when something outside that pass rewrites them: the
 * sessions-root directory walk (see `host/dir-index-cache.ts`) and the parsed
 * harness projection-cache index (`readProjcacheIndex`). One user action
 * triggers several passes (a chunk per batch request plus the refresh that
 * follows it), so the same unchanged input is re-derived each time. This memo
 * serves the previous derivation inside a bounded window instead.
 *
 * Reuse is only sound while the input has not changed underneath us, so the
 * window is short and the owner must invalidate explicitly after it rewrites
 * the input itself. Nothing here polls or accumulates: one entry, and a
 * derivation is always one call away.
 *
 * @module @linxin666/dsh-session-archive/host/ttl-memo
 */

/** Collaborators of one memo instance. */
export interface TtlMemoOptions<T> {
  /** How long a derived value may be reused, in milliseconds. */
  ttlMs: number
  /** Performs the real derivation. */
  load: () => T
  /** Clock reading; defaults to wall time. Injected for deterministic tests. */
  now?: () => number
}

/** Collaborators of one asynchronous memo instance. */
export interface AsyncTtlMemoOptions<T> {
  /** How long a derived value may be reused, in milliseconds. */
  ttlMs: number
  /** Performs the real derivation; async so a derivation never blocks the event loop. */
  load: () => Promise<T>
  /** Clock reading; defaults to wall time. Injected for deterministic tests. */
  now?: () => number
}

/**
 * One-entry, time-bounded memo for an expensive derivation. The derivation
 * runs at most once per window per instance, and {@link invalidate} forces the
 * next read to derive again (the owner calls it after its own writes).
 */
export class TtlMemo<T> {
  private readonly ttlMs: number
  private readonly load: () => T
  private readonly now: () => number
  private entry: { at: number; value: T } | undefined
  private loadCount = 0

  constructor(options: TtlMemoOptions<T>) {
    this.ttlMs = options.ttlMs
    this.load = options.load
    this.now = options.now ?? (() => Date.now())
  }

  /** The current value: the retained derivation while it is fresh, else a new one. */
  get(): T {
    const at = this.now()
    const entry = this.entry
    if (entry !== undefined && at - entry.at < this.ttlMs && at >= entry.at) return entry.value
    const value = this.load()
    this.loadCount += 1
    this.entry = { at, value }
    return value
  }

  /** Drop the retained value; the next {@link get} derives again. */
  invalidate(): void {
    this.entry = undefined
  }

  /** Number of real derivations this instance performed; diagnostics for tests. */
  get loads(): number {
    return this.loadCount
  }
}

/**
 * The asynchronous sibling of {@link TtlMemo}: same one-entry window rule,
 * same explicit invalidation, but the derivation is awaited off the event
 * loop and two extra guarantees follow from the await:
 *
 * - Single flight: readers that arrive while a derivation is running join
 *   that derivation instead of starting a competing one (a burst of inventory
 *   readers must not fan out into a burst of file reads).
 * - Invalidation wins: {@link invalidate} bumps a generation, and a running
 *   derivation only retains its value for readers of the generation it
 *   started in — an invalidation that lands mid-derivation can never
 *   resurrect the pre-invalidation value into a later window.
 */
export class AsyncTtlMemo<T> {
  private readonly ttlMs: number
  private readonly load: () => Promise<T>
  private readonly now: () => number
  private entry: { at: number; value: T } | undefined
  private inflight: { promise: Promise<{ at: number; value: T }>; generation: number } | undefined
  private generation = 0
  private loadCount = 0

  constructor(options: AsyncTtlMemoOptions<T>) {
    this.ttlMs = options.ttlMs
    this.load = options.load
    this.now = options.now ?? (() => Date.now())
  }

  /** The current value: the retained derivation while it is fresh, else a new one. */
  async get(): Promise<T> {
    const at = this.now()
    const entry = this.entry
    if (entry !== undefined && at - entry.at < this.ttlMs && at >= entry.at) return entry.value
    const inflight = this.inflight
    if (inflight !== undefined && inflight.generation === this.generation) return (await inflight.promise).value
    const generation = this.generation
    const promise = (async () => {
      this.loadCount += 1
      const value = await this.load()
      return { at, value }
    })()
    this.inflight = { promise, generation }
    try {
      const loaded = await promise
      if (this.generation === generation) this.entry = loaded
      return loaded.value
    } finally {
      if (this.inflight?.promise === promise) this.inflight = undefined
    }
  }

  /** Drop the retained value; the next {@link get} derives again. */
  invalidate(): void {
    this.entry = undefined
    this.generation += 1
    // Readers that have not joined yet must not join a derivation that
    // started before this invalidation; an already-joined reader still
    // receives the value it is awaiting, it is just never retained.
    this.inflight = undefined
  }

  /** Number of real derivations this instance performed; diagnostics for tests. */
  get loads(): number {
    return this.loadCount
  }
}
