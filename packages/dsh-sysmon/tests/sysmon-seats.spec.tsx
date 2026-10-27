// @vitest-environment jsdom
/**
 * Sysmon seat coordination: the primary header-actions copy and the fallback
 * header-leading copy must never paint together, and the fallback must cover
 * exactly the states where the primary seat is not mounted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { SysmonChip, SysmonFallbackChip } from '../src/client/SysmonChip.tsx'
import { beginPrimary, primaryMounted, subscribePrimary } from '../src/client/presence.ts'
import { zh } from '../src/client/locales.ts'
import type { SysmonKey } from '../src/client/locales.ts'
import type { SysmonPayload } from '../src/core/types.ts'

/** Minimal translate over the zh dictionary. */
function makeTranslate() {
  return (key: string) => zh[key as SysmonKey] ?? key
}

/** One settled host payload so both bodies render values. */
function payload(): SysmonPayload {
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
    },
    warn: { cpu: false, mem: false, disk: false },
    thresholds: { cpu: 90, mem: 90, disk: 90 },
    net: { connMs: 128, connAt: 1_761_330_000_000, connVia: 'direct', ttftMs: null, failures: 0, provider: 'deepseek', warn: false },
  }
}

const chips = () => document.querySelectorAll('[data-dsh-plugin="sysmon"]')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('presence', () => {
  it('counts mounts and disposes back to the starting state', () => {
    expect(primaryMounted()).toBe(false)
    const first = beginPrimary()
    const second = beginPrimary()
    expect(primaryMounted()).toBe(true)
    first()
    expect(primaryMounted()).toBe(true)
    second()
    expect(primaryMounted()).toBe(false)
  })

  it('notifies subscribers on every transition and unsubscribes cleanly', () => {
    const seen: boolean[] = []
    const off = subscribePrimary(() => seen.push(primaryMounted()))
    const dispose = beginPrimary()
    dispose()
    off()
    const late = beginPrimary()
    late()
    expect(seen).toEqual([true, false])
  })
})

describe('seat coordination', () => {
  it('renders the fallback alone while no primary copy is mounted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => payload(),
    })))
    render(<SysmonFallbackChip t={makeTranslate()} />)
    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(screen.getByText('12%')).toBeTruthy()
  })

  it('keeps one copy when both seats mount together, primary first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => payload(),
    })))
    render(
      <>
        <SysmonChip t={makeTranslate()} />
        <SysmonFallbackChip t={makeTranslate()} />
      </>,
    )
    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(screen.getByText('12%')).toBeTruthy()
  })

  it('keeps one copy when both seats mount together, fallback first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => payload(),
    })))
    render(
      <>
        <SysmonFallbackChip t={makeTranslate()} />
        <SysmonChip t={makeTranslate()} />
      </>,
    )
    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(screen.getByText('12%')).toBeTruthy()
  })

  it('hands the header back to the fallback when the primary unmounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => payload(),
    })))
    // Stand-ins for the two real slots: the fallback subtree stays resident
    // across a Session open/close, the primary comes and goes with it.
    function Harness({ primaryOpen }: { primaryOpen: boolean }) {
      return (
        <>
          {primaryOpen && <SysmonChip t={makeTranslate()} />}
          <SysmonFallbackChip t={makeTranslate()} />
        </>
      )
    }
    const view = render(<Harness primaryOpen />)
    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(screen.getByText('12%')).toBeTruthy()
    view.rerender(<Harness primaryOpen={false} />)
    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(screen.getByText('12%')).toBeTruthy()
  })

  it('stays hidden while the primary seat is occupied, then reappears', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => payload(),
    })))
    const primary = render(<SysmonChip t={makeTranslate()} />)
    const fallback = render(<SysmonFallbackChip t={makeTranslate()} />)
    await waitFor(() => expect(chips()).toHaveLength(1))
    primary.unmount()
    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(fallback.container.querySelector('[data-dsh-plugin="sysmon"]')).toBeTruthy()
  })
})
