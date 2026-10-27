// @vitest-environment jsdom
/** Sysmon header chip: values, warn coloring, the 404 hide contract, the v4 net reading. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { SysmonChip, chipTitle, formatGB, netLine } from '../src/client/SysmonChip.tsx'
import { zh } from '../src/client/locales.ts'
import type { SysmonKey } from '../src/client/locales.ts'
import type { SysmonNet, SysmonPayload } from '../src/core/types.ts'

/** Minimal translate over the zh dictionary. */
function makeTranslate() {
  return (key: string) => zh[key as SysmonKey] ?? key
}

/** The v4 network reading fixtures carry by default: an empty window. */
function netFixture(overrides: Partial<SysmonNet> = {}): SysmonNet {
  return { ttftMs: null, ttftAt: null, failures: 0, provider: null, warn: false, ...overrides }
}

function payload(
  overrides: Partial<NonNullable<SysmonPayload['latest']>> = {},
  warn = { cpu: false, mem: false, disk: false },
  net: SysmonNet = netFixture(),
): SysmonPayload {
  return {
    ok: true,
    at: 1_761_330_000_000,
    latest: {
      t: 1_761_330_000_000,
      cpu: 12.4,
      mem: 61.2,
      memUsedBytes: 9_600_000_000,
      memTotalBytes: 15_700_000_000,
      diskBusy: 8.1,
      diskRead: 1_258_291,
      diskWrite: 419_430,
      ...overrides,
    },
    warn,
    thresholds: { cpu: 90, mem: 90, disk: 90 },
    net,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SysmonChip', () => {
  it('renders the three rounded read-outs from the host payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => payload(),
    })))
    render(<SysmonChip t={makeTranslate()} />)
    await waitFor(() => {
      expect(screen.getByText('12%')).toBeTruthy()
      expect(screen.getByText('61%')).toBeTruthy()
      expect(screen.getByText('8%')).toBeTruthy()
    })
    const chip = screen.getByLabelText(zh['chip.aria'])
    expect(chip.getAttribute('data-dsh-plugin')).toBe('sysmon')
    expect(chip.getAttribute('data-dsh-part')).toBe('chip')
    expect(chip.getAttribute('data-warn')).toBeNull()
  })

  it('reddens warned metrics and lists them in data-warn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => payload({ cpu: 96, mem: 94, diskBusy: 106.3 }, { cpu: false, mem: true, disk: true }),
    })))
    render(<SysmonChip t={makeTranslate()} />)
    await waitFor(() => expect(screen.getByLabelText(zh['chip.aria'])).toBeTruthy())
    const chip = screen.getByLabelText(zh['chip.aria'])
    expect(chip.getAttribute('data-warn')).toBe('mem disk')
    // 106.3 clamps to 100 for display.
    expect(screen.getByText('100%')).toBeTruthy()
    expect(screen.getByText('94%').className).toContain('vWarn')
  })

  it('renders placeholders before the first response', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Promise(() => {})))
    render(<SysmonChip t={makeTranslate()} />)
    expect(screen.getAllByText('—')).toHaveLength(4)
  })

  it('renders the net reading and reddens it when the window holds failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => payload({}, { cpu: false, mem: false, disk: false }, netFixture({ ttftMs: 128.4, ttftAt: 1_761_330_000_000, failures: 3, provider: 'deepseek', warn: true })),
    })))
    render(<SysmonChip t={makeTranslate()} />)
    await waitFor(() => expect(screen.getByText('128ms ⚠3')).toBeTruthy())
    const chip = screen.getByLabelText(zh['chip.aria'])
    expect(chip.getAttribute('data-warn')).toBe('net')
    expect(screen.getByText('128ms ⚠3').className).toContain('vWarn')
    expect(screen.getByText(zh['chip.net'])).toBeTruthy()
  })

  it('shows a bare dash for the net metric when the window is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => payload({}, { cpu: false, mem: false, disk: false }, netFixture()),
    })))
    render(<SysmonChip t={makeTranslate()} />)
    await waitFor(() => expect(screen.getByText('12%')).toBeTruthy())
    // cpu/mem/disk have values; only the net metric falls back to the dash.
    const dashes = screen.getAllByText('—')
    expect(dashes).toHaveLength(1)
    expect(screen.getByLabelText(zh['chip.aria']).getAttribute('data-warn')).toBeNull()
  })

  it('hides itself entirely when the host route 404s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false })))
    const { container } = render(<SysmonChip t={makeTranslate()} />)
    await waitFor(() => expect(container.querySelector('[data-dsh-plugin="sysmon"]')).toBeNull())
  })

  it('keeps the last snapshot when a later poll fails', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      if (call === 1) return { status: 200, ok: true, json: async () => payload() }
      throw new Error('transport down')
    }))
    render(<SysmonChip t={makeTranslate()} />)
    await waitFor(() => expect(screen.getByText('12%')).toBeTruthy())
    // The failing second poll must not clear the rendered values.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(screen.getByText('12%')).toBeTruthy()
  })
})

describe('chipTitle', () => {
  it('joins header, disk, memory and stamp lines with GB and MB/s read-outs', () => {
    const title = chipTitle(payload(), makeTranslate())
    expect(title).toContain(zh['chip.title'])
    expect(title).toContain('1.2')
    expect(title).toContain('0.4')
    expect(title).toContain('8.9')
    expect(title).toContain('14.6')
    expect(title).toContain('5.7')
  })

  it('omits the disk line while disk fields are null', () => {
    const title = chipTitle(payload({ diskBusy: null, diskRead: null, diskWrite: null }), makeTranslate())
    expect(title).not.toContain('MB/s')
  })

  it('falls back to the bare header before the first payload', () => {
    expect(chipTitle(null, makeTranslate())).toBe(zh['chip.title'])
  })

  it('carries the net detail line with route label when observations exist', () => {
    const title = chipTitle(payload({}, undefined, netFixture({ ttftMs: 96, ttftAt: 1_761_330_000_000, failures: 1, provider: 'deepseek', warn: true })), makeTranslate())
    expect(title).toContain('首包 96ms')
    expect(title).toContain('失败 1 次')
    expect(title).toContain('路由 deepseek')
  })
})

describe('netLine', () => {
  it('shows the idle notice when the window holds no observations', () => {
    expect(netLine(netFixture(), makeTranslate())).toBe(zh['chip.netIdle'])
  })

  it('omits the route label when the provider is unknown', () => {
    const line = netLine(netFixture({ ttftMs: 200, ttftAt: 1_761_330_000_000 }), makeTranslate())
    expect(line).toContain('200ms')
    expect(line).not.toContain('路由')
  })

  it('reads dash for latency when only failures landed in the window', () => {
    const line = netLine(netFixture({ failures: 2 }), makeTranslate())
    expect(line).toContain('首包 —')
    expect(line).toContain('2 次')
  })
})

describe('formatGB', () => {
  it('formats bytes as one-decimal gigabytes', () => {
    expect(formatGB(16 * 1024 ** 3)).toBe('16.0')
    expect(formatGB(0)).toBe('0.0')
  })
})
