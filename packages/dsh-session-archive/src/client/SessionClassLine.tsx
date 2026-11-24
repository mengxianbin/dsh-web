/**
 * Hover-card session-origin line (hover-sessionclass-1121): the session's
 * attention class — `human` / `bot-boss` / `bot-worker` — read from the
 * row's own list snapshot (the `sessionClass` summary projection,
 * sessionclass-summary-channel-1127) and rendered verbatim after the
 * localized label, replacing harness's hardcoded priority/attribute
 * placeholder. No list hook, no row yet, no record, or a value outside the
 * triclass renders nothing (quiet absence, never a banner).
 *
 * The list shapes are restated structurally rather than imported: this
 * package compiles host and client in one tsc program, and the ui-session /
 * api-session-controller client merges collide with the host `sessions`
 * Context merge inside it (see src/client/index.ts), so the real
 * `SessionListState` is unreachable here — the runtime value is compatible
 * with the shapes below, which is all the selector needs.
 */
import { t } from './locales.ts'
import css from './session-class.module.css'

/** The triclass the attention ledger holds; these spellings render verbatim. */
export type SessionOriginClass = 'human' | 'bot-boss' | 'bot-worker'

/** One row's share of the list snapshot this line reads. */
export interface SessionListRow {
  readonly projectionValues?: Readonly<Record<string, unknown>>
}

/** The list snapshot share the `useSessions` standard hook selects over. */
export interface SessionListRows {
  readonly byId?: Record<string, SessionListRow | undefined>
}

/** The `useSessions` standard prop, restated structurally (see the module doc). */
export type UseSessions = <S>(selector: (state: SessionListRows) => S) => S

/** Props of the hover seat: the row's Session identity (owner share) plus the standard list hook. */
export interface SessionClassLineProps {
  readonly sessionId: string
  /** Standard scope hook; absent in fixtures renders quiet absence. */
  readonly useSessions?: UseSessions
}

/** Narrow one wire value to the triclass; anything else renders nothing. */
function toOriginClass(value: unknown): SessionOriginClass | undefined {
  return value === 'human' || value === 'bot-boss' || value === 'bot-worker' ? value : undefined
}

/**
 * Render the session-type line from the list snapshot; render nothing when
 * the hook is absent, the row (or its `sessionClass` value) has not arrived,
 * or the value falls outside the triclass.
 * @param props - owner props from the hover seat plus the standard list hook.
 * @returns the line div, or null (quiet absence).
 */
export function SessionClassLine({ sessionId, useSessions }: SessionClassLineProps) {
  const sessionClass = useSessions?.((state) =>
    toOriginClass(state.byId?.[sessionId]?.projectionValues?.['sessionClass']))
  if (sessionClass === undefined) return null
  return (
    <div className={css.line} data-session-class={sessionClass}>
      {t('arch.hover.class', { class: sessionClass })}
    </div>
  )
}
