/**
 * Same-origin HTTP client for the dsh-task-fsm host routes. One cached
 * lookup per page per session (hover mounts read the cache); an unreachable
 * endpoint or a 404 renders quiet absence (never a banner).
 *
 * Two extra seams serve the frozen-open face (frozen-open-1123):
 * `peekFsmView` is the synchronous cache read the shell's wiring uses when
 * catching up, `refreshFsmView` forces a fresh fetch (the watcher's poll),
 * and `subscribeFsmViews` fires on every RESOLVED success so the publish
 * wiring reacts to freeze transitions. Cache hits do not notify (a hit is
 * not a change); a failed fetch never notifies either — the last known state
 * stays authoritative until a success replaces it (fail-safe: a transient
 * error cannot thaw a frozen takeover).
 *
 * `refreshFsmViewOutcome` is the same forced fetch carrying the HTTP verdict
 * (fsm-poll-404-1124): exactly 404 means the session has no FSM record, which
 * is the watcher's stop-polling signal; 5xx / network / timeout resolve with
 * `notFound: false` so a transient failure never silences a live watcher.
 * @module @linxin666/dsh-task-fsm/client/api
 */

/** Verdict of one forced refresh (the watcher's 404-stop seam). */
export interface FsmRefreshOutcome {
  /** Fresh view on a resolved success; null when absent or unreachable. */
  readonly view: FsmSessionView | null
  /** Exactly HTTP 404 — no FSM record for this session (stop-polling signal). */
  readonly notFound: boolean
}

/** Queue verdict projection served by GET /api/task-fsm/session. */
export interface FsmQueueView {
  tier: 'none' | 'red' | 'yellow'
  reason: string
  label: '红' | '黄' | '不入' | '—' // i18n-allow: type-level mirror of host core/queue.ts design-row terms (runtime copy owned by the host half)
  example: string
}

/** Four-piece hover answers (§4.2). */
export interface FsmSubReasons {
  what: string
  why: string
  who: '人' | 'worker' | 'host' | '—' // i18n-allow: type-level mirror of host-served owner vocabulary (zh-first package, locales fall back to zh)
  next: string
}

/** The hover projection of one session row. */
export interface FsmSessionView {
  taskRef: string
  title?: string
  state: string
  queue: FsmQueueView
  session?: { id: string; mode: 'active' | 'frozen' | 'locked'; reason: string }
  subreasons: FsmSubReasons
  pendingAck: boolean
}

const cache = new Map<string, FsmSessionView | null>()
const inflight = new Map<string, Promise<FsmRefreshOutcome>>()
const subscribers = new Set<(sessionId: string, view: FsmSessionView | null) => void>()

/** Test seam: drop the page cache and every subscriber between cases. */
export function resetFsmLookup(): void {
  cache.clear()
  inflight.clear()
  subscribers.clear()
}

/**
 * Subscribe to every RESOLVED view fetch (first fetch or forced refresh).
 * @param listener - called with the session id and its view (null = no record).
 * @returns the unsubscribe function.
 */
export function subscribeFsmViews(
  listener: (sessionId: string, view: FsmSessionView | null) => void,
): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

function notifyFsmViews(sessionId: string, view: FsmSessionView | null): void {
  // Set iteration is well-defined under mutation: a listener unsubscribed
  // mid-notify is simply not visited again, a newly added one is.
  for (const listener of subscribers) {
    try {
      listener(sessionId, view)
    } catch {
      // One bad listener never blocks the rest (seat-occupant isolation).
    }
  }
}

/**
 * Synchronous cache peek (no fetch, no side effect).
 * @param sessionId - the row's session id.
 * @returns the cached view, null when cached as "no record", undefined when
 *   nothing has been fetched for this session yet.
 */
export function peekFsmView(sessionId: string): FsmSessionView | null | undefined {
  return cache.get(sessionId)
}

/**
 * Session ids currently warm in the page cache — the catch-up seam for
 * wiring that mounted after fetches already resolved (test seams, reloads).
 * @returns the warm session ids.
 */
export function fsmCachedSessionIds(): string[] {
  return [...cache.keys()]
}

async function fetchFsmView(sessionId: string): Promise<FsmRefreshOutcome> {
  try {
    const response = await fetch(`/api/task-fsm/session?id=${encodeURIComponent(sessionId)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (response.ok) {
      const body = await response.json() as { ok?: boolean; found?: boolean; view?: FsmSessionView }
      const view = body.ok === true && body.found === true && body.view !== undefined ? body.view : null
      cache.set(sessionId, view)
      notifyFsmViews(sessionId, view)
      return { view, notFound: false }
    }
    // A non-2xx answer is NOT cached (transient server trouble retries on
    // the next lookup) and does NOT notify (last known state stays). Exactly
    // 404 = the session is not in the FSM store (the host's only 404 for
    // this route); every other status stays fail-open: it never claims
    // "no record", so a 5xx can never stop the watcher's poll.
    return { view: null, notFound: response.status === 404 }
  } catch {
    // Network failure / timeout: fail-open (notFound stays false — keep the
    // cadence) while caching the quiet absence for hover lookups.
    cache.set(sessionId, null)
    return { view: null, notFound: false }
  } finally {
    inflight.delete(sessionId)
  }
}

/**
 * Look up one session's FSM view (cached per page).
 * @param sessionId - the row's session id.
 * @returns the view, or null when absent/unreachable (quiet absence).
 */
export function lookupFsmView(sessionId: string): Promise<FsmSessionView | null> {
  const hit = cache.get(sessionId)
  if (hit !== undefined) return Promise.resolve(hit)
  const pending = inflight.get(sessionId)
  if (pending !== undefined) return pending.then((outcome) => outcome.view)
  const request = fetchFsmView(sessionId)
  inflight.set(sessionId, request)
  return request.then((outcome) => outcome.view)
}

/**
 * Force a fresh fetch that bypasses the page cache (the frozen-open
 * watcher's poll and any explicit invalidation); shares an in-flight
 * request instead of stacking duplicates. Subscribers are notified on the
 * resolved success only — see the module header's fail-safe note.
 * @param sessionId - the row's session id.
 * @returns the freshly fetched view, or null when absent/unreachable.
 */
export function refreshFsmView(sessionId: string): Promise<FsmSessionView | null> {
  return refreshFsmViewOutcome(sessionId).then((outcome) => outcome.view)
}

/**
 * Force a fresh fetch and carry the HTTP verdict alongside the view — the
 * frozen watcher's poll seam (fsm-poll-404-1124). Same fetch, cache and
 * in-flight sharing as {@link refreshFsmView}; only the 404 distinction is
 * added so the caller can stop polling a session with no FSM record while
 * every other failure keeps the cadence (fail-open).
 * @param sessionId - the row's session id.
 * @returns the fresh view plus the exact-404 stop-polling signal.
 */
export function refreshFsmViewOutcome(sessionId: string): Promise<FsmRefreshOutcome> {
  const pending = inflight.get(sessionId)
  if (pending !== undefined) return pending
  const request = fetchFsmView(sessionId)
  inflight.set(sessionId, request)
  return request
}
