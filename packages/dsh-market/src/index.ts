/**
 * Host half of the dsh-market card: mounts the loopback install gateway. The
 * card's enable switch is this plugin's own `Config` (the Host auto-generates
 * the settings page for the profile entry from that schema), so this half
 * owns no settings registration: the browser half reads the effective switch
 * off the entry's configuration form. The catalog data itself is served by
 * dsh-market.com and ingested by the browser half — this half only owns the
 * asset writer.
 * @module @linxin666/dsh-client-ui-market
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { mountOnce } from './mount-once.ts'
import { makeMarketRoutes } from './routes.ts'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'ui-market'

/** Services the routes need; the gateway requires the host webserver. */
export const inject = ['webServer']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the market card. */
  enabled?: boolean
  /** Per-attempt download timeout in seconds, 30-600. */
  installTimeoutSec?: number
  /** Extra attempts per install request after the first, 0-4. */
  installRetries?: number
}

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  // The published manifest alone is ~190 KiB and can take a minute on a slow
  // link, so the old hard-coded 30 s made a healthy install look like a hang.
  // Both knobs are operator settings rather than constants (issue #1941).
  installTimeoutSec: z.number().min(30).max(600).default(120).volatile(),
  installRetries: z.number().min(0).max(4).default(2).volatile(),
})

/** The effective install network policy derived from the row config. */
interface InstallPolicy {
  /** Per-attempt timeout in ms. */
  timeoutMs: number
  /** Extra attempts after the first. */
  retries: number
}

/**
 * Read one volatile config field, following the live reference the schema
 * produces (a settings save commits in place and does not remount the row).
 */
function readConfigNumber(field: unknown, fallback: number): number {
  const live = typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function'
    ? (field as { get(): unknown }).get()
    : field
  return typeof live === 'number' && Number.isFinite(live) ? live : fallback
}

/** Mount the install gateway (once). */
export const apply = mountOnce('@linxin666/dsh-client-ui-market', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  // Resolved per request, not at mount time: a settings save must reach the
  // next install without remounting the routes.
  const installPolicy = (): InstallPolicy => ({
    timeoutMs: readConfigNumber(config?.installTimeoutSec, 120) * 1000,
    retries: readConfigNumber(config?.installRetries, 2),
  })
  const routes = makeMarketRoutes({ installPolicy })
  for (const route of routes) {
    try {
      ctx.effect(() => {
        const dispose = ctx.webServer.register(route)
        return () => { dispose() }
      }, 'dsh-web-ui-market: routes')
    } catch {
      /* keep the browser card mounted without the gateway */
    }
  }
}

export { installAsset, planDownload, isSafeRel, MARKET_ORIGIN, PROVENANCE_FILENAME } from './core/installer.ts'
export type { DownloadPlanEntry, InstallProvenance, InstallResult, MarketKind } from './core/installer.ts'
export { makeMarketRoutes, MARKET_API_PREFIX } from './routes.ts'
