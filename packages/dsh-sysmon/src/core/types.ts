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
 * Network-quality reading (A-case, 2026-10-28 ruling, ask id
 * `net-quality-semantics`): the latency half is now a low-frequency active
 * ICMP probe — one `ping` round trip to a fixed domestic reference target
 * every 60s — so the read-out means one simple thing: "is this machine's
 * network healthy", on the same bare-network-layer dimension the user's
 * `ping api.deepseek.com` (19ms) reference demonstrated. Cross-border and
 * proxy-path trouble is carried by the failure half instead. The socket-layer
 * connection reading (2026-10-27) and the v4 TTFT reading were both
 * withdrawn from the grid; their wire fields stay as always-null stubs so
 * pre-A-case client bundles render `—` rather than `NaNms` during a restart
 * window.
 */
export interface SysmonNet {
  /** Latest probe round trip within the staleness bound, ms; null when none/stale/probe-disabled. */
  rttMs: number | null
  /** Epoch ms of that probe result; null with rttMs. */
  rttAt: number | null
  /** The fixed probe target the reading is measured against; null when probing is disabled. */
  probe: string | null
  /** Retired connection-reading wire stub: always null (pre-A-case clients render the dash). */
  connMs: null
  /** Retired connection-reading wire stub: always null. */
  connAt: null
  /** Retired handshake-shape wire stub: always null. */
  connVia: null
  /** Retired v4 TTFT wire stub: always null (first withdrawn 2026-10-27). */
  ttftMs: null
  /** Network-class failures inside the window. */
  failures: number
  /** Route of the most recent counted failure (the probe has no route); null when unknown or stale. */
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
