/**
 * Hover-card lines for one session row (§4.1 queue tier + §4.2 four-piece
 * sub-reasons + §3.1 freeze reason). Renders nothing when the row has no FSM
 * record or the endpoint is unreachable — quiet absence, never a banner.
 * @module @linxin666/dsh-task-fsm/client/FsmHoverLines
 */

import { useEffect, useState } from 'react'
import { lookupFsmView, type FsmSessionView } from './api.ts'
import { t } from './locales.ts'
import css from './fsm.module.css'

/** Props of the hover seat: the row's Session identity (owner share). */
export interface FsmHoverLinesProps {
  readonly sessionId: string
}

function labelFor(view: FsmSessionView): string | undefined {
  if (view.queue.tier === 'red') return t('fsm.tier.red')
  if (view.queue.tier === 'yellow') return t('fsm.tier.yellow')
  return undefined
}

/**
 * The queue/freeze section of the hover card.
 * @param props - owner props from the hover seat.
 * @returns the lines div, or null (quiet absence).
 */
export function FsmHoverLines({ sessionId }: FsmHoverLinesProps) {
  const [view, setView] = useState<FsmSessionView | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void lookupFsmView(sessionId).then((value) => {
      if (live) setView(value)
      return value
    })
    return () => {
      live = false
    }
  }, [sessionId])
  if (view === undefined || view === null) return null

  const frozen = view.session?.mode === 'frozen' || view.session?.mode === 'locked'
  const tier = labelFor(view)
  if (tier === undefined && !frozen) return null

  const { what, why, who, next } = view.subreasons
  return (
    <div className={css.lines} data-fsm-queue={view.queue.tier} data-fsm-state={view.state}>
      {tier !== undefined && (
        <div className={css.tier} data-tier={view.queue.tier}>
          <span className={css.tierBadge}>{tier}</span>
          <span className={css.tierExample}>{view.queue.example}</span>
        </div>
      )}
      {frozen && (
        <div className={css.freezeReason} data-fsm-mode={view.session?.mode}>
          {t('fsm.freeze.reason')}: {view.session?.reason || '—'}
        </div>
      )}
      {(tier !== undefined || frozen) && (
        <dl className={css.quad}>
          <dt>{t('fsm.what')}</dt><dd>{what}</dd>
          <dt>{t('fsm.why')}</dt><dd>{why}</dd>
          <dt>{t('fsm.who')}</dt><dd>{who}</dd>
          <dt>{t('fsm.next')}</dt><dd>{next}</dd>
        </dl>
      )}
    </div>
  )
}
