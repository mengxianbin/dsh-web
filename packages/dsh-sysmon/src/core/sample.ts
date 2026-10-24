/**
 * Pure sample math for the sysmon plugin: typeperf CSV row parsing, the
 * fixed-cap ring buffer, and the sustained-streak warn derivation. No imports
 * from node or the browser — both halves compile this file, and the tests
 * exercise it directly without spawning anything.
 * @module dsh-sysmon/core/sample
 */

import type { SysmonSample, SysmonWarn, SysmonWarnThresholds } from './types.ts'

/**
 * One disk row as typeperf emits it: `"10/24/2026 20:36:04.089","1254419.31","55.71"`.
 * @param line - one CSV line from the typeperf stream.
 * @returns the three disk numbers, or null for the header line and for the
 *   blank first-sample rows (`" "` values) typeperf emits before its counters
 *   have a delta baseline.
 */
export function parseDiskLine(line: string): { busy: number; read: number; write: number } | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('"(PDH-CSV')) return null
  const cells = trimmed.split(',')
  if (cells.length < 4) return null
  const numbers: number[] = []
  for (const cell of cells.slice(1, 4)) {
    // Unquote then require a non-empty literal: Number(' ') is 0, so the
    // blank `" "` first-sample rows must be rejected before coercion.
    const literal = cell.trim().replace(/^"|"$/g, '').trim()
    if (literal === '') return null
    const value = Number(literal)
    if (!Number.isFinite(value)) return null
    numbers.push(value)
  }
  return { busy: numbers[0] as number, read: numbers[1] as number, write: numbers[2] as number }
}

/**
 * Clamp a raw % Disk Time reading to the display range. Multi-instance
 * (_Total) sums can exceed 100 on multi-queue disks; the display shows 100
 * while history keeps the raw value.
 * @param busy - raw percent.
 * @returns percent clamped to 0-100, rounded.
 */
export function clampBusy(busy: number): number {
  return Math.min(100, Math.max(0, Math.round(busy)))
}

/**
 * Format a bytes/sec throughput as a compact MB/s read-out (`1.2`).
 * @param bytesPerSecond - throughput in bytes/sec.
 * @returns megabytes per second, one decimal, or `-` for null.
 */
export function formatMBps(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return '-'
  return (bytesPerSecond / 1_048_576).toFixed(1)
}

/**
 * A fixed-capacity FIFO of samples. Pushing past the cap drops the oldest.
 */
export class SampleRing {
  private readonly items: SysmonSample[] = []

  /**
   * @param cap - maximum retained samples (600 = ten minutes at 1s).
   */
  constructor(private readonly cap: number) {
    if (!Number.isInteger(cap) || cap < 1) throw new Error('SampleRing cap must be a positive integer')
  }

  /** Append one sample, dropping the oldest when the cap is reached. */
  push(sample: SysmonSample): void {
    this.items.push(sample)
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap)
  }

  /** The newest sample, or null when empty. */
  latest(): SysmonSample | null {
    return this.items.length === 0 ? null : (this.items[this.items.length - 1] as SysmonSample)
  }

  /** All retained samples, oldest first. */
  all(): readonly SysmonSample[] {
    return this.items
  }

  /** Current fill count. */
  get size(): number {
    return this.items.length
  }
}

/**
 * Derive sustained warn flags from the ring: a metric warns only when the
 * last `streak` consecutive samples are all at or above its threshold
 * (three samples at 1s = three seconds, so a single spike never reddens the
 * chip). Metrics whose samples are null (disk before its first row, CPU
 * before its second tick) never warn.
 * @param ring - the sample ring.
 * @param thresholds - per-metric percent thresholds.
 * @param streak - consecutive samples required to warn (default 3).
 * @returns per-metric warn flags.
 */
export function deriveWarn(
  ring: SampleRing,
  thresholds: SysmonWarnThresholds,
  streak = 3,
): SysmonWarn {
  const samples = ring.all()
  const tail = samples.slice(Math.max(0, samples.length - streak))
  const sustained = (pick: (s: SysmonSample) => number | null, threshold: number): boolean =>
    tail.length === streak && tail.every((s) => {
      const value = pick(s)
      return value !== null && value >= threshold
    })
  return {
    cpu: sustained((s) => s.cpu, thresholds.cpu),
    mem: sustained((s) => s.mem, thresholds.mem),
    disk: sustained((s) => s.diskBusy, thresholds.disk),
  }
}
