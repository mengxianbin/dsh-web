/**
 * dsh-task-fsm host entry — mounts the FSM routes on the web server and
 * keeps the machine authority at `~/.dsh/task-fsm-state.json` (§2.6, 回执
 * `state-file-name`). Host-side only at the node level; the browser half is
 * served from lib/client.js. A corrupt state file refuses transitions
 * per-request (route 500, fail-closed) — it never takes the host down
 * (可用性评估 ④: 保护 dsh host 可用性).
 * @module dsh-task-fsm
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from 'schemastery'
import { mountOnce } from './mount-once.ts'
import { resolveDshHome } from './dsh-home.ts'
import { FsmStore, defaultFsmPath } from './host/store.ts'
import { makeTaskFsmRoutes } from './host/routes.ts'
import { ArchiveLeg } from './host/archive-leg.ts'
import {
  DEFAULT_FLOOR_RATIO, DEFAULT_TIME_AXIS_MS, DEFAULT_WATCH_PERIOD_MS,
  MemFloorWatcher,
} from './host/mem-floor-watcher.ts'

export const name = 'dsh-task-fsm'
export const inject = ['webServer']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the FSM routes (default true). */
  enabled?: boolean
  /** G5 redisp circuit-breaker cap (design §6.1 N 建议初值 3, 判据归人). */
  maxRedisp?: number
  /** Memory-floor watcher switch — the §6.4 dual-threshold E7/E4 trigger (freeze-reclaim-phase2-1127, default on). */
  memFloorWatcher?: boolean
  /** Free-memory floor as a ratio of total (default 0.10, 地板值零改 — reported reading only since §6.4). */
  memFloorRatio?: number
  /** Watcher period ms — clamped to ≥30s regardless of config (判据③). */
  memFloorPeriodMs?: number
  /** §6.4 时间轴 ms — a zone must hold before the watcher acts (default 30s, 裁定 #17). */
  memFloorTimeAxisMs?: number
  /** S2 archive execution leg — auto E18 on root done + archive POSTs (default on, fsm-seam-archive-build-1125). */
  archiveLeg?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxRedisp: z.number().default(3),
  memFloorWatcher: z.boolean().default(true),
  memFloorRatio: z.number().default(DEFAULT_FLOOR_RATIO),
  memFloorPeriodMs: z.number().default(DEFAULT_WATCH_PERIOD_MS),
  memFloorTimeAxisMs: z.number().default(DEFAULT_TIME_AXIS_MS),
  archiveLeg: z.boolean().default(true),
})

export const apply = mountOnce('dsh-task-fsm', (ctx: Context, config?: Config): void => {
  const parsed = Config(config)
  if (parsed.enabled === false) return
  ctx.effect(() => {
    const dshHome = resolveDshHome()
    const store = new FsmStore(defaultFsmPath(dshHome))
    // S2 归档执行腿 (fsm-seam-archive-build-1125 §3.2): 事件驱动三触发的 HTTP 半
    // （触发① E18 在 transition 路由内原子补发，触发②③ 走本腿 POST archive；
    // actor = 渠道名 fsm-host、seal 红不 force、失败留痕不回滚）。
    const leg = parsed.archiveLeg === false ? undefined : new ArchiveLeg()
    const routes = makeTaskFsmRoutes({ store, dshHome, maxRedisp: parsed.maxRedisp ?? 3, ...(leg === undefined ? {} : { leg }) })
    const disposers = routes.map((route) => ctx.webServer.register(route))
    // §6.4 双阈值扳机 (freeze-reclaim-phase2-1127): bounded low-frequency
    // watcher; period is clamped ≥30s inside the class, reads are os.freemem-class
    // (zero subprocess) and every anomaly fails open.进场 800M 冻结 / 中带死区 /
    // 唤醒 1600M 放行, each line held ≥30s (memFloorTimeAxisMs) before acting.
    const watcher = parsed.memFloorWatcher === false ? null : new MemFloorWatcher({
      store,
      dshHome,
      maxRedisp: parsed.maxRedisp ?? 3,
      floorRatio: parsed.memFloorRatio,
      periodMs: parsed.memFloorPeriodMs,
      timeAxisMs: parsed.memFloorTimeAxisMs,
    })
    watcher?.start()
    return () => {
      watcher?.stop()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Route fiber already gone during shutdown.
        }
      }
    }
  }, 'dsh-task-fsm: routes')
})
