/**
 * The sysmon host sampler: one resident `typeperf` child streams the three
 * PhysicalDisk(_Total) counters over stdout while the tick loop derives CPU
 * (os.cpus() diff) and memory (os.totalmem/freemem) on the same 1s cadence.
 *
 * Transport note (P0 probes 2026-10-24/25, Windows zh-CN): typeperf must be
 * spawned WITHOUT `-f CSV` — that flag diverts the CSV payload into a
 * default `输出.csv` in the process cwd and stdout carries only progress
 * noise. Without `-f` the stdout pipe delivers one CSV line per second
 * (measured ~1 line/s, far below any block-buffer threshold). The child is
 * respawned on unexpected exit; disk fields read null while no fresh row has
 * arrived, so the chip degrades to `—` instead of showing stale numbers.
 * @module dsh-sysmon/host/sampler
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'
import { SampleRing, deriveWarn, parseDiskLine } from '../core/sample.ts'
import type { SysmonSample, SysmonWarn, SysmonWarnThresholds } from '../core/types.ts'

/** Sampling cadence: typeperf `-si 1` plus one tick per second. */
export const TICK_MS = 1_000

/** Ring capacity: ten minutes of 1s samples. */
export const HISTORY_SIZE = 600

/** A disk row older than this counts as stale (child dead or stalled). */
const DISK_STALE_MS = 5_000

/** Delay before respawning an unexpectedly exited typeperf child. */
const RESPAWN_DELAY_MS = 3_000

/**
 * The counters the child streams. `_Total` aggregates every physical disk;
 * `% Disk Time` can exceed 100 on multi-queue disks (clamped at display).
 */
const COUNTERS = [
  '\\PhysicalDisk(_Total)\\% Disk Time',
  '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',
  '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec',
]

/** What the sampler serves to routes and tests. */
export interface SamplerSnapshot {
  latest: SysmonSample | null
  warn: SysmonWarn
  thresholds: SysmonWarnThresholds
  history: readonly SysmonSample[]
}

/** The disk child face the sampler consumes. */
export interface DiskStream {
  /** Kill the child; idempotent. */
  kill(): void
}

/** Injectable clock/counter seam so tests run without real timers or typeperf. */
export interface SamplerDeps {
  now(): number
  cpus(): ReturnType<typeof cpus>
  totalmem(): number
  freemem(): number
  /** Spawn the disk child feeding per-CSV-line rows to `onLine`; `onExit` fires on unsolicited death. */
  spawnDisk(onLine: (line: string) => void, onExit: () => void): DiskStream
  interval(fn: () => void, ms: number): () => void
  /** Schedule a one-shot callback (respawn delay); returns a cancel function. */
  timeout(fn: () => void, ms: number): () => void
}

/** Options accepted by the sampler constructor. */
export interface SamplerOptions {
  thresholds?: Partial<SysmonWarnThresholds>
  warnStreak?: number
  historySize?: number
  deps?: Partial<SamplerDeps>
}

/**
 * Spawn one resident typeperf child whose stdout CSV lines invoke `onLine`.
 * The child runs without `-f` (see the module note); an immediate spawn
 * failure or an unexpected exit fires `onExit`, which the sampler uses to
 * respawn the disk source.
 * @param onLine - per-stdout-line callback.
 * @param onExit - fired once when the child dies on its own (not via kill()).
 * @returns the child handle.
 */
export function spawnTypeperf(onLine: (line: string) => void, onExit?: () => void): DiskStream {
  // Deliberately no `-f`: on zh-CN Windows it diverts the CSV to 输出.csv.
  const child: ChildProcess = spawn('typeperf', ['-si', '1', ...COUNTERS], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let buffer = ''
  let killed = false
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      onLine(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  })
  // A dead child must not crash the host; the sampler's staleness rule hides it
  // and its onExit handler respawns it.
  child.on('error', () => { if (!killed) onExit?.() })
  child.on('exit', () => { if (!killed) onExit?.() })
  return {
    kill: () => {
      if (killed) return
      killed = true
      try { child.kill() } catch { /* already gone */ }
    },
  }
}

/**
 * The live sampler. Start once per host process; stop on plugin dispose.
 */
export class SysmonSampler {
  private readonly ring: SampleRing
  private readonly thresholds: SysmonWarnThresholds
  private readonly warnStreak: number
  private readonly deps: SamplerDeps
  private disk: DiskStream | null = null
  private stopTick: (() => void) | null = null
  private cancelRespawn: (() => void) | null = null
  private prevCpus: ReturnType<typeof cpus> | null = null
  private lastDisk: { busy: number; read: number; write: number; at: number } | null = null

  constructor(options: SamplerOptions = {}) {
    this.ring = new SampleRing(options.historySize ?? HISTORY_SIZE)
    this.thresholds = {
      cpu: options.thresholds?.cpu ?? 90,
      mem: options.thresholds?.mem ?? 90,
      disk: options.thresholds?.disk ?? 90,
    }
    this.warnStreak = options.warnStreak ?? 3
    this.deps = {
      now: () => Date.now(),
      cpus,
      totalmem,
      freemem,
      spawnDisk: (onLine, onExit) => spawnTypeperf(onLine, onExit),
      interval: (fn, ms) => {
        const timer = setInterval(fn, ms)
        return () => clearInterval(timer)
      },
      timeout: (fn, ms) => {
        const timer = setTimeout(fn, ms)
        return () => clearTimeout(timer)
      },
      ...options.deps,
    }
  }

  /** Begin sampling: spawn the disk child and start the 1s tick loop. */
  start(): void {
    if (this.stopTick !== null) return
    this.spawnDiskChild()
    this.stopTick = this.deps.interval(() => this.tick(), TICK_MS)
  }

  /** Stop sampling: kill the child and the tick loop; cancel any pending respawn. Idempotent. */
  stop(): void {
    this.stopTick?.()
    this.stopTick = null
    this.cancelRespawn?.()
    this.cancelRespawn = null
    this.disk?.kill()
    this.disk = null
  }

  /** The current snapshot for routes: newest sample, warn flags, thresholds, history. */
  snapshot(): SamplerSnapshot {
    return {
      latest: this.ring.latest(),
      warn: deriveWarn(this.ring, this.thresholds, this.warnStreak),
      thresholds: { ...this.thresholds },
      history: this.ring.all(),
    }
  }

  private spawnDiskChild(): void {
    // The single stdout consumer: every complete CSV line updates the disk
    // reading; blank first-sample rows parse to null and are ignored.
    this.disk = this.deps.spawnDisk((line) => {
      const row = parseDiskLine(line)
      if (row === null) return
      this.lastDisk = { ...row, at: this.deps.now() }
    }, () => {
      // Unsolicited death: hide via staleness now, respawn shortly. stop()
      // cancels a pending respawn by flipping stopTick to null first.
      this.disk = null
      if (this.stopTick === null) return
      this.cancelRespawn?.()
      this.cancelRespawn = this.deps.timeout(() => {
        if (this.stopTick === null) return
        this.spawnDiskChild()
      }, RESPAWN_DELAY_MS)
    })
  }

  private tick(): void {
    const now = this.deps.now()
    // CPU: busy% from the diff of two cumulative os.cpus() snapshots.
    const snapshot = this.deps.cpus()
    let cpu: number | null = null
    if (this.prevCpus !== null && this.prevCpus.length === snapshot.length && snapshot.length > 0) {
      let busy = 0
      let total = 0
      for (let index = 0; index < snapshot.length; index += 1) {
        const before = this.prevCpus[index]?.times
        const after = snapshot[index]?.times
        if (before === undefined || after === undefined) continue
        for (const [key, value] of Object.entries(after)) {
          const delta = value - (before[key as keyof typeof after] ?? 0)
          if (delta > 0) {
            total += delta
            if (key !== 'idle' && key !== 'nice') busy += delta
          }
        }
      }
      if (total > 0) cpu = Math.min(100, Math.max(0, (busy / total) * 100))
    }
    this.prevCpus = snapshot
    // Memory: used share of physical total.
    const total = this.deps.totalmem()
    const free = this.deps.freemem()
    const mem = total > 0 ? Math.min(100, Math.max(0, ((total - free) / total) * 100)) : 0
    // Disk: latest row while fresh, null once the child is dead or stalled.
    const disk = this.lastDisk !== null && now - this.lastDisk.at <= DISK_STALE_MS
      ? this.lastDisk
      : null
    this.ring.push({
      t: now,
      cpu,
      mem,
      memUsedBytes: total - free,
      memTotalBytes: total,
      diskBusy: disk?.busy ?? null,
      diskRead: disk?.read ?? null,
      diskWrite: disk?.write ?? null,
    })
  }
}
