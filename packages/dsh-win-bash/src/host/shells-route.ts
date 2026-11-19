/**
 * GET /api/win-bash/shells — read-only introspection of the shells this
 * plugin holds, for the reaper/duty faces that need to tie a live OS process
 * to the session owning it.
 *
 * Response contract (fixed by the dispatch):200 body is
 * `{ ok: true, hostPid, shells: [{ sessionId, shellPid, born, exited }] }`,
 * where hostPid is this host process (the reaper's parent anchor), sessionId
 * is the owner's session id in canonical form (null when unreadable),
 * shellPid is the shell's three-piece tree root (-1 when the ledger did not
 * deliver a live one), born is the record's epoch-ms construction instant and
 * exited reports whether the outcome settled. The handler is read-only: one
 * snapshot pass, zero writes, zero spawns.
 *
 * Fence order is fixed too: non-loopback → 403, non-GET → 405, then the
 * snapshot. The loopback fence and the JSON writer ride inline rather than as
 * scripts/sync-shared.mjs copies because this package is not a manifest
 * member and the dispatch's expected file set keeps this route self-contained;
 * both blocks are verbatim copies of shared/host/loopback.ts and
 * shared/host/http.ts — edit those sources and re-copy if their semantics
 * change (deviation recorded in the closeout note).
 * @module @linxin666/dsh-win-bash/shells-route
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellRegistry } from '../shell.ts'

/* --- verbatim copy of shared/host/loopback.ts (fence) --- */

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers. The socket address is
 * authoritative; X-Forwarded-For is never trusted.
 */
function isLoopbackRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/* --- verbatim copy of shared/host/http.ts (JSON writer) --- */

/** Family-default JSON response headers; callers may append or override. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
} satisfies OutgoingHttpHeaders

/**
 * Write one JSON response. Default headers are the family defaults
 * (content-type and referrer-policy); caller headers are appended or
 * override them.
 */
function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(payload)
}

/* --- the route --- */

/** Path of the introspection endpoint. */
export const SHELLS_PATH = '/api/win-bash/shells'

/** The route shape the web server registers: an exact-path GET handler. */
export interface ShellsRoute {
  /** Exact-path match. */
  readonly kind: 'exact'
  /** The endpoint path. */
  readonly path: string
  /** Fence → method → one read-only snapshot. */
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void
}

/**
 * Build the endpoint over a live registry.
 * @param shells - the registry whose snapshot the response reports.
 * @returns the route object.
 */
export function makeShellsRoute(shells: ShellRegistry): ShellsRoute {
  return {
    kind: 'exact',
    path: SHELLS_PATH,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' })
        return
      }
      writeJson(res, 200, { ok: true, hostPid: process.pid, shells: shells.snapshot() }, { 'cache-control': 'no-store' })
    },
  }
}

/**
 * Register the endpoint when the host exposes a web server.
 *
 * Soft read by contract: `ctx.get('webServer')` is undefined on a host
 * without the web face, and that host must mount exactly as it did before —
 * no hard inject, no new mount-failure surface. Registration rides its own
 * effect so plugin unload disposes the route with everything else.
 * @param ctx - the plugin context carrying the (possibly absent) web server.
 * @param shells - the registry the endpoint reports.
 */
export function registerShellsIntrospection(ctx: Context, shells: ShellRegistry): void {
  const webserver = ctx.get('webServer') as { register?: (route: ShellsRoute) => () => void } | undefined
  if (webserver === undefined || typeof webserver.register !== 'function') return
  const dispose = webserver.register(makeShellsRoute(shells))
  ctx.effect(() => () => {
    try {
      dispose()
    } catch {
      // Route fiber already gone during shutdown.
    }
  }, 'dsh-win-bash: shells introspection route')
}
