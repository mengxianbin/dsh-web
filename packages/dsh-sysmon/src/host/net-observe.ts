/**
 * Passive provider-network observation (v4): feeds the NetMonitor from two
 * harness agent events, with zero behavior change on either.
 *
 * - `agent/assistant-stream` (emit): attempt `start` stamps the clock, the
 *   first `chunk` settles it into a TTFT reading, `end` without a chunk drops
 *   it (failure or empty response — `agent/request-error` counts those).
 *   The deepseek adapter's `stream()` is a lazy async generator, so the
 *   start frame lands before connect: start → first chunk measures connect +
 *   first byte + first token on the exact route real requests travel.
 * - `agent/request-error` (waterfall): counts `TIMEOUT`/`TRANSPORT` failures,
 *   then delegates `next()` untouched. **Prepend is load-bearing** — llm-retry
 *   owns recovery and returns its retry decision WITHOUT calling `next()`, so
 *   a listener registered behind it would be bypassed on every retried
 *   failure (exactly the failures worth counting). Prepending observes first
 *   and changes nothing downstream.
 *
 * The listener context is the profile bundle's root ctx (unscoped), and
 * scope-filtered dispatch admits untagged listeners for every agent
 * (`dsh-scope`: scopeOf(ctx) === undefined → admitted), so one listener sees
 * all sessions' traffic — the describe-image precedent.
 * @module dsh-sysmon/host/net-observe
 */

import type { Context } from '@deepseek-ai/cordis'
// Pulls the pinned SDK's Events declarations (agent/request-error) into scope.
import type {} from '@deepseek-ai/dsh-agent'
import type { NetMonitor } from '../core/net.ts'

/** The agent fields the observer reads — structural, session route is best-effort. */
export interface NetAgentFace {
  readonly options?: { readonly provider?: string }
  readonly session?: {
    requestHeader?(): { config?: { provider?: string } } | undefined
  }
}

/** The stream-frame fields the observer reads; the runtime frame carries more. */
export interface NetAssistantFrame {
  readonly type: 'start' | 'chunk' | 'end'
  readonly attemptId: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Live assistant attempt frames. The host runtime (rc.3 lineage) emits
     * this since harness commit 30e045dfad; the pinned rc.1 SDK types predate
     * it — when the cohort upgrade ships the official declaration, DELETE
     * this block (SlotMap-shim precedent: identical-key augmentation would
     * then conflict and name itself).
     */
    'agent/assistant-stream'(payload: { agent: NetAgentFace; frame: NetAssistantFrame }): void
  }
}

/** Best-effort route label for an attempt: the session's logged request config, else agent options. */
function routeOf(agent: NetAgentFace): string | null {
  const logged = agent.session?.requestHeader?.()?.config?.provider
  if (typeof logged === 'string' && logged !== '') return logged
  const options = agent.options?.provider
  return typeof options === 'string' && options !== '' ? options : null
}

/**
 * Register both passive observers on the plugin context.
 * @param ctx - registrant context; every listener unwinds with its fiber.
 * @param monitor - the windowed reading the listeners feed.
 * @returns a disposer removing both listeners (idempotent via cordis).
 */
export function observeNet(ctx: Context, monitor: NetMonitor): () => void {
  const offStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') monitor.noteStart(frame.attemptId, routeOf(agent))
    else if (frame.type === 'chunk') monitor.noteChunk(frame.attemptId)
    else monitor.noteEnd(frame.attemptId)
  })
  const offFailures = ctx.on('agent/request-error', (payload, next) => {
    // Record first, then hand the waterfall back untouched: prepending makes
    // this observer see every failed attempt, including ones llm-retry
    // recovers without consulting downstream listeners.
    monitor.noteFailure(payload.provider, payload.failure.code)
    return next()
  }, { prepend: true })
  return () => {
    offFailures()
    offStream()
  }
}
