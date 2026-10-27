/**
 * HTTP routes for dsh-sysmon. One read-only route, fenced like dsh-usage's
 * overview: loopback always passes, and a live remote-web-ui paired-device
 * cookie passes too so the chip can render on a paired remote browser;
 * every unpaired LAN/tunnel request gets 403.
 * @module dsh-sysmon/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SysmonNet } from '../core/types.ts'
import { writeJson } from './http.ts'
import { isPairedOrLoopbackAllowed } from './pair-access.ts'
import type { SamplerSnapshot } from './sampler.ts'

export const SYSMON_API_PREFIX = '/api/sysmon'

/** What the route serves: the system sampler's snapshot plus the v4 network reading. */
export interface SamplesSnapshot extends SamplerSnapshot {
  net: SysmonNet
}

/**
 * `GET /api/sysmon/samples` — the newest sample, sustained warn flags, the
 * thresholds in force, the v4 provider-network reading, and (only when asked
 * with `?history=1`) the full ring.
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param snapshot - reads the live sampler + net monitor state at request time.
 * @returns the route.
 */
export function makeSamplesRoute(ctx: Context, snapshot: () => SamplesSnapshot): WebRoute {
  return {
    kind: 'exact',
    path: SYSMON_API_PREFIX + '/samples',
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!isPairedOrLoopbackAllowed(ctx, req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      const url = new URL(req.url ?? SYSMON_API_PREFIX, 'http://localhost')
      const wantHistory = url.searchParams.get('history') === '1'
      const snap = snapshot()
      writeJson(res, 200, {
        ok: true,
        at: Date.now(),
        latest: snap.latest,
        warn: snap.warn,
        thresholds: snap.thresholds,
        net: snap.net,
        ...(wantHistory ? { history: snap.history } : {}),
      }, { 'cache-control': 'no-store' })
    },
  }
}
