/**
 * The squad list: the page's landing view, including its empty state.
 *
 * A squad row is one button, so opening a squad is a single tap on a phone;
 * the description is clamped rather than wrapping the grid into a ragged
 * column, and no row carries board metadata (this view has no columns, no drag
 * handles and no bulk actions).
 */
import type { ReactNode } from 'react'
import { t } from './locales.ts'
import type { TeamDefinition } from '../protocol.ts'
import css from './agents.module.css'

export interface SquadListProps {
  teams: readonly TeamDefinition[]
  onOpen: (teamId: string) => void
  onNew: () => void
}

/**
 * Render the squad list or its empty state.
 * @param props - squads to list and the page actions.
 */
export function SquadList({ teams, onOpen, onNew }: SquadListProps): ReactNode {
  return (
    <section className={css.section} data-dsh-part="squad-list">
      <div className={css.sectionHead}>
        <h3 className={css.sectionTitle}>{t('agents.title')}</h3>
        <button type="button" className={css.primary} onClick={onNew}>{t('list.new')}</button>
      </div>
      {teams.length === 0 ? (
        <div className={css.empty} data-dsh-part="squad-empty">
          <p className={css.emptyTitle}>{t('list.empty')}</p>
          <p className={css.emptyHint}>{t('list.emptyHint')}</p>
        </div>
      ) : (
        <ul className={css.squadGrid}>
          {teams.map(team => (
            <li key={team.id} className={css.squadItem}>
              <button
                type="button"
                className={css.squadCard}
                aria-label={t('list.open', { name: team.name })}
                onClick={() => { onOpen(team.id) }}
              >
                <span className={css.squadName}>{team.name}</span>
                <span className={css.squadCount}>{t('list.memberCount', { count: String(team.members.length) })}</span>
                <span className={css.squadDescription}>{team.description === undefined || team.description === '' ? t('list.noDescription') : team.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
