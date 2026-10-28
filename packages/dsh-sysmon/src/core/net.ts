/**
 * Pure network-quality tracking for the sysmon chip (A-case, 2026-10-28
 * ruling, ask id `net-quality-semantics`). Two independent halves:
 *
 * - **Latency**: an active, low-frequency ICMP probe — the host spawns
 *   `ping -n 1` at a fixed domestic reference target every 60s
 *   (`host/ping-probe.ts`) and feeds the round trip here. This replaces both
 *   the v4 TTFT reading (withdrawn 2026-10-27) and the socket-layer
 *   connection reading (withdrawn with this case): a bare network-layer RTT
 *   is the one simple concept the ruling asked for — same dimension as the
 *   user's own `ping api.deepseek.com` baseline — with handshake, proxy and
 *   provider-queue overhead deliberately outside its semantics.
 * - **Failures**: still purely passive — `host/net-observe.ts` counts
 *   `TIMEOUT`/`TRANSPORT` request errors in a 10-minute sliding window and
 *   keeps serving them on the wire for API compatibility, but since the
 *   2026-10-28 display ruling ("彻底撤": the ten-minute window cannot
 *   represent the present moment) the chip renders neither the `⚠n` badge,
 *   the red state, nor the tooltip count — only the RTT reading below.
 *
 * This file compiles into both the host and the client program, so it stays
 * free of node/DOM APIs and timers: the probe loop lives host-side, the
 * staleness bound is checked on read, and tests drive the monitor with an
 * injected clock.
 * @module dsh-sysmon/core/net
 */

import type { SysmonNet } from './types.ts'

/** Failure-window length backing the count: ten minutes. */
export const NET_WINDOW_MS = 600_000

/** Failure codes that count as provider-link trouble (deepseek + pi-ai adapters normalize to these). */
export const NET_FAILURE_CODES: readonly string[] = Object.freeze(['TIMEOUT', 'TRANSPORT'])

/** Warn when the window holds at least this many network failures (0 disables the red state). */
export const DEFAULT_NET_WARN_FAILURES = 1

/**
 * A probe round trip older than this reads as no value at all: two probe
 * intervals (60s each) plus 30s grace. A failed probe records nothing, so
 * sustained probe loss ages the last good reading out and the cell falls to
 * `—` — the disk row's "never show stale values" rule at probe cadence.
 */
export const RTT_STALE_MS = 150_000

/** Hard cap on retained failure records — a pathological burst inside one tick cannot grow unbounded. */
const MAX_FAILURES = 1_000

/** One network-class failure inside the window. */
interface FailureRecord {
  at: number
  code: string
}

/** The newest probe result, aged out on read past {@link RTT_STALE_MS}. */
interface RttRecord {
  at: number
  ms: number
}

/** Injectable clock seam so tests run without real timers. */
export interface NetMonitorDeps {
  now(): number
}

/** Options accepted by the monitor constructor. */
export interface NetMonitorOptions {
  /** Failure-window length (default {@link NET_WINDOW_MS}). */
  windowMs?: number
  /** Failures required to redden the reading; 0 disables (default {@link DEFAULT_NET_WARN_FAILURES}). */
  warnFailures?: number
  /** Failure codes counted as network trouble (default {@link NET_FAILURE_CODES}). */
  failureCodes?: readonly string[]
  /** The fixed probe target echoed to the payload tooltip; null when probing is disabled. */
  probe?: string | null
  deps?: Partial<NetMonitorDeps>
}

/**
 * The chip's network reading: probe RTT (bounded by staleness, never stale)
 * plus passive failure counting. The monitor owns no timers — probe cadence
 * belongs to the host loop, pruning happens on read, so an idle host costs
 * nothing.
 */
export class NetMonitor {
  private readonly windowMs: number
  private readonly warnFailures: number
  private readonly failureCodes: readonly string[]
  private readonly probe: string | null
  private readonly deps: NetMonitorDeps
  private readonly failures: FailureRecord[] = []
  private rtt: RttRecord | null = null
  private lastProvider: string | null = null
  private lastFailureAt = 0

  constructor(options: NetMonitorOptions = {}) {
    this.windowMs = options.windowMs ?? NET_WINDOW_MS
    this.warnFailures = options.warnFailures ?? DEFAULT_NET_WARN_FAILURES
    this.failureCodes = options.failureCodes ?? NET_FAILURE_CODES
    this.probe = options.probe ?? null
    this.deps = { now: () => Date.now(), ...options.deps }
  }

  /** Current clock; exposed so wiring can stamp reads through the same seam. */
  now(): number {
    return this.deps.now()
  }

  /**
   * One probe round completed. `ms` is the measured round trip; `null` means
   * the probe failed (timeout / packet loss / spawn error) and records
   * nothing — the last good reading stands until {@link RTT_STALE_MS} ages it
   * out. The probe carries no provider route, so a successful round does not
   * touch `lastProvider`/`lastFailureAt`: the route label describes counted
   * failures only.
   * @param ms - ICMP echo round trip, ms (clamped at 0), or null on failure.
   */
  noteRtt(ms: number | null): void {
    if (ms === null) return
    const at = this.deps.now()
    this.rtt = { at, ms: Math.max(0, ms) }
  }

  /** A model request failed. Only configured network-class codes count; every code is capped in the ring. */
  noteFailure(provider: string | null, code: string): void {
    if (!this.failureCodes.includes(code)) return
    if (this.failures.length >= MAX_FAILURES) this.failures.shift()
    this.failures.push({ at: this.deps.now(), code })
    this.lastProvider = provider
    this.lastFailureAt = this.deps.now()
  }

  /**
   * The bounded reading for the payload: the freshest probe round trip
   * (null past the staleness bound — a failed-probe gap never renders a
   * stale number), the windowed failure count, the route of the most recent
   * counted failure, and the warn flag. `connMs`/`connAt`/`connVia`/`ttftMs`
   * are emitted as the always-null retired wire stubs (see {@link SysmonNet}).
   */
  snapshot(): SysmonNet {
    const now = this.deps.now()
    const cutoff = now - this.windowMs
    while (this.failures.length > 0 && (this.failures[0] as FailureRecord).at < cutoff) this.failures.shift()
    const freshRtt = this.rtt !== null && this.rtt.at >= now - RTT_STALE_MS
    const rtt = freshRtt ? this.rtt : null
    const stale = this.lastFailureAt < cutoff
    const failures = this.failures.length
    return {
      rttMs: rtt?.ms ?? null,
      rttAt: rtt?.at ?? null,
      probe: this.probe,
      connMs: null,
      connAt: null,
      connVia: null,
      ttftMs: null,
      failures,
      provider: stale || this.lastFailureAt === 0 ? null : this.lastProvider,
      warn: this.warnFailures > 0 && failures >= this.warnFailures,
    }
  }
}

/**
 * Format the chip's net value: the rounded probe round trip, or `—` when the
 * reading holds none — one value, never the failure badge. The 10-minute
 * failure count still rides the payload (`failures`/`provider`/`warn`), but
 * displaying it was withdrawn by the 2026-10-28 ruling: a window that long
 * cannot show the present state, so the badge, the red state and the tooltip
 * count went away together. `?? null` tolerates a pre-A-case host that serves
 * no `rttMs` (degrades to the dash, mirroring v4's optional-`net`
 * degradation).
 * @param net - the snapshot to format.
 * @returns the display string.
 */
export function formatNetValue(net: SysmonNet): string {
  const rtt = net.rttMs ?? null
  return rtt === null ? '—' : `${String(Math.round(rtt))}ms`
}
