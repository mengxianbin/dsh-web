/**
 * The active set: sessions the policy is allowed to switch. Two event
 * sources feed it — `session/event` (request headers stamp recency and fold
 * the route a request actually used; a `subagent` origin marks the session
 * as never directly selectable) and `agent/status` (running flag). A session
 * qualifies while it is running or made a request within `activeWindowMs`;
 * entries age out on their own, so cold sessions are never batch-resumed by
 * omission rather than by rule.
 *
 * Each entry also carries the session's last-known route so the reconcile
 * leg (2026-11-01 ruling A) can judge drift without a Host read API: a
 * `model/selection` event records `pending`, a `request/header` event records
 * `used` (retiring a matching pending) — the same `pending ?? used` fold the
 * harness's model-selection projection applies, restricted to
 * `provider/model` (effort is the disclosed manual-lock blind spot and is
 * not reconciled). @module dsh-auto-route/active-set
 */

/** One tracked session's activity. */
export interface ActiveEntry {
  readonly sessionId: string
  readonly running: boolean
  /** Epoch ms of the newest request header seen for this session. */
  readonly lastRequestAt: number
  /** Subagent-owned sessions are excluded from switching (resolveAgent refuses them). */
  readonly subagent: boolean
  /** Recorded `model/selection` route (`provider/model`) not yet used by a request. */
  readonly pending?: string
  /** Route (`provider/model`) the newest request header actually used. */
  readonly used?: string
}

/** Activity view served by the status endpoint (bounded by the caller). */
export interface ActiveEntryView {
  readonly sessionId: string
  readonly running: boolean
  readonly lastRequestAt?: number
  readonly subagent?: boolean
  /** Last-known route (`provider/model`); absent before the first event. */
  readonly selection?: string
}

/** In-memory activity ledger for one Host process. */
export class ActiveSetTracker {
  private readonly entries = new Map<string, ActiveEntry>()

  /**
   * Stamp one session's request recency.
   * @param sessionId - session identity.
   * @param at - epoch ms of the request.
   * @param origin - session header origin; `'subagent'` marks it unselectable.
   * @param usedRoute - `provider/model` the request header actually used; when
   *   it matches a pending selection the pending retires (projection fold).
   */
  recordRequest(sessionId: string, at: number, origin?: string, usedRoute?: string): void {
    const previous = this.entries.get(sessionId)
    const pending = previous?.pending
    // A header without a route keeps the last one it knew.
    const used = usedRoute ?? previous?.used
    this.entries.set(sessionId, {
      sessionId,
      running: previous?.running ?? false,
      // Recency is monotonic per session: a replayed older stamp never rewinds it.
      lastRequestAt: previous === undefined ? at : Math.max(at, previous.lastRequestAt),
      subagent: previous?.subagent === true || origin === 'subagent',
      ...(used === undefined ? {} : { used }),
      // A request that USES the recorded selection retires it; a request on
      // another route leaves it pending (the next request still uses it).
      ...(pending === undefined ? {} : { pending: pending === usedRoute ? undefined : pending }),
    })
  }

  /**
   * Fold one durable `model/selection` event as the session's pending route.
   * @param sessionId - session identity.
   * @param route - `provider/model` selected.
   */
  recordSelection(sessionId: string, route: string): void {
    const previous = this.entries.get(sessionId)
    this.entries.set(sessionId, previous === undefined
      ? { sessionId, running: false, lastRequestAt: 0, subagent: false, pending: route }
      : { ...previous, pending: route })
  }

  /**
   * The route the next request will use (`pending ?? used`), mirroring the
   * harness's model-selection projection restricted to `provider/model`.
   * @param sessionId - session identity.
   * @returns the folded route, or undefined before the first selection or request event.
   */
  effectiveRoute(sessionId: string): string | undefined {
    const entry = this.entries.get(sessionId)
    return entry === undefined ? undefined : entry.pending ?? entry.used
  }

  /**
   * Update one session's running flag.
   * @param sessionId - session identity.
   * @param running - whether its agent is mid-turn.
   */
  recordStatus(sessionId: string, running: boolean): void {
    const previous = this.entries.get(sessionId)
    if (previous === undefined) {
      if (!running) return // A stop for a session we never saw requests for is not activity.
      this.entries.set(sessionId, { sessionId, running: true, lastRequestAt: 0, subagent: false })
      return
    }
    this.entries.set(sessionId, { ...previous, running })
  }

  /**
   * Mark a session as subagent-owned from any event that carries its origin.
   * @param sessionId - session identity.
   */
  markSubagent(sessionId: string): void {
    const previous = this.entries.get(sessionId)
    if (previous === undefined) {
      this.entries.set(sessionId, { sessionId, running: false, lastRequestAt: 0, subagent: true })
      return
    }
    if (!previous.subagent) this.entries.set(sessionId, { ...previous, subagent: true })
  }

  /**
   * The switchable set at one instant.
   * @param now - epoch ms.
   * @param windowMs - request recency that keeps an idle session active.
   * @returns selectable session ids, newest request first.
   */
  snapshot(now: number, windowMs: number): string[] {
    const active: ActiveEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.subagent) continue
      if (entry.running || now - entry.lastRequestAt <= windowMs) active.push(entry)
    }
    return active
      .sort((a, b) => b.lastRequestAt - a.lastRequestAt)
      .map(entry => entry.sessionId)
  }

  /**
   * Bound memory: drop idle entries whose window has lapsed (running and
   * subagent entries are kept — running may resume at any moment, subagent
   * must stay excluded even after its window lapses).
   * @param now - epoch ms.
   * @param windowMs - request recency window.
   */
  prune(now: number, windowMs: number): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.running || entry.subagent) continue
      if (now - entry.lastRequestAt > windowMs) this.entries.delete(sessionId)
    }
  }

  /**
   * Status-endpoint view of everything tracked.
   * @param limit - entry cap (the endpoint bounds its own payload).
   */
  view(limit = 50): ActiveEntryView[] {
    return [...this.entries.values()]
      .sort((a, b) => b.lastRequestAt - a.lastRequestAt)
      .slice(0, limit)
      .map(entry => {
        const selection = entry.pending ?? entry.used
        return {
          sessionId: entry.sessionId,
          running: entry.running,
          ...(entry.lastRequestAt === 0 ? {} : { lastRequestAt: entry.lastRequestAt }),
          ...(entry.subagent ? { subagent: true } : {}),
          ...(selection === undefined ? {} : { selection }),
        }
      })
  }

  /** Entries tracked right now (status payload size hint). */
  get size(): number {
    return this.entries.size
  }
}
