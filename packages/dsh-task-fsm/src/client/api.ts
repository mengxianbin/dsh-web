/**
 * Same-origin HTTP client for the dsh-task-fsm host routes. One cached
 * lookup per page per session (zero polling — hover mounts read the cache);
 * an unreachable endpoint or a 404 renders quiet absence (never a banner).
 * @module @linxin666/dsh-task-fsm/client/api
 */

/** Queue verdict projection served by GET /api/task-fsm/session. */
export interface FsmQueueView {
  tier: 'none' | 'red' | 'yellow'
  reason: string
  label: '红' | '黄' | '不入' | '—'
  example: string
}

/** Four-piece hover answers (§4.2). */
export interface FsmSubReasons {
  what: string
  why: string
  who: '人' | 'worker' | 'host' | '—'
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
const inflight = new Map<string, Promise<FsmSessionView | null>>()

/** Test seam: drop the page cache between cases. */
export function resetFsmLookup(): void {
  cache.clear()
  inflight.clear()
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
  if (pending !== undefined) return pending
  const request = (async (): Promise<FsmSessionView | null> => {
    try {
      const response = await fetch(`/api/task-fsm/session?id=${encodeURIComponent(sessionId)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return null
      const body = await response.json() as { ok?: boolean; found?: boolean; view?: FsmSessionView }
      const view = body.ok === true && body.found === true && body.view !== undefined ? body.view : null
      cache.set(sessionId, view)
      return view
    } catch {
      cache.set(sessionId, null)
      return null
    } finally {
      inflight.delete(sessionId)
    }
  })()
  inflight.set(sessionId, request)
  return request
}
