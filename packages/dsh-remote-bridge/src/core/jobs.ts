/**
 * The bridge's read-only window on the host's background jobs: one minimal
 * projection per job, and the change notification a phone's navigation bar
 * needs to keep a count honest.
 *
 * There is exactly one source of truth here and it is the host's own job
 * registry (`ctx.jobs`, the service the `dsh-api-job-controller` Remote
 * namespace is itself a projection of). This module adds no second store, no
 * polling loop and no invented status vocabulary: it reads `list()`, publishes
 * the host's own `kind` and `status` strings verbatim, and hears changes from
 * the registry's own event stream.
 *
 * Two shapes of the host's API matter to what a phone can be shown:
 *
 * - `list(caller)` is owner-fenced. Naming a session returns that session's own
 *   jobs plus every job no session owns; naming no session returns only the
 *   unowned jobs. Those are TWO truthful scopes, not one global view, and the
 *   host has no global view to offer: a job list is never "every job in the
 *   process" unless every job in the process happens to be unowned.
 * - The event stream reports `output` appends as well as lifecycle commits. An
 *   append says nothing about the SET, so it is dropped here: this channel
 *   never publishes per output byte, which is the whole reason the roster is
 *   not a projection of `job/follow`.
 *
 * The types below mirror `@deepseek-ai/dsh-jobs` field for field. That package
 * is the host's, not this one's, so the contract is declared structurally
 * instead of imported — the same rule `questions.ts` and `wire.ts` follow, and
 * what keeps a test double down to the two members actually called.
 * @module dsh-remote-bridge/core/jobs
 */

import { failureText } from './gateway-errors.ts'

/**
 * The slice of the host's `JobView` this bridge reads.
 *
 * Deliberately not the whole view: `output` (the ring's offsets and spill
 * paths), `progress`, `detail` and `outputLimitBytes` are host bookkeeping a
 * phone neither shows nor needs, and a projection that read them would tempt a
 * later change into publishing bytes.
 */
export interface JobViewLike {
  readonly id: string
  readonly kind: string
  readonly label: string
  /** Owning session; absent for an unowned job, which every caller can see. */
  readonly owner?: string
  readonly status: string
  /** Epoch milliseconds. */
  readonly startedAt: number
  /** Epoch milliseconds; absent while the job is live. */
  readonly finishedAt?: number
}

/** One lifecycle event of the host's event stream, as far as this bridge reads it. */
export interface JobEventLike {
  /** `output` is the one type this bridge drops without reading further. */
  readonly type: string
  /** The job's projection after the commit; absent on an `output` append. */
  readonly job?: JobViewLike
  /** Owning session, carried by `output` events, which carry no projection. */
  readonly owner?: string
}

/** Who a subscription hears about. `all` is what a bridge serving every session asks for. */
export type JobEventFilterLike = { readonly owners: 'all' | 'scope' } | { readonly owner: string }

/** The host registry's event stream. */
export interface JobEventsFace {
  subscribe(filter: JobEventFilterLike, listener: (event: JobEventLike) => void): () => void
}

/**
 * The slice of `ctx.jobs` this package reads.
 *
 * Optional in the plugin's faces for the reason the metadata faces are: the
 * registry is not in this plugin's `inject` list, and a host that composes no
 * job plugin answers `jobs-unavailable` instead of failing to start.
 */
export interface JobRegistryFace {
  list(caller?: string): readonly JobViewLike[]
  readonly events: JobEventsFace
}

/** Which truthful scope one roster answer covers. */
export type JobScope = 'session' | 'unowned'

/**
 * One job in protocol v1 vocabulary: the minimal, stable view.
 *
 * `kind` and `status` are the host's own strings, verbatim — this protocol
 * publishes no enum of its own, so a producer kind or a lifecycle status added
 * in the host crosses unchanged instead of being flattened into a guess.
 * Every optional key is omitted when the host omitted it, never filled in.
 */
export interface JobRow {
  readonly id: string
  readonly kind: string
  readonly status: string
  /** The host's `label`: its own one-line description, the field a phone renders as the job's title. */
  readonly label?: string
  /** The host's `owner`, verbatim, under a name that cannot be read as an object. */
  readonly ownerSessionId?: string
  readonly startedAt?: number
  readonly finishedAt?: number
}

/**
 * The body of one `jobs.list` answer and of one `jobs.changed` event.
 *
 * One box for both, so a client parses its navigation-bar count out of the same
 * shape it refreshes through, and so a client holding two scopes open can tell
 * whose set moved. `sessionId` is present exactly when the scope is `session`.
 */
export interface JobsPayload {
  readonly sessionId?: string
  readonly scope: JobScope
  readonly jobs: readonly JobRow[]
}

/**
 * Coalescing window of one roster publish, in milliseconds.
 *
 * The host registry announces every commit synchronously, so a job that
 * registers, reports progress and settles in one turn is three events for one
 * fact a phone renders as one row. This window folds a burst into a single
 * whole-set read, which is why the topic can never turn into a stream of
 * frames. It matches the job controller's own `observeFlushMs` default, so a
 * browser and a phone watching the same set refresh at the same cadence.
 */
export const JOBS_FLUSH_MS = 100

/** Largest number of job rows one payload carries before it risks the frame budget. */
export const JOBS_MAX_ROWS = 200

/**
 * Project one host job into the protocol's own fields.
 *
 * Explicitly field by field: an unknown key the host adds later must not reach
 * the wire, and a value of the wrong type is dropped rather than coerced — the
 * key is simply absent, which a client already has to handle.
 * @param job - the host's projection.
 * @returns the minimal row, or undefined when the host gave no usable id.
 */
export function projectJob(job: JobViewLike): JobRow | undefined {
  if (typeof job.id !== 'string' || job.id === '') return undefined
  return {
    id: job.id,
    kind: typeof job.kind === 'string' ? job.kind : '',
    status: typeof job.status === 'string' ? job.status : '',
    ...(typeof job.label === 'string' && job.label !== '' ? { label: job.label } : {}),
    ...(typeof job.owner === 'string' && job.owner !== '' ? { ownerSessionId: job.owner } : {}),
    ...(Number.isFinite(job.startedAt) ? { startedAt: job.startedAt } : {}),
    ...(Number.isFinite(job.finishedAt) ? { finishedAt: job.finishedAt } : {}),
  }
}

/**
 * Project a whole host roster.
 * @param jobs - the host's projections.
 * @returns the rows, in the host's own order, bounded by {@link JOBS_MAX_ROWS}.
 */
export function projectJobs(jobs: readonly JobViewLike[]): readonly JobRow[] {
  const rows: JobRow[] = []
  for (const job of jobs) {
    const row = projectJob(job)
    if (row !== undefined) rows.push(row)
    if (rows.length >= JOBS_MAX_ROWS) break
  }
  return rows
}

/** The key one scope is subscribed and deduplicated under. */
export function scopeKey(sessionId?: string): string {
  return sessionId === undefined ? 'unowned' : `session:${sessionId}`
}

/**
 * Whether one job belongs in one scope's visible set.
 *
 * This is the host's own fence, restated for routing events: a session sees its
 * own jobs plus every unowned one, and the unowned scope sees exactly the jobs
 * no session owns.
 * @param owner - the job's owning session, when it has one.
 * @param sessionId - the scope's session; omitted for the unowned scope.
 */
export function inScope(owner: string | undefined, sessionId?: string): boolean {
  if (sessionId === undefined) return owner === undefined
  return owner === undefined || owner === sessionId
}

/** One watched scope and everything published for it. */
interface ScopeWatch {
  readonly sessionId: string | undefined
  readonly key: string
  /** One listener per connection that asked for this scope. */
  readonly listeners: Set<(payload: JobsPayload) => void>
  /** Set while a burst is waiting for its coalescing window to elapse. */
  timer: NodeJS.Timeout | undefined
}

/** Everything one mount's roster was built with. */
export interface JobRosterOptions {
  /** Resolves the host registry now; called per read, never captured once, so a registry that mounts later is still picked up. */
  readonly faces: () => { readonly jobs?: JobRegistryFace | undefined }
  readonly log: (message: string) => void
  /** Coalescing window; the default is {@link JOBS_FLUSH_MS}. */
  readonly flushMs?: number
}

/**
 * The bridge's background-job reads and change notifications.
 *
 * One instance is built per host mount and shared by every connection, because
 * a job is a fact about the host, not about the device that asked. Scopes are
 * reference-counted by their listeners: a scope nobody watches holds no timer,
 * and the registry subscription itself exists only while at least one scope
 * does. That is what makes "a connection that never asked receives nothing"
 * structural rather than a filter someone has to remember to apply.
 */
export class JobRoster {
  readonly #options: JobRosterOptions
  readonly #flushMs: number
  readonly #watches = new Map<string, ScopeWatch>()
  #unsubscribe: (() => void) | undefined
  #disposed = false

  constructor(options: JobRosterOptions) {
    this.#options = options
    this.#flushMs = options.flushMs ?? JOBS_FLUSH_MS
  }

  /** @returns whether this host composes a job registry at all. */
  get available(): boolean {
    return this.#face() !== undefined
  }

  /**
   * Read one scope's visible set.
   *
   * Synchronous, because the host registry projects in memory: no stream is
   * opened and no socket is waited on, which is what makes this cheap enough to
   * answer on request and again after every coalesced burst.
   * @param sessionId - the scope's session; omitted for the unowned scope.
   * @returns the payload, or undefined when this host has no job registry.
   */
  read(sessionId?: string): JobsPayload | undefined {
    const face = this.#face()
    if (face === undefined) return undefined
    try {
      const jobs = face.list(sessionId)
      return {
        ...(sessionId === undefined ? {} : { sessionId }),
        scope: sessionId === undefined ? 'unowned' : 'session',
        jobs: projectJobs(Array.isArray(jobs) ? jobs : []),
      }
    } catch (error) {
      // The registry is in-process and synchronous, so a throw is a defect in it
      // rather than a transient outage. It still must not fail the method for
      // every other scope: an unreadable set is answered as an empty one below,
      // and the read is retried on the next call.
      this.#options.log(`the background job roster could not be read: ${failureText(error)}`)
      return undefined
    }
  }

  /**
   * Watch one scope, and publish each coalesced change to every watcher of it.
   *
   * Watching is what a `jobs.list` call earns: a scope nobody listed is never
   * read again, so a phone that declared the capability and asked for nothing
   * receives no `jobs.changed` — the requirement that keeps N open sessions
   * from becoming N sets streaming at a phone that asked for none.
   * @param sessionId - the scope's session; omitted for the unowned scope.
   * @param listener - receives one whole-set payload per coalesced change.
   * @returns the disposer, or undefined when this host has no job registry.
   */
  watch(sessionId: string | undefined, listener: (payload: JobsPayload) => void): (() => void) | undefined {
    if (this.#disposed || this.#face() === undefined) return undefined
    const key = scopeKey(sessionId)
    let watch = this.#watches.get(key)
    if (watch === undefined) {
      watch = { sessionId, key, listeners: new Set(), timer: undefined }
      this.#watches.set(key, watch)
    }
    watch.listeners.add(listener)
    this.#subscribe()
    return () => { this.#unwatch(watch, listener) }
  }

  /** Stop every watch and clear every timer. Idempotent. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const watch of this.#watches.values()) {
      if (watch.timer !== undefined) clearTimeout(watch.timer)
      watch.timer = undefined
    }
    this.#watches.clear()
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
  }

  /** Resolve the host registry now, or undefined when this host mounts none. */
  #face(): JobRegistryFace | undefined {
    if (this.#disposed) return undefined
    try {
      return this.#options.faces().jobs
    } catch (error) {
      this.#options.log(`the background job registry could not be resolved: ${failureText(error)}`)
      return undefined
    }
  }

  /** Subscribe to the registry's event stream once, while any scope is watched. */
  #subscribe(): void {
    if (this.#unsubscribe !== undefined) return
    const face = this.#face()
    if (face === undefined) return
    try {
      // `all` on purpose: the bridge serves every session of this host, and a
      // scope filter here would silently hide another preset's jobs from a
      // phone that is allowed to read them through `list()`.
      this.#unsubscribe = face.events.subscribe({ owners: 'all' }, (event) => { this.#onEvent(event) })
    } catch (error) {
      this.#options.log(`the background job event stream could not be subscribed: ${failureText(error)}`)
    }
  }

  /** Route one registry event to the scopes it can change. */
  #onEvent(event: JobEventLike): void {
    // An output append moves no row. Dropping it here is the reason this channel
    // can never degrade into one frame per byte of job output.
    if (event.type === 'output') return
    const owner = event.job?.owner ?? event.owner
    for (const watch of this.#watches.values()) {
      if (inScope(owner, watch.sessionId)) this.#schedule(watch)
    }
  }

  /** Arm one scope's coalescing window; a burst inside it publishes once. */
  #schedule(watch: ScopeWatch): void {
    if (watch.timer !== undefined) return
    const timer = setTimeout(() => {
      watch.timer = undefined
      this.#publish(watch)
    }, this.#flushMs)
    timer.unref?.()
    watch.timer = timer
  }

  /** Read one scope again and hand its whole set to every watcher. */
  #publish(watch: ScopeWatch): void {
    if (this.#disposed || this.#watches.get(watch.key) !== watch) return
    const payload = this.read(watch.sessionId)
    if (payload === undefined) return
    for (const listener of watch.listeners) listener(payload)
  }

  /** Drop one listener, and its scope with it when it was the last. */
  #unwatch(watch: ScopeWatch, listener: (payload: JobsPayload) => void): void {
    if (this.#watches.get(watch.key) !== watch) return
    watch.listeners.delete(listener)
    if (watch.listeners.size > 0) return
    if (watch.timer !== undefined) clearTimeout(watch.timer)
    watch.timer = undefined
    this.#watches.delete(watch.key)
    if (this.#watches.size > 0) return
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
  }
}
