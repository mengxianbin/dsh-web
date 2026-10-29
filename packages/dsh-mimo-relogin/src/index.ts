/**
 * dsh-mimo-relogin: the MiMo platform re-login kit — a loopback page with
 * silent renewal (passToken → serviceLogin → /sts, proven headless on
 * 2026-10-27), a CDP capture from the chrome-debug window, and a paste
 * fallback, all writing the managed credentials the dsh-usage MiMo adapter
 * probes with. A resident auto-renew loop (L3 self-heal, FORK
 * mimo-relogin-l3) replays the same renewal on a >=24h cadence so a living
 * passToken never needs a human — it pauses on an `interactive` verdict and
 * re-arms after the next successful manual store. Host-only: no `dsh.client`
 * face, nothing in the browser roster, mounted through the bundle patch like
 * dsh-session-dispatch.
 * @module dsh-mimo-relogin
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from 'schemastery'
import { mountOnce } from './mount-once.ts'
import { makeReloginRoutes, type ReloginOptions } from './host/routes.ts'
import { startAutoRenew, type AutoRenewHandle } from './host/auto-renew.ts'

export const name = 'dsh-mimo-relogin'
export const inject = ['webServer']

export interface Config {
  /** Disable the kit entirely (routes stay unregistered). */
  enabled?: boolean
  /** Chrome executable for the cold-start path. */
  chromePath?: string
  /** Dedicated debug profile directory (chrome-debug's by convention). */
  chromeProfile?: string
  /** Debug port; chrome-debug's convention. */
  cdpPort?: number
  /** Platform origin the kit logs in to and probes. */
  platformUrl?: string
  /** Run the resident auto-renew loop (L3 self-heal). */
  autoRenew?: boolean
  /** Hours between automatic renewals; clamped to >= 24 (conservative first version). */
  autoRenewIntervalHours?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  chromePath: z.string().default('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
  chromeProfile: z.string().default('D:\\tech\\m-note\\.local\\chrome-profile'),
  cdpPort: z.number().min(1).max(65_535).default(9224),
  platformUrl: z.string().default('https://platform.xiaomimimo.com/'),
  autoRenew: z.boolean().default(true),
  autoRenewIntervalHours: z.number().min(1).default(24),
})

export interface ResolvedConfig extends ReloginOptions {
  /** Whether the kit is enabled. */
  enabled: boolean
  /** Whether the resident auto-renew loop runs. */
  autoRenew: boolean
  /** Cadence between automatic renewals (ms, clamped to >= 24h). */
  autoRenewIntervalMs: number
}

/** The conservative cadence floor: never renew more than once per 24h. */
const MIN_AUTO_RENEW_INTERVAL_MS = 86_400_000

export function resolveConfig(config?: Config): ResolvedConfig {
  const intervalHours = config?.autoRenewIntervalHours ?? 24
  return {
    enabled: config?.enabled ?? true,
    autoRenew: config?.autoRenew ?? true,
    autoRenewIntervalMs: Math.max(MIN_AUTO_RENEW_INTERVAL_MS, intervalHours * 3_600_000),
    chromePath: config?.chromePath ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    profile: config?.chromeProfile ?? 'D:\\tech\\m-note\\.local\\chrome-profile',
    port: config?.cdpPort ?? 9224,
    platformUrl: config?.platformUrl ?? 'https://platform.xiaomimimo.com/',
  }
}

export const apply = mountOnce('dsh-mimo-relogin', (ctx: Context, config?: Config): void => {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  const { enabled: _enabled, autoRenew: autoRenewOn, autoRenewIntervalMs, ...options } = resolved
  void _enabled
  const autoRenew: AutoRenewHandle | undefined = autoRenewOn
    ? startAutoRenew(ctx, { platformUrl: options.platformUrl, intervalMs: autoRenewIntervalMs })
    : undefined
  const disposers = makeReloginRoutes(ctx, options, { ...(autoRenew === undefined ? {} : { autoRenew }) })
    .map((route) => ctx.webServer.register(route))
  ctx.effect(() => () => {
    autoRenew?.dispose()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Route fiber already gone during shutdown.
      }
    }
  }, 'mimo-relogin: routes')
})
