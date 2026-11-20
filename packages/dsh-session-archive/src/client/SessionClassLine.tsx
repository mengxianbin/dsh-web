/**
 * Hover-card session-origin line (hover-sessionclass-1121): the session's
 * attention class — `human` / `bot-boss` / `bot-worker` — rendered verbatim
 * after the localized label, replacing harness's hardcoded priority/attribute
 * placeholder. Missing ledger record or unreachable endpoint renders nothing.
 */
import { useEffect, useState } from 'react'
import { lookupSessionClass, type SessionOriginClass } from './session-class.ts'
import { t } from './locales.ts'
import css from './session-class.module.css'

/** Props of the hover seat: the row's Session identity (owner share). */
export interface SessionClassLineProps {
  readonly sessionId: string
}

/**
 * Render the session-type line once its class resolves; render nothing while
 * pending, when the ledger has no record, or when the endpoint is unreachable.
 * @param props - owner props from the hover seat.
 * @returns the line div, or null (quiet absence).
 */
export function SessionClassLine({ sessionId }: SessionClassLineProps) {
  const [sessionClass, setSessionClass] = useState<SessionOriginClass | undefined>(undefined)
  useEffect(() => {
    let live = true
    void lookupSessionClass(sessionId).then((value) => {
      if (live) setSessionClass(value)
    })
    return () => {
      live = false
    }
  }, [sessionId])
  if (sessionClass === undefined) return null
  return (
    <div className={css.line} data-session-class={sessionClass}>
      {t('arch.hover.class', { class: sessionClass })}
    </div>
  )
}
