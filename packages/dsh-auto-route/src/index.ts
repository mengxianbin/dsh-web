/** dsh-auto-route: host-side auto source routing (opencode-go ↔ mimo). */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import { Config, resolveConfig } from './config.ts'
import { mountOnce } from './mount-once.ts'
import { ActiveSetTracker } from './active-set.ts'
import { AutoRouteController, type CatalogApi, type DefaultModelApi, type SwitchApi } from './controller.ts'
import { fetchGoMeters } from './meters.ts'
import { makeStatusRoute } from './host/routes.ts'

export { Config } from './config.ts'
export type { Config as AutoRouteConfig } from './config.ts'
export { AutoRouteController } from './controller.ts'
export { ActiveSetTracker } from './active-set.ts'
export { decide, initialPolicyState, type PolicyState } from './policy.ts'
export { fetchGoMeters, type MeterReading } from './meters.ts'

export const name = 'dsh-auto-route'
export const inject = ['webServer', 'sessionController']

/**
 * Auto source routing controller (2026-10-24 ruling, form 乙; parameters
 * revised 2026-10-27): polls the Go meters on a 30–60 s cadence with two
 * up-edges and one shared down-edge — any window `>= 0.95` moves only the
 * global default model (new/rotated sessions born on MiMo), any window
 * `>= 0.99` additionally batch-switches the active session set (running ∪
 * requested within 30 min), and all three windows `< 0.95` bring both back to
 * opencode-go. The policy state is served read-only at loopback-fenced
 * `GET /api/auto-route/status` — the authority for the sidebar's current-
 * source badge. The balance guardrail stays disabled per the 2026-10-27
 * ruling (no cash gate — burn to balance). Host-only package: no `dsh.client`
 * face, nothing in the browser roster.
 */
export const apply = mountOnce('dsh-auto-route', (ctx: Context, config?: Config): void => {
  if (Config(config).enabled === false) return
  const resolved = resolveConfig(Config(config), (raw, clamped) => {
    ctx.logger.warn(`dsh-auto-route: pollIntervalMs ${raw} is outside the30–60 s ruling range; clamped to ${clamped}`)
  })
  ctx.effect(() => {
    const tracker = new ActiveSetTracker()
    // request headers stamp recency; a subagent origin marks the session as
    // never directly selectable (resolveAgent refuses child sessions).
    const offRequest = ctx.on('session/event', (session, event) => {
      const origin = session.header.origin
      if (origin === 'subagent') tracker.markSubagent(String(session.id))
      if (event.type === 'request/header' && typeof event.time === 'number') {
        tracker.recordRequest(String(session.id), event.time, origin)
      }
    })
    const offStatus = ctx.on('agent/status', (payload) => {
      tracker.recordStatus(String(payload.agent.id), payload.status === 'running')
    })
    const logger = {
      info: (message: string) => { ctx.logger.info(message) },
      warn: (message: string) => { ctx.logger.warn(message) },
      error: (message: string) => { ctx.logger.error(message) },
    }
    const defaultModel = ctx.get('agentDefaultModel') as unknown as DefaultModelApi | undefined
    const controller = new AutoRouteController({
      config: resolved,
      tracker,
      logger,
      // The key is read from the named env var into process memory only and
      // never logged, persisted, or echoed into the status payload.
      meters: () => fetchGoMeters({
        url: resolved.meterUrl,
        key: process.env[resolved.meterKeyEnv],
        meterKeyEnv: resolved.meterKeyEnv,
      }),
      sessions: ctx.sessionController as unknown as SwitchApi,
      catalog: ctx.sessionController as unknown as CatalogApi,
      ...(defaultModel === undefined ? {} : { defaultModel }),
    })
    controller.start()
    const disposeRoute = ctx.webServer.register(makeStatusRoute(controller))
    return () => {
      controller.stop()
      try { offRequest() } catch { /* listener already gone during shutdown */ }
      try { offStatus() } catch { /* listener already gone during shutdown */ }
      try { disposeRoute() } catch { /* route fiber already gone during shutdown */ }
    }
  }, 'dsh-auto-route: policy controller')
})
