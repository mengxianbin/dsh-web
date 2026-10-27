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
 * Provider-network reading (v4): passive observations over one shared sliding
 * window. `ttftMs` measures attempt start → first chunk on real requests
 * (connect + first byte + first token); `failures` counts network-class
 * failures (`TIMEOUT`/`TRANSPORT`) inside the window. An empty window reads
 * null/`—` — never a stale number.
 */
export interface SysmonNet {
  /** Latest first-token latency in the window, ms; null when none (or aged out). */
  ttftMs: number | null
  /** Epoch ms of that TTFT observation; null with ttftMs. */
  ttftAt: number | null
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
