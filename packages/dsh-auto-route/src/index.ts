/** dsh-auto-route: host-side auto source routing (opencode-go ↔ mimo). */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import { Config, resolveConfig } from './config.ts'
import { mountOnce } from './mount-once.ts'
import { ActiveSetTracker, LiveAgentSet } from './active-set.ts'
import { AutoRouteController, type CatalogApi, type DefaultModelApi, type SwitchApi } from './controller.ts'
import { fetchGoMeters } from './meters.ts'
import { makeStatusRoute } from './host/routes.ts'
import { FileLockStore } from './lock-store.ts'
import { dshHome } from './dsh-home.ts'
import { removePollState, writePollState } from './poll-state.ts'

export { Config } from './config.ts'
export type { Config as AutoRouteConfig } from './config.ts'
export { AutoRouteController } from './controller.ts'
export { ActiveSetTracker } from './active-set.ts'
export { decide, initialPolicyState, type PolicyState } from './policy.ts'
export { fetchGoMeters, type MeterReading } from './meters.ts'
export { FileLockStore } from './lock-store.ts'
export type { LockStore } from './lock-store.ts'
export { POLL_STATE_FILE, removePollState, writePollState, type PollStateSnapshot } from './poll-state.ts'
export type { ReconcileRecord, TargetProblem } from './controller.ts'

export const name = 'dsh-auto-route'
// `workspaceRegistry` joins the inject list for the leg-2 archive filter
// (2026-11-09 lightwatch ruling): session-controller itself injects it, so a
// host that can mount `sessionController` always provides it — fail-closed on
// the guardrail rather than silently sweeping archived sessions.
export const inject = ['webServer', 'sessionController', 'workspaceRegistry']

/**
 * Extract `provider/model` from a `request/header` event's payload; the
 * header names the route the request will use, which is the fold's `used`
 * observation. Absent when the payload is not the expected shape.
 */
function routeOfRequestHeader(event: unknown): string | undefined {
  const data = (event as { data?: { header?: { config?: { provider?: unknown; model?: unknown } } } }).data
  const config = data?.header?.config
  if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') return undefined
  return `${config.provider}/${config.model}`
}

/**
 * Minimal face of a created/ resumed agent for the lightwatch legs. The
 * compile face (published `@deepseek-ai/dsh-agent` 0.1.2-rc.1) predates both
 * the `model` fold reader and the `agent/created` `source` field that the
 * RUNNING harness (workspace `0.2.2-alpha.2`) carries — both are read through
 * this structural shape, so the listener stays typed without pinning the
 * stale published surface.
 */
interface OpenedAgentFace {
  id: string
  model?: { current?(): { readonly provider: string; readonly model: string } | undefined }
  session?: { header?: { origin?: unknown } }
}

/** `agent/created` payload as the lightwatch listener reads it. */
interface OpenedCreatedPayload {
  agent: OpenedAgentFace
  /** `SessionStartSource` on the RUNNING harness; absent on the compile face. */
  source?: string
}

/** Read face of the workspace registry's archive list (leg-2 filter). */
interface ArchivedRegistryFace {
  archivedSessionIds?: readonly string[]
}

/**
 * Auto source routing controller (2026-10-24 ruling, form 乙; parameters
 * revised 2026-10-27): polls the Go meters on a 30–60 s cadence with two
 * up-edges and one shared down-edge — any window `>= 0.95` moves only the
 * global default model (new/rotated sessions born on MiMo), any window
 * `>= 0.99` additionally batch-switches the active session set (running ∪
 * requested within 30 min), and all three windows `< 0.95` bring both back to
 * opencode-go. The policy state is served read-only at loopback-fenced
 * `GET /api/auto-route/status` — the authority for the sidebar's current-
 * source badge. Manual overrides (2026-10-27 A ruling 人工锁定优先): a human
 * model switch locks that session, both edges skip it until its selection
 * realigns — health-class rescues (tool-call failures / model instability)
 * stay human-only by scope; lock entries persist to
 * `<dsh-home>/auto-route-locks.json` (2026-11-01 ruling A 锁持久化) so a
 * restart cannot drag a parked session back. Every successful hold poll also
 * runs the steady-state reconcile leg (2026-11-01 ruling A 稳态对账,
 * `reconcile: false` opts out): active sessions observed off the live target
 * are pulled back (locks and unknown folds skipped) and a deployment default
 * drifted by the harness's selectModel side effect is restored — the
 * post-edge drift the one-shot edges could never see. The balance guardrail
 * stays disabled per the 2026-10-27 ruling (no cash gate — burn to balance).
 * Host-only package: no `dsh.client` face, nothing in the browser roster.
 */
export const apply = mountOnce('dsh-auto-route', (ctx: Context, config?: Config): void => {
  if (Config(config).enabled === false) {
    // Disabled = the plane must read as absent, never as a stale ledger the
    // shield could mistake for a dead controller (2026-11-04 ruling).
    removePollState()
    return
  }
  const resolved = resolveConfig(Config(config), (raw, clamped) => {
    ctx.logger.warn(`dsh-auto-route: pollIntervalMs ${raw} is outside the30–60 s ruling range; clamped to ${clamped}`)
  })
  ctx.effect(() => {
    const tracker = new ActiveSetTracker()
    // Leg-2 sweep surface (2026-11-09 lightwatch ruling): live Agents, fed
    // only by the agent/created + agent/disposed pair below.
    const live = new LiveAgentSet()
    // Archive filter judged at READ: a session can be archived or unarchived
    // while its agent stays open, and unreadable registry state fails toward
    // exclusion (the active-set-only surface is the safe degradation — never
    // sweep a session we cannot vouch for).
    const registry = (ctx as Context & { workspaceRegistry?: ArchivedRegistryFace }).workspaceRegistry
    const isArchived = (sessionId: string): boolean => {
      try {
        return registry?.archivedSessionIds?.includes(sessionId) ?? true
      } catch {
        return true
      }
    }
    const logger = {
      info: (message: string) => { ctx.logger.info(message) },
      warn: (message: string) => { ctx.logger.warn(message) },
      error: (message: string) => { ctx.logger.error(message) },
    }
    // request headers stamp recency AND fold the route the request uses (the
    // reconcile leg's `used` observation); a subagent origin marks the session
    // as never directly selectable (resolveAgent refuses child sessions).
    const offRequest = ctx.on('session/event', (session, event) => {
      const origin = session.header.origin
      if (origin === 'subagent') tracker.markSubagent(String(session.id))
      if (event.type === 'request/header' && typeof event.time === 'number') {
        tracker.recordRequest(String(session.id), event.time, origin, routeOfRequestHeader(event))
      }
    })
    const offStatus = ctx.on('agent/status', (payload) => {
      tracker.recordStatus(String(payload.agent.id), payload.status === 'running')
    })
    const defaultModel = ctx.get('agentDefaultModel') as unknown as DefaultModelApi | undefined
    // Lock entries persist (ruling A); the file lives beside the other
    // dsh-home ledgers and fails open — a corrupt file warns and starts cold.
    const lockStore = new FileLockStore(join(dshHome(), 'auto-route-locks.json'), logger)
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
      lockStore,
      // Per-tick poll verdict → `<dsh-home>/auto-route-poll-state.json`
      // (2026-11-04 ruling: the 安康盾 sustained-failure plane reads it).
      onPoll: writePollState,
      // Leg 2 (2026-11-09 lightwatch ruling): edges sweep active ∪ live;
      // subagent children never join `live` and archived ids are filtered
      // here, so the controller only ever sees sweepable sessions.
      liveSessions: () => live.list(isArchived),
      ...(defaultModel === undefined ? {} : { defaultModel }),
    })
    // Durable model/selection events classify auto vs human (A case: a human
    // touch locks the session — both edges skip it until realigned) AND fold
    // the session's pending route for the reconcile leg. The shared
    // selectModel channel carries no origin metadata, so the controller
    // judges by expectation + ledger + live-target comparison.
    const offSelection = ctx.on('session/event', (session, event) => {
      if (event.type !== 'model/selection') return
      const data = (event as unknown as { data?: unknown }).data
      if (data === null || typeof data !== 'object') return
      const { provider, model } = data as { provider?: unknown; model?: unknown }
      if (typeof provider !== 'string' || typeof model !== 'string') return
      tracker.recordSelection(String(session.id), `${provider}/${model}`)
      controller.onSelectionEvent(String(session.id), { provider, model })
    })
    // Leg 1 + live-set feed (2026-11-09 lightwatch ruling, 打开即对齐): an
    // opened session arrives as `agent/created` with `source: 'resume'`
    // (RUNTIME payload — harness `runtime-types.ts` SessionStartSource; the
    // published compile face predates the field, read through the face
    // above). The Agent is provably alive, so the fold reads through
    // `agent.model.current()` and the align writes through selectModel with
    // ZERO resume. Every created agent also joins the leg-2 sweep surface —
    // subagent children refused at add (`resolveAgent` refuses child
    // sessions, the same origin channel `session/event` uses); archived
    // sessions filtered at read via `isArchived`.
    const offAgentCreated = ctx.on('agent/created', (payload: OpenedCreatedPayload) => {
      const sessionId = String(payload.agent.id)
      const subagent = payload.agent.session?.header?.origin === 'subagent'
      live.add(sessionId, { subagent })
      if (payload.source !== 'resume' || subagent || isArchived(sessionId)) return
      // Async per the ruling's disclosed residual 2 (open→秒发 race): the
      // listener never blocks the open; a failure warns and lets the 45s
      // reconcile leg keep its兜底 role.
      void controller.alignOnOpen(sessionId, payload.agent.model).catch((error: unknown) => {
        logger.warn(`dsh-auto-route: open-align listener failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    const offAgentDisposed = ctx.on('agent/disposed', (payload) => {
      live.remove(String(payload.agent.id))
    })
    controller.start()
    const disposeRoute = ctx.webServer.register(makeStatusRoute(controller))
    return () => {
      controller.stop()
      // Unload removes the ledger too: an absent plane means "not attached",
      // a lingering file would only age into the reader's stale bound.
      removePollState()
      try { offRequest() } catch { /* listener already gone during shutdown */ }
      try { offStatus() } catch { /* listener already gone during shutdown */ }
      try { offSelection() } catch { /* listener already gone during shutdown */ }
      try { offAgentCreated() } catch { /* listener already gone during shutdown */ }
      try { offAgentDisposed() } catch { /* listener already gone during shutdown */ }
      try { disposeRoute() } catch { /* route fiber already gone during shutdown */ }
    }
  }, 'dsh-auto-route: policy controller')
})
