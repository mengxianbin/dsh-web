/**
 * Frozen-open takeover (frozen-open-1123, design §3.5 点开形态): the
 * composer-chain replacement elected for a frozen/locked session. It is the
 * whole "打不进字" face — a dashed readonly card (role=status, zero inputs,
 * zero buttons) carrying the freeze notice, the freeze reason, the task-state
 * snapshot (state + queue tier + §4.2 four-piece — the state-file summary)
 * and the two wake triggers. The election itself hides the resident input
 * bar (chain overlay keeps it mounted, display:none) and outranks the ask
 * card's selector, so the input panel and the ask panel are both
 * unreachable while this entry is elected; non-frozen sessions never elect
 * it, which is the regression-green half of the acceptance.
 * @module @linxin666/dsh-task-fsm/client/FsmFrozenComposer
 */

import { peekFsmView, type FsmSessionView } from './api.ts'
import { t } from './locales.ts'
import css from './fsm.module.css'

/** What the frozen selector matched (selector-owned, pure derivation). */
export interface FsmFrozenMatch {
  /** The bound session this takeover replaces the composer for. */
  sessionId: string
  /** D-axis mode carried by the pending interaction. */
  mode: 'frozen' | 'locked'
  /** Freeze reason (task-fsm-state.json `session.reason`). */
  reason: string
}

/** Chain-entry props this component reads (owner share + matched). */
export interface FsmFrozenComposerProps {
  readonly sessionId?: string
  readonly matched: FsmFrozenMatch
}

/**
 * The read-only snapshot card for one frozen session.
 * @param props - selector-matched freeze identity.
 * @returns the readonly panel (never interactive).
 */
export function FsmFrozenComposer({ matched }: FsmFrozenComposerProps) {
  // The view was fetched before the election could happen (the publish path
  // resolves it), so the cache read is warm by construction; a miss still
  // renders the notice from the interaction itself.
  const view: FsmSessionView | null | undefined = peekFsmView(matched.sessionId)
  const sub = view?.subreasons
  return (
    <div className={css.frozen} role="status" data-fsm-frozen-mode={matched.mode}>
      <div className={css.frozenTitle}>
        <span aria-hidden="true">{matched.mode === 'locked' ? '🔒' : '❄️'}</span>
        <span>{t('fsm.frozen.readonly')}</span>
      </div>
      <div className={css.frozenReason}>
        {t('fsm.freeze.reason')}: {view?.session?.reason || matched.reason || '—'}
      </div>
      {view !== undefined && view !== null && (
        <>
          <div className={css.frozenState}>
            {t('fsm.frozen.state')}: {view.state} · {view.queue.label}
            {view.taskRef !== '' ? ` · ${view.taskRef}` : ''}
          </div>
          {sub !== undefined && (
            <dl className={css.frozenQuad}>
              <dt>{t('fsm.what')}</dt><dd>{sub.what}</dd>
              <dt>{t('fsm.why')}</dt><dd>{sub.why}</dd>
              <dt>{t('fsm.who')}</dt><dd>{sub.who}</dd>
              <dt>{t('fsm.next')}</dt><dd>{sub.next}</dd>
            </dl>
          )}
        </>
      )}
      <div className={css.frozenWake}>{t('fsm.frozen.wake')}</div>
    </div>
  )
}
