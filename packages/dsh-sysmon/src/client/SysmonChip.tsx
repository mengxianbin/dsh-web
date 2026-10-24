/**
 * The sysmon session-header chip: one compact row of CPU / memory / disk
 * read-outs registered into the conversation session header's actions slot,
 * immediately right of the agent-preset label. It polls the host route
 * `api/sysmon/samples` once per second while the tab is visible, reddens any
 * metric the host marks as warned (sustained-streak at threshold), and shows
 * disk throughput plus memory absolutes in its tooltip.
 *
 * Degradation contract (mirrors UsageGlance): a 404 means the host half is
 * off or disabled and the chip hides itself entirely; a transport failure
 * keeps the last snapshot and retries on the next tick; before the first
 * response every value reads `—`.
 * @module dsh-sysmon/client/SysmonChip
 */

import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions hole).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { clampBusy, formatMBps } from '../core/sample.ts'
import type { SysmonPayload } from '../core/types.ts'
import type { SysmonKey } from './locales.ts'
import css from './sysmon.module.css'

/** Poll cadence: matches the host's 1s sampling tick. */
const POLL_MS = 1_000

/** Request ceiling: a stalled host must not pile up chip fetches. */
const FETCH_TIMEOUT_MS = 3_000

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
 * refresh clock. Disk detail is omitted while the disk fields are null.
 * @param payload - the last successful host document.
 * @param t - the namespace translator.
 * @returns the title string.
 */
export function chipTitle(payload: SysmonPayload | null, t: (key: SysmonKey) => string): string {
  if (payload === null || payload.latest === null) return t('chip.title')
  const { latest } = payload
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
  lines.push(t('chip.stamp').replace('{t}', formatClock(payload.at)))
  return lines.join('\n')
}

/**
 * Render the sysmon chip (or nothing while the host half is off).
 * @param props - the shell's locale translator.
 * @returns the chip span, or null when the host route 404s.
 */
export function SysmonChip({ t }: SysmonChipProps) {
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
  const dash = '—'
  const cpu = latest?.cpu
  const mem = latest?.mem
  const disk = latest?.diskBusy
  const warnAttr = warn === undefined
    ? undefined
    : ([warn.cpu && 'cpu', warn.mem && 'mem', warn.disk && 'disk'].filter(Boolean) as string[]).join(' ') || undefined

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
    </span>
  )
}
