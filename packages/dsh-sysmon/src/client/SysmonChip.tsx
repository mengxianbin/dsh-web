/**
 * The sysmon surface, seated in three places: the composer row's trailing
 * seat (primary — the four read-outs at the right end of the row below the
 * composer card, after the context meter), the session header's utilities
 * (the glance wall clock, left of the open-in-app control), and the
 * always-rendered conversation-header leading cell (fallback, covering the
 * no-session, blank-session, and single-View states the composer row never
 * mounts for). The shared body polls the host route `api/sysmon/samples`
 * once per second while the tab is visible, reddens any CPU/memory/disk
 * metric the host marks as warned (sustained-streak at threshold — the net
 * reading never reddens: its failure count left the display on 2026-10-28),
 * and shows disk throughput, memory absolutes, and the probe round-trip line
 * in its tooltip. The seats coordinate through {@link ./presence.ts} so
 * exactly one chip paints at a time.
 *
 * The wall clock (`MM-DD HH:MM`, 2026-10-29 ruling: fullscreen work hides
 * the OS taskbar clock) splits out of the chip body into its own component
 * with its own 1s timer rather than the payload: open Sessions read it from
 * the header utilities, and the fallback copy carries it where no utilities
 * row renders, so a dead host never stops time.
 *
 * Tooltip stability: the payload ticks every second, and mutating a native
 * `title` attribute under the pointer dismisses the browser tooltip (the
 * flicker users saw). While hovered the title snapshot is frozen; leaving
 * resumes the live title on the next payload.
 *
 * Degradation contract (mirrors UsageGlance): a 404 means the host half is
 * off or disabled and the read-outs hide themselves entirely — the clock is
 * not payload-fed, so it keeps walking (the 2026-10-29 always-visible ruling
 * outranks the old die-with-the-chip cost); a transport failure keeps the
 * last snapshot and retries on the next tick; before the first response
 * every value reads `—`.
 * @module dsh-sysmon/client/SysmonChip
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header holes).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { clampBusy, formatMBps } from '../core/sample.ts'
import { formatNetValue } from '../core/net.ts'
import type { SysmonNet, SysmonPayload } from '../core/types.ts'
import { beginPrimary, primaryMounted, subscribePrimary } from './presence.ts'
import type { SysmonKey } from './locales.ts'
import css from './sysmon.module.css'

/** Poll cadence: matches the host's 1s sampling tick. */
const POLL_MS = 1_000

/** Request ceiling: a stalled host must not pile up chip fetches. */
const FETCH_TIMEOUT_MS = 3_000

/** The no-reading placeholder every metric falls back to. */
const dash = '—'

/** Full props of every sysmon seat occupant (chip copies and the clock). */
export type SysmonChipProps = PropsLocale<'sysmon'>

/** Format a local `HH:MM:SS` clock string for the refresh stamp. */
function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Format the local wall clock as `MM-DD HH:MM` for the trailing clock cell.
 * Deliberately minute-precision (2026-10-29 ask, format ruling): the cell is a
 * glance replacement for the OS taskbar clock, so seconds would only add
 * per-second motion to a value nobody reads.
 * @param at - epoch milliseconds (local timezone, matching the OS clock).
 * @returns the `MM-DD HH:MM` string.
 */
export function formatDayTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The wall-clock tick (2026-10-29 ruling: fullscreen work hides the OS
 * taskbar clock). Its own 1s timer, never the payload: a transport failure
 * stops payload updates, and a frozen clock is worse than none — it lies.
 * The state holds the minute-precision string, so the per-second tick that
 * finds the minute unchanged bails out of the render (Object.is) and the
 * cell only repaints when it actually reads differently. Paused while the
 * tab is hidden and re-synced on return so a backgrounded tab never paints
 * a stale minute.
 * @returns the current `MM-DD HH:MM` string, re-rendering on minute changes.
 */
function useDayTime(): string {
  const [dayTime, setDayTime] = useState(() => formatDayTime(Date.now()))
  useEffect(() => {
    const tick = (): void => { setDayTime(formatDayTime(Date.now())) }
    const timer = window.setInterval(() => {
      if (window.document.visibilityState === 'visible') tick()
    }, POLL_MS)
    const onVisibility = (): void => {
      if (window.document.visibilityState === 'visible') tick()
    }
    window.document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      window.document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  return dayTime
}

/**
 * The in-chip wall-clock cell (the fallback copy's trailing cell): no key
 * label — `MM-DD HH:MM` reads unambiguously and the cell keeps its width
 * when the container query strips the unit labels at narrow row widths.
 * @returns the trailing metric cell.
 */
function ClockCell() {
  const dayTime = useDayTime()
  return (
    <span className={css.metric}>
      <span className={css.v}>{dayTime}</span>
    </span>
  )
}

/** Format whole gigabytes with one decimal for the tooltip read-outs. */
export function formatGB(bytes: number): string {
  return (bytes / 1_073_741_824).toFixed(1)
}

/**
 * Build the multi-line tooltip: header, disk throughput, memory absolutes,
 * the network reading (probe round trip only — the 10-minute failure count
 * left the display on 2026-10-28) with its honest measurement note, refresh
 * clock. Disk detail is omitted while the disk fields are null; the net
 * lines appear only when the host serves the network reading, falling back
 * to the idle notice when the window holds no fresh probe round.
 * @param payload - the last successful host document.
 * @param t - the namespace translator.
 * @returns the title string.
 */
export function chipTitle(payload: SysmonPayload | null, t: (key: SysmonKey) => string): string {
  if (payload === null || payload.latest === null) return t('chip.title')
  const { latest, net } = payload
  const lines = [t('chip.title')]
  if (latest.diskRead !== null && latest.diskWrite !== null) {
    lines.push(t('chip.diskDetail')
      .replace('{read}', formatMBps(latest.diskRead))
      .replace('{write}', formatMBps(latest.diskWrite)))
  }
  lines.push(t('chip.memDetail')
    .replace('{used}', formatGB(latest.memUsedBytes))
    .replace('{total}', formatGB(latest.memTotalBytes))
    .replace('{avail}', formatGB(latest.memTotalBytes - latest.memUsedBytes)))
  // net is absent while a pre-v4 host serves this client: the restart window
  // between bundle build and host reload. Omit the line, keep the render alive.
  if (net !== undefined) {
    lines.push(netLine(net, t))
    // Judge source 2026-10-28 (ask `net-quality-semantics`, A-case): the
    // tooltip must state what the number measures — a bare ICMP round trip
    // to the fixed reference target — so it is never read as a handshake or
    // end-to-end request time.
    if ((net.rttMs ?? null) !== null && (net.probe ?? null) !== null) {
      lines.push(t('chip.netPath').replace('{target}', net.probe as string))
    }
  }
  lines.push(t('chip.stamp').replace('{t}', formatClock(payload.at)))
  return lines.join('\n')
}

/**
 * The tooltip's network line: the idle notice when the window holds no fresh
 * probe round, otherwise the probe round trip alone. The windowed failure
 * count and the route label are deliberately absent — judge source 2026-10-28
 * display ruling ("彻底撤"): a ten-minute window cannot show the present
 * state, so no failure number appears anywhere in the display. `?? null`
 * tolerates a pre-A-case host that serves no `rttMs` (renders the dash
 * instead of `NaN`).
 * @param net - the network reading.
 * @param t - the namespace translator.
 * @returns one tooltip line.
 */
export function netLine(net: SysmonNet, t: (key: SysmonKey) => string): string {
  const rtt = net.rttMs ?? null
  if (rtt === null) return t('chip.netIdle')
  return t('chip.netDetail').replace('{rtt}', `${String(Math.round(rtt))}ms`)
}

/** Which seat a chip copy paints: the dock copy sheds the pill fill, the header fallback keeps it. */
type SysmonSeat = 'dock' | 'header'

/** Full props of the shared chip body. */
interface SysmonBodyProps extends SysmonChipProps {
  /** Seat styling: the composer-dock copy drops the pill fill for the row's quiet reading style. */
  seat: SysmonSeat
  /** Whether the wall-clock cell rides this copy (the fallback's, since open Sessions read the clock from the header utilities). */
  clock: boolean
}

/**
 * The shared chip body: polls the host route and renders the four read-outs
 * (CPU, memory, disk, probe round trip). Both seats render this component;
 * seat coordination happens in the wrappers. The wall clock is a separate
 * cell only the fallback copy carries (the utilities own it for open
 * Sessions) — see {@link useDayTime}.
 * @param props - the shell's locale translator, the seat styling, and
 *   whether the clock cell rides this copy.
 * @returns the chip span, the standalone fallback clock while the host
 *   route 404s, or null when the host is off and no clock applies.
 */
function SysmonBody({ t, seat, clock }: SysmonBodyProps) {
  const [payload, setPayload] = useState<SysmonPayload | null>(null)
  const [hostOff, setHostOff] = useState(false)

  // Freeze the native title while hovered (2026-10-28 flicker fix): the
  // payload re-renders the chip every second, and rewriting `title` under the
  // pointer dismisses the browser tooltip, so it blinked once per second and
  // never stayed readable. While hovered the snapshot below is not written;
  // leave resumes the live title from the latest payload. (Hooks live above
  // the 404 early-return — hook order must not depend on hostOff.)
  const [title, setTitle] = useState(() => chipTitle(null, t))
  const hoveredRef = useRef(false)
  const liveTitle = chipTitle(payload, t)
  useEffect(() => {
    if (!hoveredRef.current) setTitle(liveTitle)
  }, [liveTitle])

  useEffect(() => {
    let alive = true
    let seq = 0
    const load = async (): Promise<void> => {
      const mine = ++seq
      try {
        // Document-relative: the GUI serves under <base href="./"> (issue #1707).
        const response = await fetch('api/sysmon/samples', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (response.status === 404) {
          if (alive && mine === seq) setHostOff(true)
          return
        }
        if (!response.ok) throw new Error('sysmon ' + String(response.status))
        const doc = await response.json() as SysmonPayload
        if (!alive || mine !== seq) return
        setPayload(doc)
        setHostOff(false)
      } catch {
        // Keep the last snapshot; the next tick retries.
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (window.document.visibilityState === 'visible') void load()
    }, POLL_MS)
    const onVisibility = (): void => {
      if (window.document.visibilityState === 'visible') void load()
    }
    window.document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // Clock tick lives in useDayTime above: its own 1s timer, never the
  // payload, so a dead host never stops time.

  if (hostOff) {
    // Host off (route 404): the read-outs hide with it, but the fallback
    // copy still owes its states a clock — time is not payload-fed.
    return clock ? <SysmonClock t={t} /> : null
  }

  const latest = payload?.latest ?? null
  const warn = payload?.warn
  const cpu = latest?.cpu
  const mem = latest?.mem
  const disk = latest?.diskBusy
  const net = payload?.net ?? null
  // The net key is absent from data-warn by design: its red state left the
  // display with the failure count (2026-10-28 ruling). The host payload may
  // still carry net.warn — the chip just does not paint it.
  const warnAttr = warn === undefined
    ? undefined
    : ([warn.cpu && 'cpu', warn.mem && 'mem', warn.disk && 'disk'].filter(Boolean) as string[]).join(' ') || undefined

  return (
    <span
      className={seat === 'dock' ? `${css.chip} ${css.chipDock}` : css.chip}
      data-dsh-plugin="sysmon"
      data-dsh-part="chip"
      data-warn={warnAttr}
      title={title}
      aria-label={t('chip.aria')}
      onMouseEnter={() => { hoveredRef.current = true }}
      onMouseLeave={() => {
        hoveredRef.current = false
        setTitle(chipTitle(payload, t))
      }}
    >
      <span className={css.metric}>
        <span className={css.k}>{t('chip.cpu')}</span>
        <span className={warn?.cpu ? `${css.v} ${css.vWarn}` : css.v}>{cpu == null ? dash : `${String(Math.round(cpu))}%`}</span>
      </span>
      <span className={css.sep} aria-hidden="true" />
      <span className={css.metric}>
        <span className={css.k}>{t('chip.mem')}</span>
        <span className={warn?.mem ? `${css.v} ${css.vWarn}` : css.v}>{mem == null ? dash : `${String(Math.round(mem))}%`}</span>
      </span>
      <span className={css.sep} aria-hidden="true" />
      <span className={css.metric}>
        <span className={css.k}>{t('chip.disk')}</span>
        <span className={warn?.disk ? `${css.v} ${css.vWarn}` : css.v}>{disk == null ? dash : `${String(clampBusy(disk))}%`}</span>
      </span>
      <span className={css.sep} aria-hidden="true" />
      <span className={`${css.metric} ${css.metricNet}`}>
        <span className={css.k}>{t('chip.net')}</span>
        {/* Never warns: the net red state left the display with the failure
            count (2026-10-28 ruling); only the probe round trip renders. */}
        <span className={css.v}>{net === null ? dash : formatNetValue(net)}</span>
      </span>
      {clock ? (
        <>
          <span className={css.sep} aria-hidden="true" />
          {/* Trailing wall clock (2026-10-29 ruling): the F11-fullscreen work
              mode hides the OS taskbar, so the glance clock lives here. No key
              label — `MM-DD HH:MM` reads unambiguously and the cell keeps its
              width when the container query strips the unit labels at narrow
              row widths. Open Sessions read the clock from the header
              utilities instead; this cell is the fallback copy's. */}
          <ClockCell />
        </>
      ) : null}
    </span>
  )
}

/**
 * Primary seat occupant: the composer row's trailing seat, at the right end
 * of the row below the composer card (after the context meter). Reports its
 * mount from a layout effect so the fallback seat yields before paint, never
 * after. Carries no clock cell — the header utilities own the wall clock
 * while a Session's title row renders.
 * @param props - the shell's locale translator.
 * @returns the chip body.
 */
export function SysmonChip(props: SysmonChipProps) {
  useLayoutEffect(() => beginPrimary(), [])
  return <SysmonBody {...props} seat="dock" clock={false} />
}

/**
 * Utilities clock seat occupant: the session header's right-hand utilities,
 * left of the open-in-app control. Its own 1s timer and no payload fetch, so
 * it keeps walking while the host half is off (the 2026-10-29
 * always-visible-clock ruling outranks the old die-with-the-chip cost) and
 * repaints only when the minute string changes.
 * @param props - the shell's locale translator.
 * @returns the clock read-out.
 */
export function SysmonClock({ t }: SysmonChipProps) {
  const dayTime = useDayTime()
  return (
    <span
      className={css.clock}
      data-dsh-plugin="sysmon"
      data-dsh-part="clock"
      aria-label={t('clock.aria')}
    >
      <span className={css.v}>{dayTime}</span>
    </span>
  )
}

/**
 * Fallback seat occupant: the conversation-header leading cell, the only
 * header position that exists without a Session and stays rendered while a
 * blank Session header hides the utilities row. Renders nothing while a
 * primary copy is mounted, so exactly one chip paints at a time. Carries the
 * wall-clock cell itself, because these states have no utilities row to read
 * it from.
 * @param props - the shell's locale translator.
 * @returns the chip body with its clock, or null while the primary seat is
 *   occupied.
 */
export function SysmonFallbackChip({ t }: SysmonChipProps) {
  const [primary, setPrimary] = useState(primaryMounted)
  useLayoutEffect(() => {
    setPrimary(primaryMounted())
    return subscribePrimary(() => { setPrimary(primaryMounted()) })
  }, [])
  if (primary) return null
  return <SysmonBody t={t} seat="header" clock />
}
