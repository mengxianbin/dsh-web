/**
 * Host loader entry for the dsh-sysmon plugin — runs in the DSH host process.
 *
 * The host half owns one resident SysmonSampler (a typeperf disk stream plus
 * os CPU/memory on a 1s tick) and registers the read-only
 * GET /api/sysmon/samples route behind the loopback/paired fence. Setting
 * `enabled: false` in the profile patch stops the sampler and leaves the
 * route unregistered, so the browser chip receives 404 and hides itself.
 * @module dsh-sysmon
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from 'schemastery'
import { mountOnce } from './mount-once.ts'
import { SysmonSampler } from './host/sampler.ts'
import { makeSamplesRoute } from './host/routes.ts'

export const name = 'dsh-sysmon'
export const inject = ['webServer']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the sampler and the route (default true). */
  enabled?: boolean
  /** CPU busy percent at or above which the chip reddens (default 90). */
  cpuWarnPercent?: number
  /** Memory used percent at or above which the chip reddens (default 90). */
  memWarnPercent?: number
  /** Disk busy percent at or above which the chip reddens (default 90). */
  diskWarnPercent?: number
  /** Consecutive 1s samples at or above threshold required to warn (default 3). */
  warnStreak?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  cpuWarnPercent: z.number().step(1).min(0).max(100).default(90),
  memWarnPercent: z.number().step(1).min(0).max(100).default(90),
  diskWarnPercent: z.number().step(1).min(0).max(100).default(90),
  warnStreak: z.number().step(1).min(1).max(60).default(3),
})

/**
 * Dual-face system-metrics plugin: the host half samples every second and
 * serves one fenced read-only route; the browser half renders the chip in
 * the session header's actions slot. Both halves degrade independently —
 * host off means 404 means the chip hides.
 */
export const apply = mountOnce('dsh-sysmon', (ctx: Context, config?: Config): void => {
  const cfg = Config(config)
  if (cfg.enabled === false) return
  ctx.effect(() => {
    const sampler = new SysmonSampler({
      thresholds: { cpu: cfg.cpuWarnPercent, mem: cfg.memWarnPercent, disk: cfg.diskWarnPercent },
      warnStreak: cfg.warnStreak,
    })
    sampler.start()
    const disposeRoute = ctx.webServer.register(makeSamplesRoute(ctx, () => sampler.snapshot()))
    return () => {
      try { disposeRoute() } catch { /* route fiber already gone during shutdown */ }
      sampler.stop()
    }
  }, 'dsh-sysmon: sampler + route')
})
