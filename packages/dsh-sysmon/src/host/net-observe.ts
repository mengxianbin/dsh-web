/**
 * Passive provider-network observation (v4, revised 2026-10-27): feeds the
 * NetMonitor from two harness agent events plus the socket-layer connection
 * tap, with zero behavior change on any of them.
 *
 * - `agent/assistant-stream` (emit): attempt `start` stamps the attribution
 *   window (and the route label); the first `chunk` or the `end` frame
 *   closes it when no connection settled — that request reused a warm
 *   keep-alive socket, so it has no new connection segment (or it failed
 *   before connecting; `agent/request-error` counts those). The deepseek
 *   adapter's `stream()` is a lazy async generator, so the start frame lands
 *   before connect: the connection segment that follows belongs to this
 *   attempt and settles the latency reading.
 * - connection tap (`host/conn-tap.ts`): wraps the process net/tls connect
 *   entry points the undici fetch stack uses (probe-verified both shapes —
 *   direct TLS and local-proxy CONNECT tunnel, 2026-10-27) and reports one
 *   DNS→TCP→TLS segment per completed handshake. The monitor attributes it
 *   to the oldest pending attempt and ignores segments with no pending
 *   attempt, so background traffic outside a model request stays out.
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
import { tapConnections, type ConnSegment } from './conn-tap.ts'

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

/** Wiring seam: the connection-tap installer (tests inject a fake, no real sockets). */
export type ConnTapInstaller = (onSegment: (segment: ConnSegment) => void) => () => void

/** Options accepted by {@link observeNet}. */
export interface ObserveNetOptions {
  /** Connection-tap installer (default = the real socket-layer tap). */
  tap?: ConnTapInstaller
}

/**
 * Register both passive observers plus the connection tap on the plugin context.
 * @param ctx - registrant context; every listener unwinds with its fiber.
 * @param monitor - the windowed reading the listeners and tap feed.
 * @param options - wiring seam for tests.
 * @returns a disposer removing the tap and both listeners (idempotent via cordis).
 */
export function observeNet(ctx: Context, monitor: NetMonitor, options: ObserveNetOptions = {}): () => void {
  const installTap = options.tap ?? ((onSegment: (segment: ConnSegment) => void) => tapConnections(onSegment))
  const stopTap = installTap((segment) => monitor.noteConnect(segment.ms, segment.via))
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
    stopTap()
    offFailures()
    offStream()
  }
}
