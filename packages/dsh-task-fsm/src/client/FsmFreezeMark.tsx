/**
 * Leading-seat freeze mark (§3.1): ❄️ for an event wait (frozen), 🔒 for a
 * locked wait. The title attribute carries the freeze reason, so hovering the
 * mark itself answers "why is this frozen" (判据源 = `direction-close`
 * custom 原话「冻结会话，hover 需要显示 冻结原因」) — the hover card line
 * carries the same reason one surface down. Quiet absence without a record.
 * @module @linxin666/dsh-task-fsm/client/FsmFreezeMark
 */

import { useEffect, useState } from 'react'
import { lookupFsmView, type FsmSessionView } from './api.ts'
import { t } from './locales.ts'
import css from './fsm.module.css'

/** Props of the leading seat: the row's Session identity (owner share). */
export interface FsmFreezeMarkProps {
  readonly sessionId: string
}

/**
 * The ❄️/🔒 mark in the row's leading cell.
 * @param props - owner props from the leading seat.
 * @returns the mark span, or null (no FSM record / not frozen / unreachable).
 */
export function FsmFreezeMark({ sessionId }: FsmFreezeMarkProps) {
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
  const mode = view.session?.mode
  if (mode !== 'frozen' && mode !== 'locked') return null
  const icon = mode === 'locked' ? '🔒' : '❄️'
  const label = mode === 'locked' ? t('fsm.locked') : t('fsm.frozen')
  const reason = view.session?.reason || '—'
  return (
    <span
      className={css.mark}
      data-fsm-mode={mode}
      role="img"
      aria-label={`${label}: ${reason}`}
      title={`${label} — ${reason}`}
    >
      {icon}
    </span>
  )
}
