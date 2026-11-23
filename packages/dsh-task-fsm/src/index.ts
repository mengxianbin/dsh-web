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

export const name = 'dsh-task-fsm'
export const inject = ['webServer']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the FSM routes (default true). */
  enabled?: boolean
  /** G5 redisp circuit-breaker cap (design §6.1 N 建议初值 3, 判据归人). */
  maxRedisp?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxRedisp: z.number().default(3),
})

export const apply = mountOnce('dsh-task-fsm', (ctx: Context, config?: Config): void => {
  const parsed = Config(config)
  if (parsed.enabled === false) return
  ctx.effect(() => {
    const dshHome = resolveDshHome()
    const store = new FsmStore(defaultFsmPath(dshHome))
    const routes = makeTaskFsmRoutes({ store, dshHome, maxRedisp: parsed.maxRedisp ?? 3 })
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
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
