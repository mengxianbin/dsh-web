/**
 * HTTP surface for dsh-auto-route: one read-only status route behind the
 * family's loopback trust fence. The payload is the controller's policy
 * state — the authority the sidebar "current source" badge reads (the
 * overview's `current{provider,model,source}` is last-request-routing
 * semantics and would flap while both sources run, so it is not consulted).
 * @module dsh-auto-route/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'

/** Route family prefix. */
export const AUTO_ROUTE_API_PREFIX = '/api/auto-route'

/** Status producer (structurally satisfied by the controller). */
export interface AutoRouteStatusProvider {
  /** One plain JSON-able status object (the controller's policy view). */
  status(): object
}

function fenced(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return false
  }
  return true
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
}

/** GET /api/auto-route/status — policy state for the badge and triage. */
export function makeStatusRoute(provider: AutoRouteStatusProvider): WebRoute {
  return {
    kind: 'exact',
    path: `${AUTO_ROUTE_API_PREFIX}/status`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' })
        return
      }
      try {
        const status = provider.status()
        writeJson(res, 200, { ok: true, ...status }, { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

/** All auto-route routes (currently the single status endpoint). */
export function makeAutoRouteRoutes(provider: AutoRouteStatusProvider): WebRoute[] {
  return [makeStatusRoute(provider)]
}
