/**
 * Steering ACK bookkeeping for the session-send route: one structured line
 * per delivered `steer`, pairing the route's delivery timestamp with the
 * model's first response that actually read the steered message. Purely
 * observational — event-driven (the Host's own `session/event` stream, no
 * timers, no polling) and fail-open, so ACK bookkeeping can never affect
 * delivery, and every failure mode degrades to "no line logged".
 * @module dsh-session-dispatch/host/steer-ack
 */

/** Minimum structural shape of a Session event this module narrows at runtime. */
export interface SteerAckEvent {
  readonly type: string
  /** Unix epoch milliseconds. */
  readonly time: number
  readonly data: unknown
}

/** One pending steer awaiting the injection + first-response pair. */
interface PendingSteer {
  readonly sessionId: string
  readonly requestId: string
  readonly deliveredAt: number
  /** Set when the steered message lands in the transcript (its `rpcId` matched). */
  injectedAt?: number
}

/** Sink the send route notifies after a steer delivery is accepted. */
export interface SteerAckSink {
  delivered(sessionId: string, requestId: string, deliveredAt: number): void
}

/** Options for constructing a tracker (both seams exist for tests). */
export interface SteerAckTrackerOptions {
  /** Clock reading; defaults to `Date.now`. */
  readonly now?: () => number
  /** Structured-line sink; defaults to `console.log`. */
  readonly log?: (line: string) => void
  /** Pending-entry cap; defaults to 256, oldest evicted first. */
  readonly maxPending?: number
}

/** One entry of the structured ACK line. */
export interface SteerAckRecord {
  readonly sessionId: string
  readonly requestId: string
  readonly deliveredAt: number
  readonly injectedAt: number
  readonly firstResponseAt: number
  /** Model first-response latency measured from delivery, ms. */
  readonly latencyMs: number
}

const DEFAULT_MAX_PENDING = 256

function epoch(value: number): string {
  return new Date(value).toISOString()
}

/**
 * Pairs each delivered steer with the model's first response that read it.
 *
 * Lifecycle: `delivered()` records the route timestamp; the matching
 * `user/message` (same `rpcId` = the prompt's `requestId`) marks injection at
 * the step boundary; the next `assistant/message` for that Session completes
 * the pair and emits one `[steer-ack]` line. A steer that never reaches the
 * transcript (idle-forever, cancelled) simply ages out at the cap — no line,
 * no timer, no leak beyond the bound.
 */
export class SteerAckTracker implements SteerAckSink {
  private readonly pending = new Map<string, PendingSteer>()
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly maxPending: number

  constructor(options: SteerAckTrackerOptions = {}) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line: string) => { console.log(line) })
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
  }

  /** Record an accepted steer delivery (route side, before the 200 goes out). */
  delivered(sessionId: string, requestId: string, deliveredAt: number): void {
    this.pending.set(requestId, { sessionId, requestId, deliveredAt })
    while (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next()
      if (oldest.done === true) break
      this.pending.delete(oldest.value)
    }
  }

  /**
   * Feed one Host session event. Narrowed defensively: anything unrecognized
   * (or any throw) is ignored — ACK lines are additive observability.
   * @param sessionId - the Session the event belongs to.
   * @param event - structural event shape; narrowed at runtime.
   */
  observe(sessionId: string, event: SteerAckEvent): void {
    try {
      if (event.type === 'user/message') {
        this.onUserMessage(sessionId, event)
        return
      }
      if (event.type === 'assistant/message') {
        this.onAssistantMessage(sessionId, event)
      }
    } catch {
      // Fail-open: bookkeeping never surfaces into the event stream.
    }
  }

  /** Pending count (test/inspection seam). */
  get pendingCount(): number {
    return this.pending.size
  }

  private onUserMessage(sessionId: string, event: SteerAckEvent): void {
    const data = event.data as { readonly source?: { readonly kind?: unknown; readonly rpcId?: unknown } } | undefined
    const source = data?.source
    if (source?.kind !== 'user' || typeof source.rpcId !== 'string') return
    const entry = this.pending.get(source.rpcId)
    if (entry === undefined || entry.sessionId !== sessionId || entry.injectedAt !== undefined) return
    entry.injectedAt = event.time
  }

  private onAssistantMessage(sessionId: string, event: SteerAckEvent): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionId !== sessionId || entry.injectedAt === undefined) continue
      const record: SteerAckRecord = {
        sessionId,
        requestId,
        deliveredAt: entry.deliveredAt,
        injectedAt: entry.injectedAt,
        firstResponseAt: event.time,
        latencyMs: event.time - entry.deliveredAt,
      }
      this.pending.delete(requestId)
      this.log(formatSteerAck(record))
    }
  }
}

/**
 * Render one ACK line in the `[session-stop]` audit-line shape.
 * @param record - the completed delivery→first-response pair.
 * @returns the single-line structured record.
 */
export function formatSteerAck(record: SteerAckRecord): string {
  return `[steer-ack] sessionId=${record.sessionId} requestId=${record.requestId} `
    + `deliveredAt=${epoch(record.deliveredAt)} injectedAt=${epoch(record.injectedAt)} `
    + `firstResponseAt=${epoch(record.firstResponseAt)} latencyMs=${record.latencyMs}`
}
