/**
 * The sysmon chip, rendered into two mutually exclusive header seats: the
 * session-header actions row (primary, immediately right of the agent-preset
 * label) and the always-rendered conversation-header leading cell (fallback,
 * covering the no-session and blank-session states the actions row never
 * mounts for). The shared body polls the host route `api/sysmon/samples` once
 * per second while the tab is visible, reddens any metric the host marks as
 * warned (sustained-streak at threshold; the net reading reddens on windowed
 * network failures), and shows disk throughput, memory absolutes, and the
 * provider-network line in its tooltip. The seats coordinate through
 * {@link ./presence.ts} so exactly one copy paints at a time.
 *
 * Degradation contract (mirrors UsageGlance): a 404 means the host half is
 * off or disabled and the chip hides itself entirely; a transport failure
 * keeps the last snapshot and retries on the next tick; before the first
 * response every value reads `—`.
 * @module dsh-sysmon/client/SysmonChip
 */

import { useEffect, useLayoutEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions hole).
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

/** Full props of the header-actions occupant. */
export type SysmonChipProps = PropsLocale<'sysmon'>

/** Format a local `HH:MM:SS` clock string for the refresh stamp. */
function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Format whole gigabytes with one decimal for the tooltip read-outs. */
export function formatGB(bytes: number): string {
  return (bytes / 1_073_741_824).toFixed(1)
}

/**
 * Build the multi-line tooltip: header, disk throughput, memory absolutes,
 * the network reading (probe round trip + failure count) with its honest
 * measurement note, refresh clock. Disk detail is omitted while the disk
 * fields are null; the net lines appear only when the host serves the
 * network reading, falling back to the idle notice when the window holds no
 * reading at all (no fresh probe round and no counted failures).
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
 * The tooltip's network line: the idle notice when the window holds no
 * reading at all, otherwise the probe round trip + failure count, with the
 * route label when the host knows which route the counted failures came from
 * (the probe itself is route-agnostic).
 * `?? null` tolerates a pre-A-case host that serves no `rttMs` (renders
 * the dash / failures only instead of `NaN`).
 * @param net - the network reading.
 * @param t - the namespace translator.
 * @returns one tooltip line.
 */
export function netLine(net: SysmonNet, t: (key: SysmonKey) => string): string {
  const rtt = net.rttMs ?? null
  if (rtt === null && net.failures === 0) return t('chip.netIdle')
  const detail = t('chip.netDetail')
    .replace('{rtt}', rtt === null ? dash : `${String(Math.round(rtt))}ms`)
    .replace('{failures}', String(net.failures))
  return net.provider === null ? detail : `${detail} · ${t('chip.netProvider').replace('{provider}', net.provider)}`
}

/**
 * The shared chip body: polls the host route and renders the four read-outs
 * (CPU, memory, disk, provider network). Both seats render this component;
 * seat coordination happens in the wrappers.
 * @param props - the shell's locale translator.
 * @returns the chip span, or null when the host route 404s.
 */
function SysmonBody({ t }: SysmonChipProps) {
  const [payload, setPayload] = useState<SysmonPayload | null>(null)
  const [hostOff, setHostOff] = useState(false)

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

  if (hostOff) return null

  const latest = payload?.latest ?? null
  const warn = payload?.warn
  const cpu = latest?.cpu
  const mem = latest?.mem
  const disk = latest?.diskBusy
  const net = payload?.net ?? null
  const warnAttr = warn === undefined
    ? undefined
    : ([warn.cpu && 'cpu', warn.mem && 'mem', warn.disk && 'disk', net?.warn && 'net'].filter(Boolean) as string[]).join(' ') || undefined

  return (
    <span
      className={css.chip}
      data-dsh-plugin="sysmon"
      data-dsh-part="chip"
      data-warn={warnAttr}
      title={chipTitle(payload, t)}
      aria-label={t('chip.aria')}
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
      <span className={css.metric}>
        <span className={css.k}>{t('chip.net')}</span>
        <span className={net?.warn ? `${css.v} ${css.vWarn}` : css.v}>{net === null ? dash : formatNetValue(net)}</span>
      </span>
    </span>
  )
}

/**
 * Primary seat occupant: the session-header actions row. Reports its mount
 * from a layout effect so the fallback seat yields before paint, never after.
 * @param props - the shell's locale translator.
 * @returns the chip body.
 */
export function SysmonChip(props: SysmonChipProps) {
  useLayoutEffect(() => beginPrimary(), [])
  return <SysmonBody {...props} />
}

/**
 * Fallback seat occupant: the conversation-header leading cell, the only
 * header position that exists without a Session and stays rendered while a
 * blank Session hides the actions row. Renders nothing while a primary copy
 * is mounted, so exactly one chip paints at a time.
 * @param props - the shell's locale translator.
 * @returns the chip body, or null while the primary seat is occupied.
 */
export function SysmonFallbackChip({ t }: SysmonChipProps) {
  const [primary, setPrimary] = useState(primaryMounted)
  useLayoutEffect(() => {
    setPrimary(primaryMounted())
    return subscribePrimary(() => { setPrimary(primaryMounted()) })
  }, [])
  if (primary) return null
  return <SysmonBody t={t} />
}
