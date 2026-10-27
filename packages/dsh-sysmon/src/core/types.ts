/**
 * Types shared by the dsh-sysmon host sampler and the browser chip. Pure
 * declarations only — both the host program and the client bundle compile
 * this file (packages/AGENTS.md: src/core is the shared layer).
 * @module dsh-sysmon/core/types
 */

/** One 1-second system sample. Disk fields are null while the typeperf child has no fresh row. */
export interface SysmonSample {
  /** Epoch ms of the host tick that produced this sample. */
  t: number
  /** Total CPU busy percent 0-100, or null before the second os.cpus() baseline exists. */
  cpu: number | null
  /** Memory used percent 0-100: (total - free) / total. */
  mem: number
  /** Memory used bytes, for the GB tooltip read-out. */
  memUsedBytes: number
  /** Physical memory total bytes. */
  memTotalBytes: number
  /** Raw % Disk Time 0-100+ (multi-instance sums can exceed 100; consumers clamp for display). */
  diskBusy: number | null
  /** Disk read throughput, bytes/sec. */
  diskRead: number | null
  /** Disk write throughput, bytes/sec. */
  diskWrite: number | null
}

/** Warn thresholds, percent. */
export interface SysmonWarnThresholds {
  cpu: number
  mem: number
  disk: number
}

/**
 * Which handshake shape produced a connection reading: `direct` (DNS + TCP +
 * TLS straight to the origin — all real network) or `proxy` (a local HTTP
 * proxy tunnel: the TCP leg to the proxy is loopback, the span covers the
 * CONNECT reply + TLS handshake over the tunnel). The chip tooltip states
 * this per shape (2026-10-27 ruling, ask id `sysmon-net-direction`).
 */
export type SysmonNetVia = 'direct' | 'proxy'

/**
 * Provider-network reading (v4, latency half revised 2026-10-27): passive
 * observations over one shared sliding window. `connMs` measures the pure
 * connection segment — DNS → TCP connect → TLS secureConnect — stamped at the
 * socket layer of the same real request that carried the model call (TTFT
 * was withdrawn from the main grid: provider queue + first-token generation
 * drowned the network component); `failures` counts network-class failures
 * (`TIMEOUT`/`TRANSPORT`) inside the window. An empty window reads null/`—`
 * — never a stale number.
 */
export interface SysmonNet {
  /** Latest connection-segment latency in the window, ms; null when none (or aged out). */
  connMs: number | null
  /** Epoch ms of that connection observation; null with connMs. */
  connAt: number | null
  /** Which handshake shape produced connMs; null with connMs. */
  connVia: SysmonNetVia | null
  /**
   * v4 TTFT wire stub: always null. Kept so a pre-revision client bundle
   * polling a revised host renders the dash instead of `NaNms` during the
   * restart window (the mirror of v4's optional-`net` degradation).
   */
  ttftMs: null
  /** Network-class failures inside the window. */
  failures: number
  /** Route of the most recent observation (tooltip provider label); null when unknown or stale. */
  provider: string | null
  /** Whether the failure count reached the configured warn threshold. */
  warn: boolean
}

/** Which metrics currently run at or above threshold for the sustained streak. */
export interface SysmonWarn {
  cpu: boolean
  mem: boolean
  disk: boolean
}

/** The GET /api/sysmon/samples document. */
export interface SysmonPayload {
  ok: true
  /** Server clock at response time, epoch ms. */
  at: number
  /** The newest sample, or null before the first tick completes. */
  latest: SysmonSample | null
  /** Sustained-streak warn flags derived from the ring buffer. */
  warn: SysmonWarn
  /** The thresholds in force (the profile patch may override defaults). */
  thresholds: SysmonWarnThresholds
  /**
   * The provider-network reading; added in v4. Optional so a client built
   * against a pre-v4 host (the restart window between bundle build and host
   * reload) degrades to the dash instead of crashing the render.
   */
  net?: SysmonNet
  /** The full ring (oldest first); present only when the caller asks with ?history=1. */
  history?: readonly SysmonSample[]
}
