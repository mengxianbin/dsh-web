/**
 * Host loader entry for the dsh-sysmon plugin — runs in the DSH host process.
 *
 * The host half owns one resident SysmonSampler (a typeperf disk stream plus
 * os CPU/memory on a 1s tick), one NetMonitor whose latency half comes from a
 * low-frequency active ICMP probe (A-case, 2026-10-28: one `ping` round trip
 * per minute to a fixed domestic reference target, `netProbeTarget`) and
 * whose failure half stays purely passive (TIMEOUT/TRANSPORT request errors
 * in a 10-minute window), and the read-only GET /api/sysmon/samples route
 * behind the loopback/paired fence. Setting `enabled: false` in the profile
 * patch stops everything and leaves the route unregistered, so the browser
 * chip receives 404 and hides itself.
 * @module dsh-sysmon
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from 'schemastery'
import { mountOnce } from './mount-once.ts'
import { NetMonitor } from './core/net.ts'
import { SysmonSampler } from './host/sampler.ts'
import { observeNet } from './host/net-observe.ts'
import { startPingProbe } from './host/ping-probe.ts'
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
  /**
   * Fixed ICMP probe target for the network reading (default
   * `api.deepseek.com` — a domestic reference with a stable route, matching
   * the 2026-10-28 A-case ruling). Empty string disables probing: the rtt
   * half reads `—`, failures keep counting.
   */
  netProbeTarget?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  cpuWarnPercent: z.number().step(1).min(0).max(100).default(90),
  memWarnPercent: z.number().step(1).min(0).max(100).default(90),
  diskWarnPercent: z.number().step(1).min(0).max(100).default(90),
  warnStreak: z.number().step(1).min(1).max(60).default(3),
  netWarnFailures: z.number().step(1).min(0).max(600).default(1),
  netProbeTarget: z.string().default('api.deepseek.com'),
})

/**
 * Dual-face system-metrics plugin: the host half samples every second, runs
 * the low-frequency ICMP network probe (A-case latency half) beside the
 * passive request-failure observer, and serves one fenced read-only route;
 * the browser half renders the chip in the session header's actions slot.
 * Both halves degrade independently — host off means 404 means the chip
 * hides.
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
    // The schema default fills an absent key at runtime; the declared Config
    // type keeps it optional, so narrow explicitly (absent = enabled here).
    const probeTarget = cfg.netProbeTarget == null || cfg.netProbeTarget === '' ? null : cfg.netProbeTarget
    const monitor = new NetMonitor({ warnFailures: cfg.netWarnFailures, probe: probeTarget })
    const stopObserve = observeNet(ctx, monitor)
    const stopProbe = probeTarget === null
      ? () => { /* probing disabled: the rtt half stays null, failures still count */ }
      : startPingProbe({ target: probeTarget, onResult: (ms) => monitor.noteRtt(ms) })
    const disposeRoute = ctx.webServer.register(makeSamplesRoute(ctx, () => ({ ...sampler.snapshot(), net: monitor.snapshot() })))
    return () => {
      try { disposeRoute() } catch { /* route fiber already gone during shutdown */ }
      stopProbe()
      stopObserve()
      sampler.stop()
    }
  }, 'dsh-sysmon: sampler + net probe/observer + route')
})
