/**
 * "What has this squad done lately": every run the Host recorded for the
 * squad, newest first - the whole-squad runs AND the single-member runs, which
 * keep the exact behaviour they had in M1 (status label and open-session
 * action; the member card itself is untouched).
 *
 * The list is capped by `RUN_HISTORY_LIMIT` because the Host keeps 200 records:
 * a phone should not lay out a year of history to answer "what happened last".
 */
import type { ReactNode } from 'react'
import { t } from './locales.ts'
import { runKindOf, runStatusLabel, runStatusTone, runTimeIso, runTimeLabel, squadRunsOf } from './runs.ts'
import { SessionRow } from './SessionRow.tsx'
import type { RunRecord, TeamDefinition } from '../protocol.ts'
import css from './agents.module.css'

export interface RunHistoryProps {
  team: TeamDefinition
  /** Every run the Host published; this view selects the squad's own. */
  runs: readonly RunRecord[]
  /** Switch the GUI to an existing session; absent when the deployment has none. */
  openSession?: (sessionId: string) => void
}

/**
 * Render the squad's run history.
 * @param props - the squad, the published runs and the session opener.
 */
export function RunHistory({ team, runs, openSession }: RunHistoryProps): ReactNode {
  const rows = squadRunsOf(runs, team.id)
  return (
    <section className={css.section} data-dsh-part="squad-history" aria-label={t('squad.historyTitle')}>
      <h4 className={css.membersTitle}>{t('squad.historyTitle')}</h4>
      {rows.length === 0 ? (
        <p className={css.emptyHint}>{t('squad.historyEmpty')}</p>
      ) : (
        <ul className={css.runGrid}>
          {rows.map(run => {
            const squad = runKindOf(run) === 'squad'
            const member = squad ? undefined : team.members.find(candidate => candidate.id === run.memberId)
            return (
              <li key={run.id} className={css.memberItem}>
                <SessionRow
                  variant={squad ? 'squad-run' : 'member-run'}
                  title={squad ? t('squad.lead') : member === undefined ? t('squad.memberGone') : member.name}
                  badge={squad ? t('squad.kind.squad') : t('squad.kind.member')}
                  status={{ label: runStatusLabel(run), tone: runStatusTone(run) }}
                  detail={squad && run.goal !== undefined ? t('squad.goalLine', { goal: run.goal }) : undefined}
                  time={{ iso: runTimeIso(run), label: runTimeLabel(run) }}
                  onOpenSession={openSession === undefined ? undefined : () => { openSession(run.sessionId) }}
                  openLabel={t('member.openSession')}
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
