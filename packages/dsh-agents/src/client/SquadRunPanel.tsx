/**
 * The squad's primary action: launch one whole squad as a Lead session.
 *
 * The goal travels in an optional field and rides the wire's `goal`; the Lead
 * preset is a property of the SQUAD on the wire (`TeamDefinition.leadPreset`,
 * read by `POST /squad/run`), so a choice made here is applied by the page
 * before the run - the panel itself only reports what the user asked for.
 *
 * The panel offers the preset list only when the Host reports one
 * (`AgentsStateView.presets`); with no reported list it states the squad's
 * current Lead preset instead of inventing options. Both readings sit in the
 * same labelled row, so a deployment that starts reporting presets moves
 * nothing around them.
 *
 * The success sentence names the Lead session it started; the entry point into
 * that session is the Lead's row in the live roster and in the history below, so
 * the action row never grows a conditional second control that could reflow the
 * panel. The feedback line is a live region that is always mounted with its
 * height reserved, so starting a run never shifts what follows it.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { t } from './locales.ts'
import { SQUAD_GOAL_MAX_LENGTH } from '../protocol.ts'
import type { TeamDefinition } from '../protocol.ts'
import css from './agents.module.css'

/** What the page is asked to run. */
export interface SquadRunRequest {
  /** The goal text, absent when the field was left empty. */
  goal: string | undefined
  /** The Lead preset to apply to the squad before running; absent means "use what the squad pins". */
  leadPreset: string | undefined
}

/** The outcome of one squad-run attempt, shown beside the button. */
export interface SquadNotice {
  kind: 'ok' | 'failed'
  message: string
}

export interface SquadRunPanelProps {
  team: TeamDefinition
  /** Preset ids the Host reports; empty when it reports none. */
  presets: readonly string[]
  busy: boolean
  notice: SquadNotice | undefined
  onRun: (request: SquadRunRequest) => void
}

/**
 * Render the squad-run control.
 * @param props - the squad, the reported presets and the page actions.
 */
export function SquadRunPanel({ team, presets, busy, notice, onRun }: SquadRunPanelProps): ReactNode {
  const [goal, setGoal] = useState('')
  const [leadPreset, setLeadPreset] = useState(team.leadPreset ?? '')
  const submit = (): void => {
    const trimmed = goal.trim()
    onRun({
      goal: trimmed === '' ? undefined : trimmed,
      leadPreset: leadPreset === '' ? undefined : leadPreset,
    })
  }
  const feedback = notice === undefined
    ? css.feedback
    : css.feedback + ' ' + (notice.kind === 'failed' ? css.feedbackError : css.feedbackOk)
  return (
    <form
      className={css.panel}
      data-dsh-part="squad-run"
      onSubmit={(event) => { event.preventDefault(); submit() }}
    >
      <h4 className={css.panelTitle}>{t('squad.runTitle')}</h4>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('squad.goalLabel')}</span>
        <textarea
          className={css.textarea}
          value={goal}
          rows={2}
          maxLength={SQUAD_GOAL_MAX_LENGTH}
          placeholder={t('squad.goalPlaceholder')}
          onChange={(event) => { setGoal(event.target.value) }}
        />
      </label>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('squad.leadPresetLabel')}</span>
        {presets.length === 0 ? (
          <p className={css.fieldValue} data-dsh-part="squad-lead-preset">
            {leadPreset === '' ? t('squad.leadPresetInherit') : leadPreset}
          </p>
        ) : (
          <select
            className={css.input}
            value={leadPreset}
            aria-label={t('squad.leadPresetLabel')}
            onChange={(event) => { setLeadPreset(event.target.value) }}
          >
            <option value="">{t('squad.leadPresetInherit')}</option>
            {presets.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        )}
      </div>
      <div className={css.runActions}>
        <button type="submit" className={css.primary} disabled={busy}>
          {busy ? t('squad.running') : t('squad.run')}
        </button>
      </div>
      <p className={feedback} role="status" data-dsh-part="squad-run-status">{notice === undefined ? '' : notice.message}</p>
    </form>
  )
}
