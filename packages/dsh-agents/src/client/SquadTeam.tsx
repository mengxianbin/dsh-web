/**
 * "What is this squad doing now": the Lead and the teammates the runtime
 * spawned for the newest whole-squad run.
 *
 * The roster comes from the `agentTeam` projection (or, where that surface is
 * out of reach, from the proposed roster route) through `team-source.ts`; this
 * file only joins it with the squad's definitions and renders it. The join key
 * is the teammate NAME: the projection drops the member description, and the
 * Lead names each teammate after the member it was told to spawn. A teammate
 * the Lead named something else keeps its row and reads its pins as inherited.
 *
 * Each row's session entry point is the session id the projection reports, so
 * opening a teammate needs no extra host call. A row's badge names the role it
 * plays and its title names the session the way the Host titled it (the Lead
 * session carries the squad name), so nothing on the row repeats itself.
 */
import type { ReactNode } from 'react'
import { t } from './locales.ts'
import { permissionLabel } from './permissions.ts'
import { SessionRow } from './SessionRow.tsx'
import type { SessionRowFact } from './SessionRow.tsx'
import type { StatusTone } from './runs.ts'
import type { SquadTeamMemberWire, TeamDefinition, MemberDefinition } from '../protocol.ts'
import type { SquadTeamSnapshot } from './team-source.ts'
import css from './agents.module.css'

/** The state one phase reads as. */
const PHASE_TONE: Record<SquadTeamMemberWire['phase'], StatusTone> = {
  provisioning: 'pending',
  active: 'active',
  failed: 'error',
}

const PHASE_KEY = {
  provisioning: 'squad.phase.provisioning',
  active: 'squad.phase.active',
  failed: 'squad.phase.failed',
} as const

/** The member definition a teammate session runs as, when the squad still holds it. */
function definitionFor(team: TeamDefinition, name: string): MemberDefinition | undefined {
  return team.members.find(member => member.name === name)
}

/** The pinned facts of one row; an unpinned value reads as inherited, never blank. */
function factsOf(preset: string | undefined, permission: MemberDefinition['permission'], model: string | undefined): SessionRowFact[] {
  return [
    { label: t('member.preset'), value: preset === undefined || preset === '' ? t('member.inherit') : preset },
    { label: t('member.permission'), value: permissionLabel(permission) },
    { label: t('member.model'), value: model === undefined || model === '' ? t('member.inherit') : model },
  ]
}

export interface SquadTeamSectionProps {
  team: TeamDefinition
  /** The live-team snapshot; undefined while this squad never ran as a whole. */
  snapshot: SquadTeamSnapshot | undefined
  /** Switch the GUI to an existing session; absent when the deployment has none. */
  openSession?: (sessionId: string) => void
}

/**
 * Render the live roster of the newest squad run.
 * @param props - the squad, the live snapshot and the session opener.
 */
export function SquadTeamSection({ team, snapshot, openSession }: SquadTeamSectionProps): ReactNode {
  const header = <h4 className={css.membersTitle}>{t('squad.liveTitle')}</h4>
  if (snapshot === undefined) {
    return (
      <section className={css.section} data-dsh-part="squad-team" aria-label={t('squad.liveTitle')}>
        {header}
        <div className={css.empty}>
          <p className={css.emptyTitle}>{t('squad.liveNoRun')}</p>
          <p className={css.emptyHint}>{t('squad.liveNoRunHint')}</p>
        </div>
      </section>
    )
  }
  if (snapshot.state === 'unavailable') {
    return (
      <section className={css.section} data-dsh-part="squad-team" aria-label={t('squad.liveTitle')}>
        {header}
        <p className={css.runStatus} role="status" data-dsh-part="squad-team-state">{t('squad.liveUnavailable')}</p>
      </section>
    )
  }
  if (snapshot.state === 'error') {
    return (
      <section className={css.section} data-dsh-part="squad-team" aria-label={t('squad.liveTitle')}>
        {header}
        <p className={css.noticeError} role="alert" data-dsh-part="squad-team-state">{snapshot.message}</p>
      </section>
    )
  }
  if (snapshot.state === 'pending') {
    return (
      <section className={css.section} data-dsh-part="squad-team" aria-label={t('squad.liveTitle')}>
        {header}
        <p className={css.runStatus} role="status" data-dsh-part="squad-team-state">{t('squad.livePending')}</p>
      </section>
    )
  }
  return (
    <section className={css.section} data-dsh-part="squad-team" aria-label={t('squad.liveTitle')}>
      {header}
      {snapshot.failure === undefined ? null : (
        <p className={css.noticeError} role="alert">{t('squad.liveFailure', { detail: snapshot.failure })}</p>
      )}
      <ul className={css.teamGrid}>
        {snapshot.rows.map(row => {
          const definition = row.role === 'lead' ? undefined : definitionFor(team, row.name)
          return (
            <li key={row.id} className={css.memberItem}>
              <SessionRow
                variant={row.role}
                title={row.role === 'lead' ? team.name : row.name}
                badge={row.role === 'lead' ? t('squad.lead') : t('squad.teammate')}
                status={{ label: t(PHASE_KEY[row.phase]), tone: PHASE_TONE[row.phase] }}
                facts={row.role === 'lead'
                  ? factsOf(team.leadPreset, undefined, undefined)
                  : factsOf(definition?.preset, definition?.permission, definition?.model)}
                detail={row.error}
                onOpenSession={openSession === undefined ? undefined : () => { openSession(row.id) }}
                openLabel={t('member.openSession')}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}
