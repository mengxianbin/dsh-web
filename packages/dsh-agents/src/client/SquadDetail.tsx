/**
 * The squad detail page.
 *
 * A squad page answers four questions, in this order: what this squad is (name,
 * workspace, description), what it is doing now (the whole-squad run control,
 * then the live roster the run spawned), who is in it (the member cards), and
 * what it did lately (the run history). The run control is the page's primary
 * action; every destructive action sits alone in a footer row below the
 * history, so nothing competes with starting the squad.
 *
 * It is presentational as well - every action is a callback the page wires to
 * the transport - so a failure the page reports lands on the card or panel it
 * belongs to instead of replacing the whole view.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { t } from './locales.ts'
import { latestRunFor } from './runs.ts'
import { MemberCard } from './MemberCard.tsx'
import type { MemberNotice } from './MemberCard.tsx'
import { SquadRunPanel } from './SquadRunPanel.tsx'
import type { SquadNotice, SquadRunRequest } from './SquadRunPanel.tsx'
import { SquadTeamSection } from './SquadTeam.tsx'
import { RunHistory } from './RunHistory.tsx'
import type { SquadTeamSnapshot } from './team-source.ts'
import type { RunRecord, TeamDefinition } from '../protocol.ts'
import css from './agents.module.css'

/** Everything the detail view can ask the page to do. */
export interface SquadActions {
  back(): void
  editTeam(): void
  deleteTeam(): void
  addMember(): void
  editMember(memberId: string): void
  deleteMember(memberId: string): void
  run(memberId: string): void
  /** Launch the whole squad as one Lead session. */
  runSquad(request: SquadRunRequest): void
  openSession?: (sessionId: string) => void
}

export interface SquadDetailProps {
  team: TeamDefinition
  /** Every run the Host published; each view picks its own rows. */
  runs: readonly RunRecord[]
  /** A page-level action is in flight. */
  busy: boolean
  notice: MemberNotice | undefined
  /** The outcome of the last squad-run attempt. */
  squadNotice: SquadNotice | undefined
  /** Agent preset ids the Host reports; empty when it reports none. */
  presets: readonly string[]
  /** Live team of the newest squad run, or undefined while the squad never ran as a whole. */
  teamView: SquadTeamSnapshot | undefined
  actions: SquadActions
}

/**
 * Render the squad detail page.
 * @param props - the squad, the run list, the live team and the page actions.
 */
export function SquadDetail({ team, runs, busy, notice, squadNotice, presets, teamView, actions }: SquadDetailProps): ReactNode {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const description = team.description ?? ''
  return (
    <section className={css.section} data-dsh-part="squad-detail">
      <div className={css.detailHead}>
        <button type="button" className={css.secondary} onClick={actions.back}>{t('detail.back')}</button>
        <div className={css.detailTitle}>
          <h3 className={css.sectionTitle}>{team.name}</h3>
          <p className={css.detailWorkspace}>{team.workspaceId === undefined || team.workspaceId === '' ? t('detail.noWorkspace') : t('detail.workspace', { name: team.workspaceId })}</p>
        </div>
        <button type="button" className={css.secondary} disabled={busy} onClick={actions.editTeam}>{t('detail.editTeam')}</button>
      </div>
      {description === '' ? null : <p className={css.detailDescription} data-dsh-part="squad-description">{description}</p>}

      <SquadRunPanel
        team={team}
        presets={presets}
        busy={busy}
        notice={squadNotice}
        onRun={actions.runSquad}
      />

      <div className={css.sectionHead}>
        <h4 className={css.membersTitle}>{t('detail.members')}</h4>
        <button type="button" className={css.secondary} onClick={actions.addMember}>{t('detail.addMember')}</button>
      </div>
      {team.members.length === 0 ? (
        <div className={css.empty} data-dsh-part="member-empty">
          <p className={css.emptyTitle}>{t('detail.membersEmpty')}</p>
          <p className={css.emptyHint}>{t('detail.membersEmptyHint')}</p>
        </div>
      ) : (
        <ul className={css.memberGrid}>
          {team.members.map(member => (
            <li key={member.id} className={css.memberItem}>
              <MemberCard
                member={member}
                run={latestRunFor(runs, team.id, member.id)}
                busy={busy}
                notice={notice !== undefined && notice.memberId === member.id ? notice : undefined}
                onRun={() => { actions.run(member.id) }}
                onOpenSession={actions.openSession}
                onEdit={() => { actions.editMember(member.id) }}
                onDelete={() => { actions.deleteMember(member.id) }}
              />
            </li>
          ))}
        </ul>
      )}

      <SquadTeamSection team={team} snapshot={teamView} openSession={actions.openSession} />
      <RunHistory team={team} runs={runs} openSession={actions.openSession} />

      <div className={css.dangerZone}>
        {confirmingDelete ? (
          <>
            <button type="button" className={css.danger} disabled={busy} onClick={() => { setConfirmingDelete(false); actions.deleteTeam() }}>
              {t('detail.deleteTeamConfirm')}
            </button>
            <button type="button" className={css.secondary} onClick={() => { setConfirmingDelete(false) }}>{t('detail.cancel')}</button>
          </>
        ) : (
          <button type="button" className={css.secondary} disabled={busy} onClick={() => { setConfirmingDelete(true) }}>{t('detail.deleteTeam')}</button>
        )}
      </div>
    </section>
  )
}
