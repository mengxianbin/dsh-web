/**
 * Low-frequency ICMP probe for the sysmon network reading (A-case, 2026-10-28
 * ruling, ask id `net-quality-semantics`): every {@link PROBE_INTERVAL_MS}
 * after the previous round settles, spawn one Windows `ping` at a fixed
 * domestic reference target and report the round trip to the NetMonitor.
 *
 * Design notes pinned by the ruling:
 * - **One concept**: the reading is a bare network-layer RTT — exactly what
 *   `ping <target>` measures — with DNS/TCP/TLS handshake, proxy tunnel and
 *   provider queue deliberately outside its semantics (that decomposition is
 *   what made the retired connection reading read as a scary 500ms).
 * - **Low frequency, negligible traffic**: one 32-byte ICMP echo per minute;
 *   `intervalMs` is scheduled after each round finishes, so a slow/failing
 *   probe can never overlap itself.
 * - **Windows-only by construction**: the package is Windows-only already
 *   (typeperf sampling); `ping.exe` output is parsed for both locale shapes
 *   (`时间=19ms` / `time=19ms`, and the `<1ms` sub-millisecond form).
 * - **Chinese Windows writes ANSI/GBK on a pipe, not UTF-8** (probe-verified
 *   2026-10-28: first line bytes `d5fd d4da` = "正在"): stdout is decoded
 *   through `TextDecoder('gbk')` — ASCII-safe on en machines — and the parser
 *   keeps an ASCII-only fallback for a UTF-8-configured system.
 * - **Failed probes are honest, not silent**: timeout / loss / spawn error
 *   reports `null`, and the monitor records nothing — the last good reading
 *   ages out through its staleness bound instead of freezing on an old value.
 * @module dsh-sysmon/host/ping-probe
 */

import { spawn } from 'node:child_process'

/** Probe cadence: one echo per minute (scheduled after each round settles). */
export const PROBE_INTERVAL_MS = 60_000

/** Per-probe reply timeout passed to `ping -w`, ms. */
export const PROBE_TIMEOUT_MS = 3_000

/**
 * Parse one ping round trip from decoded command output. Matches both
 * Windows locale shapes of the reply line — `时间=19ms` / `时间<1ms` (zh) and
 * `time=19ms` / `time<1ms` (en). The summary lines (`平均 = 19ms`,
 * `Average = 19ms`) never match the strict pattern: they carry no
 * `时间`/`time=` prefix before the number.
 *
 * Falls back to the first `NNms` token when the strict pattern misses: that
 * covers a system whose ping writes UTF-8 while the fixed `gbk` decode used
 * by {@link decodePingOutput} garbles its CJK (and vice versa). On a
 * successful exit the reply line always precedes the statistics, so the
 * first `NNms` is the reply's round trip — and a `<1ms` reply still reads
 * as its `1`.
 * @param output - combined, decoded stdout of one `ping -n 1` run.
 * @returns the round trip in ms, or null when no reply line exists.
 */
export function parsePingRtt(output: string): number | null {
  const strict = /(?:时间|time)\s*[=<]\s*(\d+)\s*ms/i.exec(output)
  const loose = strict ?? /(\d+)\s*ms/i.exec(output)
  if (loose === null) return null
  const ms = Number(loose[1])
  return Number.isFinite(ms) ? ms : null
}

/**
 * Decode one ping stdout chunk to text. Chinese Windows writes ANSI (the
 * system code page, GBK on this machine — probe-verified 2026-10-28: the
 * first line's bytes start `d5fd d4da` = "正在"), not UTF-8, so the strict
 * locale regex only works after a GBK decode; ASCII survives either way.
 * @param chunk - one stdout chunk (Buffer decoded as gbk, strings passed through).
 * @param encoding - decode label (test seam; the default is the production choice).
 * @returns the decoded text.
 */
export function decodePingOutput(chunk: Buffer | string, encoding = 'gbk'): string {
  if (typeof chunk === 'string') return chunk
  try {
    return new TextDecoder(encoding).decode(chunk)
  } catch {
    // Unknown label (e.g. an ICU-less Node that cannot resolve 'gbk'):
    // fall back to utf-8 — the ASCII reply shape still parses.
    return chunk.toString('utf8')
  }
}

/** The child-process surface the probe relies on (structural: the real spawn fits). */
export interface PingChild {
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(): void
}

/** Spawner seam: tests inject a scripted child instead of a real ping. */
export type PingSpawner = (command: string, args: readonly string[]) => PingChild

/** Options accepted by {@link startPingProbe}. */
export interface PingProbeOptions {
  /** Fixed probe target (host name or address). */
  target: string
  /** Cadence after each round settles (default {@link PROBE_INTERVAL_MS}). */
  intervalMs?: number
  /** Reply timeout passed to `ping -w`, ms (default {@link PROBE_TIMEOUT_MS}). */
  timeoutMs?: number
  /** Result sink: the measured round trip, or null when the probe failed. */
  onResult: (ms: number | null) => void
  /** Spawner seam (default = real `ping -n 1 -w <ms> <target>`, hidden window, stdout piped). */
  spawner?: PingSpawner
}

/**
 * Start the resident probe loop: one round immediately, then one per
 * `intervalMs` after the previous round settles (no overlap by construction).
 * @param options - probe configuration and result sink.
 * @returns a disposer that stops scheduling, kills any in-flight child, and suppresses late results (idempotent).
 */
export function startPingProbe(options: PingProbeOptions): () => void {
  const intervalMs = options.intervalMs ?? PROBE_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const spawner: PingSpawner = options.spawner
    ?? ((command, args) => spawn(command, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }) as unknown as PingChild)
  const args: readonly string[] = ['-n', '1', '-w', String(timeoutMs), options.target]
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let child: PingChild | null = null

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(run, intervalMs)
    // Never hold the process open for a cadence timer (host shutdown path).
    timer.unref?.()
  }

  function run(): void {
    if (stopped) return
    let settled = false
    const finish = (ms: number | null): void => {
      if (settled) return
      settled = true
      child = null
      if (!stopped) {
        options.onResult(ms)
        schedule()
      }
    }
    try {
      const next = spawner('ping', args)
      child = next
      const chunks: (Buffer | string)[] = []
      next.stdout?.on('data', (chunk) => { chunks.push(chunk) })
      next.on('error', () => finish(null))
      // Decode once at close: a multibyte (GBK) character split across two
      // stdout chunks must not be decoded per-chunk. (Explicit lambda —
      // Array.map would pass its index into decodePingOutput's encoding seam.)
      next.on('close', (code) => finish(code === 0 ? parsePingRtt(chunks.map((chunk) => decodePingOutput(chunk)).join('')) : null))
    } catch {
      finish(null)
    }
  }

  run()
  return () => {
    if (stopped) return
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    child?.kill()
    child = null
  }
}
