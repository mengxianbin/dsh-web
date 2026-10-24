import { describe, expect, it } from 'vitest'
import { SysmonSampler, type DiskStream } from '../src/host/sampler.ts'

/** A controllable fake child: rows are fed by hand, kill() is recorded. */
function fakeDisk() {
  const state = { killed: 0, onLine: null as ((line: string) => void) | null, onExit: null as (() => void) | null }
  const stream: DiskStream = { kill: () => { state.killed += 1 } }
  return {
    state,
    spawn: (onLine: (line: string) => void, onExit: () => void) => {
      state.onLine = onLine
      state.onExit = onExit
      return stream
    },
  }
}

/** Build a sampler over manual clock/ticks; returns the fakes for driving. */
function harness(overrides: { mem?: number; total?: number } = {}) {
  const disk = fakeDisk()
  let now = 1_000
  let tickFn: (() => void) | null = null
  let timeoutFn: (() => void) | null = null
  // os.cpus() counters only ever grow and each entry nests a `times` object.
  // Every consecutive diff here is busy 90 of total 100, so any tick after
  // the first yields 90% CPU. The counter advances once per cpus() call.
  let cpuSeq = 0
  const sampler = new SysmonSampler({
    deps: {
      now: () => now,
      cpus: () => {
        cpuSeq += 1
        const times = { idle: 100 + cpuSeq * 10, user: cpuSeq * 70, sys: cpuSeq * 20, nice: 0, irq: 0 }
        return new Array(4).fill(null).map(() => ({ model: 'fake', speed: 0, times }))
      },
      totalmem: () => overrides.total ?? 16 * 1024 ** 3,
      freemem: () => overrides.mem ?? 6 * 1024 ** 3,
      spawnDisk: disk.spawn,
      interval: (fn) => { tickFn = fn; return () => { tickFn = null } },
      timeout: (fn) => { timeoutFn = fn; return () => { timeoutFn = null } },
    },
  })
  return {
    sampler,
    disk,
    advance(ms: number) { now += ms },
    tick() { tickFn?.() },
    fireRespawn() { timeoutFn?.() },
    running() { return tickFn !== null },
    respawnPending() { return timeoutFn !== null },
  }
}

describe('SysmonSampler', () => {
  it('samples CPU from the os.cpus() diff and memory from totals', () => {
    const h = harness()
    h.sampler.start()
    h.tick() // first tick: no baseline, cpu null
    h.tick() // second tick: diff of the two snapshots
    const snap = h.sampler.snapshot()
    expect(snap.latest?.cpu).toBeCloseTo(90, 0)
    expect(snap.latest?.mem).toBeCloseTo(62.5, 1)
    expect(snap.latest?.memTotalBytes).toBe(16 * 1024 ** 3)
    h.sampler.stop()
  })

  it('parses disk rows fed by the child and keeps them while fresh', () => {
    const h = harness()
    h.sampler.start()
    h.disk.state.onLine?.('"10/24/2026 21:00:00.000","45.5","1200000","300000"')
    h.tick()
    const latest = h.sampler.snapshot().latest
    expect(latest?.diskBusy).toBe(45.5)
    expect(latest?.diskRead).toBe(1_200_000)
    expect(latest?.diskWrite).toBe(300_000)
    h.sampler.stop()
  })

  it('reads disk as null once the last row goes stale (child dead or stalled)', () => {
    const h = harness()
    h.sampler.start()
    h.disk.state.onLine?.('"10/24/2026 21:00:00.000","45.5","1200000","300000"')
    h.tick()
    h.advance(6_000)
    h.tick()
    expect(h.sampler.snapshot().latest?.diskBusy).toBeNull()
    h.sampler.stop()
  })

  it('ignores header and blank rows the child emits', () => {
    const h = harness()
    h.sampler.start()
    h.disk.state.onLine?.('"(PDH-CSV 4.0)","\\\\M\\Disk Time"')
    h.disk.state.onLine?.('"10/24/2026 21:00:00.000"," "," "," "')
    h.tick()
    expect(h.sampler.snapshot().latest?.diskBusy).toBeNull()
    h.sampler.stop()
  })

  it('derives sustained warn flags at the configured thresholds', () => {
    const h = harness()
    h.sampler.start()
    h.disk.state.onLine?.('"10/24/2026 21:00:00.000","95","1200000","300000"')
    h.tick() // tick 1: CPU has no baseline yet (null)
    h.tick() // ticks 2-4: CPU 90% each, disk 95% each
    h.tick()
    h.tick()
    const snap = h.sampler.snapshot()
    expect(snap.warn.cpu).toBe(true) // three consecutive 90% samples
    expect(snap.warn.disk).toBe(true) // 95 ≥ 90 for three samples
    expect(snap.warn.mem).toBe(false)
    expect(snap.thresholds).toEqual({ cpu: 90, mem: 90, disk: 90 })
    h.sampler.stop()
  })

  it('respawns the disk child after an unsolicited exit', () => {
    const h = harness()
    h.sampler.start()
    h.disk.state.onExit?.()
    expect(h.respawnPending()).toBe(true)
    h.fireRespawn()
    // A fresh child re-registered its line handler.
    expect(h.disk.state.onLine).not.toBeNull()
    h.sampler.stop()
  })

  it('stop() kills a live child and cancels the tick loop', () => {
    const h = harness()
    h.sampler.start()
    h.sampler.stop()
    expect(h.disk.state.killed).toBe(1)
    expect(h.running()).toBe(false)
  })

  it('stop() after an unsolicited exit cancels the pending respawn', () => {
    const h = harness()
    h.sampler.start()
    h.disk.state.onExit?.()
    h.sampler.stop()
    expect(h.respawnPending()).toBe(false)
    expect(h.running()).toBe(false)
    // The dead child needs no kill; a fired respawn would have been cancelled.
    expect(h.disk.state.killed).toBe(0)
  })

  it('serves the full ring as history', () => {
    const h = harness()
    h.sampler.start()
    for (let i = 0; i < 3; i += 1) h.tick()
    expect(h.sampler.snapshot().history).toHaveLength(3)
    h.sampler.stop()
  })
})
