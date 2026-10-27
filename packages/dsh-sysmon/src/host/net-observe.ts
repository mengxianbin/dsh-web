/**
 * Passive provider-failure observation (A-case, 2026-10-28): one waterfall
 * listener counting network-class request errors into the NetMonitor, with
 * zero behavior change downstream.
 *
 * - `agent/request-error` (waterfall): counts `TIMEOUT`/`TRANSPORT` failures,
 *   then delegates `next()` untouched. **Prepend is load-bearing** — llm-retry
 *   owns recovery and returns its retry decision WITHOUT calling `next()`, so
 *   a listener registered behind it would be bypassed on every retried
 *   failure (exactly the failures worth counting). Prepending observes first
 *   and changes nothing downstream.
 *
 * The latency half of the reading no longer comes from this module: the
 * socket-layer connection tap and the `agent/assistant-stream` attribution
 * window were withdrawn with the A-case (rollback anchor: commit `8ec42c58`),
 * replaced by the active ICMP probe (`host/ping-probe.ts`). This failure
 * half stays purely passive — cross-border / proxy trouble carries the
 * reading's "兜底" half while the probe measures the local network.
 *
 * The listener context is the profile bundle's root ctx (unscoped), and
 * scope-filtered dispatch admits untagged listeners for every agent
 * (`dsh-scope`: scopeOf(ctx) === undefined → admitted), so one listener sees
 * all sessions' failures.
 * @module dsh-sysmon/host/net-observe
 */

import type { Context } from '@deepseek-ai/cordis'
// Pulls the pinned SDK's Events declarations (agent/request-error) into scope.
import type {} from '@deepseek-ai/dsh-agent'
import type { NetMonitor } from '../core/net.ts'

/**
 * Register the passive failure observer on the plugin context.
 * @param ctx - registrant context; the listener unwinds with its fiber.
 * @param monitor - the windowed reading the listener feeds.
 * @returns a disposer removing the listener (idempotent via cordis).
 */
export function observeNet(ctx: Context, monitor: NetMonitor): () => void {
  return ctx.on('agent/request-error', (payload, next) => {
    // Record first, then hand the waterfall back untouched: prepending makes
    // this observer see every failed attempt, including ones llm-retry
    // recovers without consulting downstream listeners.
    monitor.noteFailure(payload.provider, payload.failure.code)
    return next()
  }, { prepend: true })
}
