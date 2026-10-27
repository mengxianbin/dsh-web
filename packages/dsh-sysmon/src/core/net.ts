/**
 * Pure provider-network quality tracking for the sysmon chip (v4, latency
 * half revised 2026-10-27). Passive only: the host feeds it real
 * model-request observations — attempt start, then the connection segment of
 * that same request (DNS → TCP connect → TLS secureConnect, stamped at the
 * socket layer by `host/conn-tap.ts`), and network-class failures from
 * `agent/request-error` — and it derives one bounded snapshot. No active
 * probing, no network I/O, no timers: both halves compile this file and the
 * tests drive it with an injected clock.
 *
 * Semantics pinned by the 2026-10-27 revision (m-note dsh-sysmon.md, task
 * `#sysmon-conn-latency-1027`, user ask id `sysmon-net-direction`): the
 * latency reading is the pure connection segment — the same millisecond
 * dimension as CPU/memory/disk. TTFT was withdrawn from the main grid
 * because provider queue time plus first-token generation drowned the
 * network component (signal ratio on the order of 1:3–1:30). One shared
 * 10-minute sliding window backs both readings; a window with no
 * observation yields `—` rather than a stale number (the disk row's "never
 * show stale values" rule, with a bound matched to request cadence — model
 * requests arrive per step, so the disk row's 5s bound would flicker the
 * reading through every tool run).
 * @module dsh-sysmon/core/net
 */

import type { SysmonNet, SysmonNetVia } from './types.ts'

/** Sliding window backing both the connection reading and the failure count: ten minutes. */
export const NET_WINDOW_MS = 600_000

/** Failure codes that count as provider-link trouble (deepseek + pi-ai adapters normalize to these). */
export const NET_FAILURE_CODES: readonly string[] = Object.freeze(['TIMEOUT', 'TRANSPORT'])

/** Warn when the window holds at least this many network failures (0 disables the red state). */
export const DEFAULT_NET_WARN_FAILURES = 1

/** Hard cap on retained failure records — a pathological burst inside one tick cannot grow unbounded. */
const MAX_FAILURES = 1_000

/** Hard cap on pending attempt starts (a start without its end frame evicts the oldest). */
const MAX_PENDING = 64

/** One observed attempt start, awaiting its connection segment or end frame. */
interface PendingAttempt {
  at: number
  provider: string | null
}

/** One network-class failure inside the window. */
interface FailureRecord {
  at: number
  code: string
}

/** The newest settled connection-segment observation inside the window. */
interface ConnectRecord {
  at: number
  ms: number
  via: SysmonNetVia
  provider: string | null
}

/** Injectable clock seam so tests run without real timers. */
export interface NetMonitorDeps {
  now(): number
}

/** Options accepted by the monitor constructor. */
export interface NetMonitorOptions {
  /** Window length (default {@link NET_WINDOW_MS}). */
  windowMs?: number
  /** Failures required to redden the reading; 0 disables (default {@link DEFAULT_NET_WARN_FAILURES}). */
  warnFailures?: number
  /** Failure codes counted as network trouble (default {@link NET_FAILURE_CODES}). */
  failureCodes?: readonly string[]
  deps?: Partial<NetMonitorDeps>
}

/**
 * Sliding-window observer over passive model-request facts. Feed it attempt
 * lifecycle events, settled connection segments, and failures; read
 * `snapshot()` for the chip. The monitor owns no timers — pruning happens on
 * read, so an idle host costs nothing.
 */
export class NetMonitor {
  private readonly windowMs: number
  private readonly warnFailures: number
  private readonly failureCodes: readonly string[]
  private readonly deps: NetMonitorDeps
  private readonly pending = new Map<string, PendingAttempt>()
  private readonly failures: FailureRecord[] = []
  private conn: ConnectRecord | null = null
  private lastProvider: string | null = null
  private lastObservedAt = 0

  constructor(options: NetMonitorOptions = {}) {
    this.windowMs = options.windowMs ?? NET_WINDOW_MS
    this.warnFailures = options.warnFailures ?? DEFAULT_NET_WARN_FAILURES
    this.failureCodes = options.failureCodes ?? NET_FAILURE_CODES
    this.deps = { now: () => Date.now(), ...options.deps }
  }

  /** Current clock; exposed so wiring can stamp reads through the same seam. */
  now(): number {
    return this.deps.now()
  }

  /** An attempt emitted its start frame: remember when and on which route it began. */
  noteStart(attemptId: string, provider: string | null): void {
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next()
      if (oldest.done !== true) this.pending.delete(oldest.value)
    }
    this.pending.set(attemptId, { at: this.deps.now(), provider })
  }

  /**
   * A real request's connection segment settled (TLS handshake done). It is
   * attributed to the oldest still-unsettled attempt — the connection that
   * just finished belongs to the earliest request still waiting on one — and
   * dropped entirely when no attempt is pending, so background connections
   * outside a model request never enter the reading. The attempt is consumed:
   * a later first chunk or end frame finds nothing to close.
   * @param ms - first-hop start → secureConnect, ms (clamped at 0).
   * @param via - which handshake shape produced it (direct vs proxy tunnel).
   */
  noteConnect(ms: number, via: SysmonNetVia): void {
    const oldest = this.pending.entries().next()
    if (oldest.done === true) return
    const [attemptId, attempt] = oldest.value
    this.pending.delete(attemptId)
    const at = this.deps.now()
    this.conn = { at, ms: Math.max(0, ms), via, provider: attempt.provider }
    this.lastProvider = attempt.provider
    this.lastObservedAt = at
  }

  /**
   * An attempt produced its first chunk with no connection settled: the
   * request reused a warm keep-alive socket, so there is no new connection
   * segment for it — just close its attribution window (chunks after that
   * find no start, same as v4's end-without-chunk drop).
   */
  noteChunk(attemptId: string): void {
    this.pending.delete(attemptId)
  }

  /** An attempt emitted its end frame without a settled connection (failure or empty response): drop its start. */
  noteEnd(attemptId: string): void {
    this.pending.delete(attemptId)
  }

  /** A model request failed. Only configured network-class codes count; every code is capped in the ring. */
  noteFailure(provider: string | null, code: string): void {
    if (!this.failureCodes.includes(code)) return
    if (this.failures.length >= MAX_FAILURES) this.failures.shift()
    this.failures.push({ at: this.deps.now(), code })
    this.lastProvider = provider
    this.lastObservedAt = this.deps.now()
  }

  /**
   * The bounded reading for the payload: latest connection segment (ms +
   * handshake shape), windowed failure count, the route of the most recent
   * observation, and the warn flag. Prunes everything the window has aged
   * out — including orphaned attempt starts whose end frame never arrived.
   * `ttftMs` is emitted as the always-null v4 wire stub (see {@link SysmonNet}).
   */
  snapshot(): SysmonNet {
    const now = this.deps.now()
    const cutoff = now - this.windowMs
    while (this.failures.length > 0 && (this.failures[0] as FailureRecord).at < cutoff) this.failures.shift()
    for (const [attemptId, start] of this.pending) {
      if (start.at < cutoff) this.pending.delete(attemptId)
    }
    if (this.conn !== null && this.conn.at < cutoff) this.conn = null
    const stale = this.lastObservedAt < cutoff
    const failures = this.failures.length
    return {
      connMs: this.conn?.ms ?? null,
      connAt: this.conn?.at ?? null,
      connVia: this.conn?.via ?? null,
      ttftMs: null,
      failures,
      provider: stale ? null : this.lastProvider,
      warn: this.warnFailures > 0 && failures >= this.warnFailures,
    }
  }
}

/**
 * Format the chip's net value: `—` when the window holds nothing, otherwise
 * the rounded connection segment and/or the failure badge (`23ms`, `⚠2`,
 * `23ms ⚠2`). The badge appears whenever the window holds failures; the red
 * state is the warn threshold's decision, not this function's. `?? null`
 * tolerates a pre-revision host that serves no `connMs` (degrades to the
 * dash / failures only, mirroring v4's optional-`net` degradation).
 * @param net - the snapshot to format.
 * @returns the display string.
 */
export function formatNetValue(net: SysmonNet): string {
  const conn = net.connMs ?? null
  if (net.failures <= 0 && conn === null) return '—'
  const parts: string[] = []
  if (conn !== null) parts.push(`${String(Math.round(conn))}ms`)
  if (net.failures > 0) parts.push(`⚠${String(net.failures)}`)
  return parts.join(' ')
}
