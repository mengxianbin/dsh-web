/**
 * Agents settings card: the one switch this plugin exposes to the settings
 * page, whether its announcement joins every agent system prompt.
 *
 * The master switch stays on the plugin's profile row (schema key `enabled`),
 * so this card carries no editable copy of it: two controls for one field would
 * compete over which write wins. A read-only note says what that switch governs
 * instead.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { BooleanField, PluginSettingsCard } from './PluginSettingsCard.tsx'
import { SquadMark } from './SquadMark.tsx'
import css from './settings-card.module.css'
import { CardForm, booleanField, type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts'

/** The agents fields this card edits. */
export interface AgentsSettings {
  /** Whether the plugin announces itself in every agent's system prompt. */
  announceToAgent?: boolean
}

/** What the agents card renders. */
export interface AgentsSettingsCardState extends CardShell {
  announceToAgent: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface AgentsSettingsCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useAgentsSettingsCard. */
    agentsSettingsCard: SnapshotStore<AgentsSettingsCardState>
  }
}

/** Bridges the `dsh-agents` settings form onto the card's staged form. */
export class AgentsSettingsCardController {
  private readonly form: CardForm<AgentsSettings>
  private readonly store: SnapshotStore<AgentsSettingsCardState>

  /** @param scope - the bound configuration form of the entry that owns this namespace. */
  constructor(scope: ConfigForm<AgentsSettings>) {
    this.form = new CardForm(scope, [booleanField('announceToAgent')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): AgentsSettingsCardState {
    return {
      ...this.form.shell(),
      announceToAgent: this.form.field('announceToAgent'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): AgentsSettingsCardFace {
    return { hooks: { agentsSettingsCard: this.store }, ...this.form.actions() }
  }

  /** Release the card's scope subscription and bound stores. */
  dispose(): void {
    this.form.dispose()
  }
}

/** Props the renderer binds for the agents card. */
export type AgentsSettingsCardProps =
  PropsRuntime<'web-ui.plugin.item'>
  & PropsLocale<'dsh-agents'>
  & InjectFace<AgentsSettingsCardFace>

/**
 * Render the agents card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function AgentsSettingsCard(props: AgentsSettingsCardProps) {
  const { t } = props
  const state = props.useAgentsSettingsCard((snapshot: AgentsSettingsCardState) => snapshot)
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidValue'),
    disabled: !state.writable,
    inheritLabel: t('settings.inherit'),
  }
  return (
    <PluginSettingsCard
      t={t}
      titleKey="settings.title"
      descriptionKey="settings.description"
      icon={<SquadMark />}
      defaultOpen={false}
      state={state}
      renderChildrenWhenNotExposed
      hideNotExposedNotice
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={css.field}>
        <p className={css.hint}>{t('settings.enabledNote')}</p>
      </div>
      <BooleanField
        id="settings-agents-announce"
        label={t('settings.announceToAgent')}
        hint={t('settings.announceToAgentHint')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.announceToAgent}
        onEdit={(text) => { props.edit('announceToAgent', text) }}
        onReset={() => { props.resetField('announceToAgent') }}
      />
    </PluginSettingsCard>
  )
}
