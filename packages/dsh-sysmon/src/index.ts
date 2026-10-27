/**
 * Host loader entry for the dsh-sysmon plugin — runs in the DSH host process.
 *
 * The host half owns one resident SysmonSampler (a typeperf disk stream plus
 * os CPU/memory on a 1s tick), one passive NetMonitor fed by harness agent
 * events (attempt start → first chunk = TTFT; TIMEOUT/TRANSPORT failures in a
 * 10-minute window), and the read-only GET /api/sysmon/samples route behind
 * the loopback/paired fence. Setting `enabled: false` in the profile patch
 * stops everything and leaves the route unregistered, so the browser chip
 * receives 404 and hides itself.
 * @module dsh-sysmon
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from 'schemastery'
import { mountOnce } from './mount-once.ts'
import { NetMonitor } from './core/net.ts'
import { SysmonSampler } from './host/sampler.ts'
import { observeNet } from './host/net-observe.ts'
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
  /** Network failures in the 10-minute window required to redden the net reading; 0 disables (default 1). */
  netWarnFailures?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  cpuWarnPercent: z.number().step(1).min(0).max(100).default(90),
  memWarnPercent: z.number().step(1).min(0).max(100).default(90),
  diskWarnPercent: z.number().step(1).min(0).max(100).default(90),
  warnStreak: z.number().step(1).min(1).max(60).default(3),
  netWarnFailures: z.number().step(1).min(0).max(600).default(1),
})

/**
 * Dual-face system-metrics plugin: the host half samples every second,
 * passively observes real model requests for the provider-network reading,
 * and serves one fenced read-only route; the browser half renders the chip in
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
    const monitor = new NetMonitor({ warnFailures: cfg.netWarnFailures })
    const stopObserve = observeNet(ctx, monitor)
    const disposeRoute = ctx.webServer.register(makeSamplesRoute(ctx, () => ({ ...sampler.snapshot(), net: monitor.snapshot() })))
    return () => {
      try { disposeRoute() } catch { /* route fiber already gone during shutdown */ }
      stopObserve()
      sampler.stop()
    }
  }, 'dsh-sysmon: sampler + net observer + route')
})
