/**
 * Session-origin class lookup for the hover card's session-type line
 * (hover-sessionclass-1121). One lazy GET of the dispatch plugin's read-only
 * attention endpoint, cached for the page's lifetime: the first hover mount
 * triggers the fetch, every later hover reuses the resolved map, and an
 * unreachable endpoint settles the cache as absent — no retry loop, no
 * polling, no error surface (quiet absence by design).
 * @module @linxin666/dsh-session-archive/client/session-class
 */

/** The triclass the attention ledger holds; these spellings render verbatim. */
export type SessionOriginClass = 'human' | 'bot-boss' | 'bot-worker'

/** Loopback-fenced read endpoint the dispatch plugin serves (GET only). */
const ENDPOINT = '/api/session-dispatch/attention'

/** Canonical id rule mirrored from the dispatch plugin's canonicalSessionId. */
function canonicalId(sessionId: string): string {
  return sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`
}

/** Narrow one wire value to the triclass; anything else renders nothing. */
function toOriginClass(value: unknown): SessionOriginClass | undefined {
  return value === 'human' || value === 'bot-boss' || value === 'bot-worker' ? value : undefined
}

/** One lookup face: undefined means "no line" (quiet absence, never an error). */
export interface SessionClassLookup {
  lookup(sessionId: string): Promise<SessionOriginClass | undefined>
}

/**
 * Build a lookup over one fetch implementation. The first call issues the
 * request; its outcome — success or failure — is kept as the settled answer
 * for the instance's lifetime, so a failing endpoint is never re-hit (zero
 * periodic reads) while a successful map serves every later hover.
 * @param fetchPage - issues the endpoint request (test seam for stubbing).
 * @returns the lookup face.
 */
export function createSessionClassLookup(fetchPage: () => Promise<Response>): SessionClassLookup {
  let map: Record<string, SessionOriginClass> | undefined
  let pending: Promise<Record<string, SessionOriginClass> | undefined> | undefined
  const load = (): Promise<Record<string, SessionOriginClass> | undefined> => {
    if (map !== undefined) return Promise.resolve(map)
    if (pending !== undefined) return pending
    pending = (async () => {
      try {
        const response = await fetchPage()
        if (!response.ok) return undefined
        const body = await response.json() as { ok?: unknown; classes?: unknown }
        if (body?.ok !== true || typeof body.classes !== 'object' || body.classes === null) return undefined
        const parsed: Record<string, SessionOriginClass> = {}
        for (const [id, value] of Object.entries(body.classes as Record<string, unknown>)) {
          const sessionClass = toOriginClass(value)
          if (id !== '' && sessionClass !== undefined) parsed[id] = sessionClass
        }
        map = parsed
        return parsed
      } catch {
        // Unreachable / failed read: settle as absent. The resolved promise
        // stays in place, so the failure never retried itself into a loop.
        return undefined
      }
    })()
    return pending
  }
  return {
    async lookup(sessionId) {
      const classes = await load()
      if (classes === undefined) return undefined
      // Ledger keys are canonical; a workspace may list the bare spelling, so
      // both spellings answer (mirrors the endpoint's key passthrough).
      return classes[sessionId] ?? classes[canonicalId(sessionId)]
    },
  }
}

/** Page-lifetime singleton: the fetch resolves against the live global lazily. */
let active = createSessionClassLookup(() => globalThis.fetch(ENDPOINT))

/** Resolve through the page-lifetime singleton (the hover line's only reader). */
export function lookupSessionClass(sessionId: string): Promise<SessionOriginClass | undefined> {
  return active.lookup(sessionId)
}

/** Test seam: drop the singleton so the next lookup re-fetches (stubbed global fetch). */
export function resetSessionClassLookup(): void {
  active = createSessionClassLookup(() => globalThis.fetch(ENDPOINT))
}
