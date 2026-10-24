import { describe, expect, it } from 'vitest'
import { SampleRing, clampBusy, deriveWarn, formatMBps, parseDiskLine } from '../src/core/sample.ts'
import type { SysmonSample } from '../src/core/types.ts'

/** One sample with sensible defaults; override per case. */
function sample(overrides: Partial<SysmonSample> = {}): SysmonSample {
  return {
    t: 0,
    cpu: 10,
    mem: 50,
    memUsedBytes: 8 * 1024 ** 3,
    memTotalBytes: 16 * 1024 ** 3,
    diskBusy: 5,
    diskRead: 1_000_000,
    diskWrite: 500_000,
    ...overrides,
  }
}

describe('parseDiskLine', () => {
  it('rejects a two-counter row (fewer cells than the sampler needs)', () => {
    expect(parseDiskLine('"10/24/2026 20:36:04.089","1254419.315207","55.714790"')).toBeNull()
  })

  it('parses the three-counter row shape the sampler uses', () => {
    const row = parseDiskLine('"10/24/2026 20:36:04.089","91.71","3404622.68","6544235.82"')
    expect(row).toEqual({ busy: 91.71, read: 3404622.68, write: 6544235.82 })
  })

  it('rejects the PDH-CSV header line', () => {
    expect(parseDiskLine('"(PDH-CSV 4.0)","\\\\M\\PhysicalDisk(_Total)\\% Disk Time"')).toBeNull()
  })

  it('rejects the blank first-sample rows typeperf emits', () => {
    expect(parseDiskLine('"10/24/2026 20:36:04.089"," "," "," "')).toBeNull()
  })

  it('rejects empty and short lines', () => {
    expect(parseDiskLine('')).toBeNull()
    expect(parseDiskLine('"only-two","cells"')).toBeNull()
  })
})

describe('clampBusy', () => {
  it('passes through in-range values rounded', () => {
    expect(clampBusy(8.4)).toBe(8)
    expect(clampBusy(8.6)).toBe(9)
  })

  it('clamps multi-instance sums above 100 to 100', () => {
    expect(clampBusy(106.3)).toBe(100)
  })

  it('clamps negatives to 0', () => {
    expect(clampBusy(-1)).toBe(0)
  })
})

describe('formatMBps', () => {
  it('formats bytes/sec as one-decimal MB/s', () => {
    expect(formatMBps(1_258_291)).toBe('1.2')
    expect(formatMBps(0)).toBe('0.0')
  })

  it('renders a dash for null', () => {
    expect(formatMBps(null)).toBe('-')
  })
})

describe('SampleRing', () => {
  it('keeps the newest sample and drops the oldest past the cap', () => {
    const ring = new SampleRing(3)
    for (let i = 1; i <= 5; i += 1) ring.push(sample({ t: i }))
    expect(ring.size).toBe(3)
    expect(ring.all().map((s) => s.t)).toEqual([3, 4, 5])
    expect(ring.latest()?.t).toBe(5)
  })

  it('rejects a non-positive cap', () => {
    expect(() => new SampleRing(0)).toThrow()
  })
})

describe('deriveWarn', () => {
  const thresholds = { cpu: 90, mem: 90, disk: 90 }

  it('warns only after the full streak of at-or-above samples', () => {
    const ring = new SampleRing(10)
    ring.push(sample({ cpu: 95 }))
    expect(deriveWarn(ring, thresholds, 3).cpu).toBe(false)
    ring.push(sample({ cpu: 92 }))
    expect(deriveWarn(ring, thresholds, 3).cpu).toBe(false)
    ring.push(sample({ cpu: 91 }))
    expect(deriveWarn(ring, thresholds, 3).cpu).toBe(true)
  })

  it('a single spike followed by a dip never warns', () => {
    const ring = new SampleRing(10)
    ring.push(sample({ cpu: 99 }))
    ring.push(sample({ cpu: 10 }))
    ring.push(sample({ cpu: 99 }))
    expect(deriveWarn(ring, thresholds, 3).cpu).toBe(false)
  })

  it('warns independently per metric', () => {
    const ring = new SampleRing(10)
    for (let i = 0; i < 3; i += 1) ring.push(sample({ cpu: 95, mem: 20, diskBusy: 95 }))
    const warn = deriveWarn(ring, thresholds, 3)
    expect(warn).toEqual({ cpu: true, mem: false, disk: true })
  })

  it('null metrics (disk before first row, CPU before baseline) never warn', () => {
    const ring = new SampleRing(10)
    for (let i = 0; i < 3; i += 1) ring.push(sample({ cpu: null, diskBusy: null }))
    expect(deriveWarn(ring, thresholds, 3)).toEqual({ cpu: false, mem: false, disk: false })
  })
})
