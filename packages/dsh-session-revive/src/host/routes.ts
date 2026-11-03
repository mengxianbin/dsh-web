/**
 * HTTP surface for dsh-session-revive: one loopback-fenced status endpoint
 * that reports mode, counters, and the bounded policy snapshot. It exists for
 * post-restart verification and morning-report evidence gathering; it never
 * mutates anything.
 * @module dsh-session-revive/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'

export const REVIVE_API_PREFIX = '/api/session-revive'

/** Tunnels and LAN clients get 403: the status payload exposes session ids. */
function fenced(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return false
  }
  return true
}

/**
 * GET /api/session-revive/status — `{ ok, service, mode, ...snapshot }`.
 * @param getStatus - fresh payload builder (mode echo + policy snapshot).
 * @returns the exact route for the host webserver registry.
 */
export function makeStatusRoute(getStatus: () => Record<string, unknown>): WebRoute {
  return {
    kind: 'exact',
    path: `${REVIVE_API_PREFIX}/status`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' })
        return
      }
      writeJson(res, 200, { ok: true, service: 'dsh-session-revive', ...getStatus() }, { 'cache-control': 'no-store' })
    },
  }
}
