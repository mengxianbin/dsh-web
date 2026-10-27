/**
 * dsh-mimo-relogin: the MiMo platform re-login kit — a loopback page with
 * silent renewal (passToken → serviceLogin → /sts, proven headless on
 * 2026-10-27), a CDP capture from the chrome-debug window, and a paste
 * fallback, all writing the managed credentials the dsh-usage MiMo adapter
 * probes with. Host-only: no `dsh.client` face, nothing in the browser
 * roster, mounted through the bundle patch like dsh-session-dispatch.
 * @module dsh-mimo-relogin
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from 'schemastery'
import { mountOnce } from './mount-once.ts'
import { makeReloginRoutes, type ReloginOptions } from './host/routes.ts'

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
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  chromePath: z.string().default('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
  chromeProfile: z.string().default('D:\\tech\\m-note\\.local\\chrome-profile'),
  cdpPort: z.number().min(1).max(65_535).default(9224),
  platformUrl: z.string().default('https://platform.xiaomimimo.com/'),
})

export interface ResolvedConfig extends ReloginOptions {
  /** Whether the kit is enabled. */
  enabled: boolean
}

export function resolveConfig(config?: Config): ResolvedConfig {
  return {
    enabled: config?.enabled ?? true,
    chromePath: config?.chromePath ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    profile: config?.chromeProfile ?? 'D:\\tech\\m-note\\.local\\chrome-profile',
    port: config?.cdpPort ?? 9224,
    platformUrl: config?.platformUrl ?? 'https://platform.xiaomimimo.com/',
  }
}

export const apply = mountOnce('dsh-mimo-relogin', (ctx: Context, config?: Config): void => {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  const { enabled: _enabled, ...options } = resolved
  void _enabled
  const disposers = makeReloginRoutes(ctx, options).map((route) => ctx.webServer.register(route))
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Route fiber already gone during shutdown.
      }
    }
  }, 'mimo-relogin: routes')
})
