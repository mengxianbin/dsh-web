/**
 * The two edit forms of the agents page: squad details and member details.
 *
 * Both are plain forms with local state and no dialog chrome, so they read the
 * same on a 360px phone as on a desktop column. Optional fields travel as
 * empty strings when the user submits - leaving them empty is how a member
 * asks the Host to inherit its default, and clearing an existing value has to
 * be expressible too.
 *
 * The member's permission, model and reasoning effort are PICKERS, never text
 * boxes: every one of them stores an id the Host resolves later, and free
 * typing is exactly how a member ends up pinning an id no Host will honour. The
 * model and effort rows come from the catalog the Host publishes, and the
 * inherit row is the first one in each.
 *
 * The squad workspace follows the same rule and is ALWAYS a picker, even on a
 * Host that reports no registry: binding none is a first-class choice that runs
 * the squad in the Host default session directory, so the field never falls
 * back to a text box that asks the user to type an id.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { t } from './locales.ts'
import { effortLevels, effortRows, modelDeclaresNoLevels, modelRows } from './model-options.ts'
import { PERMISSION_MODES, permissionLabel } from './permissions.ts'
import { DESCRIPTION_MAX_LENGTH } from '../protocol.ts'
import type { AgentsModelOption, AgentsWorkspaceOption, MemberDraft, MemberDefinition, AgentsPermission, TeamDefinition, TeamDraft } from '../protocol.ts'
import css from './agents.module.css'

/**
 * The full-draft view of one squad.
 *
 * The Host replaces every editable field with what a `POST /team` draft carries:
 * a field the draft omits is cleared, not preserved. Anything that saves a squad
 * therefore starts from this function, so an action that only changes one field
 * cannot silently drop the workspace pin, the Lead preset or the sort order.
 * @param team - the current squad.
 * @param overrides - fields the caller is changing; an explicit `undefined`
 *   clears that field.
 */
export function teamDraftOf(team: TeamDefinition, overrides?: { leadPreset?: string }): TeamDraft {
  const leadPreset = overrides !== undefined && 'leadPreset' in overrides ? overrides.leadPreset : team.leadPreset
  return {
    id: team.id,
    name: team.name,
    ...(team.description === undefined ? {} : { description: team.description }),
    ...(team.workspaceId === undefined ? {} : { workspaceId: team.workspaceId }),
    ...(leadPreset === undefined ? {} : { leadPreset }),
    ...(team.order === undefined ? {} : { order: team.order }),
  }
}

/** What the description button asks the page for. */
export interface DescribeDraft {
  /** The squad name the description has to fit. */
  name: string
  /** The user's rough intent, when they wrote one. */
  intent?: string
}

export interface TeamFormProps {
  /** The squad being edited; omitted when creating one. */
  team: TeamDefinition | undefined
  busy: boolean
  /** Agent preset ids the Host reports; empty when it reports none. */
  presets: readonly string[]
  /** Host workspaces to pin; empty when the Host reports none. */
  workspaces: readonly AgentsWorkspaceOption[]
  /**
   * Draft a description with the Host's model. Absent when this page cannot
   * offer the button at all, and the field stays a plain textarea.
   */
  onDescribe?: (draft: DescribeDraft) => Promise<string>
  onSubmit: (draft: TeamDraft) => void
  onCancel: () => void
}

/**
 * Render the squad form.
 * @param props - the squad under edit and the page actions.
 */
export function TeamForm({ team, busy, presets, workspaces, onDescribe, onSubmit, onCancel }: TeamFormProps): ReactNode {
  const [name, setName] = useState(team?.name ?? '')
  const [description, setDescription] = useState(team?.description ?? '')
  const [workspaceId, setWorkspaceId] = useState(team?.workspaceId ?? '')
  const [leadPreset, setLeadPreset] = useState(team?.leadPreset ?? '')
  const [nameTouched, setNameTouched] = useState(false)
  const [error, setError] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')
  const trimmedName = name.trim()
  // A field is only marked invalid once the user has actually left it or tried
  // to submit: an untouched empty form is a place to start, not a mistake.
  const invalidName = trimmedName === '' && nameTouched
  const canSubmit = trimmedName !== ''
  const selectedWorkspace = workspaces.find(workspace => workspace.id === workspaceId)
  // A pin the registry no longer lists keeps a name in the preview: calling it
  // "unbound" would claim the squad runs on the Host default when it does not.
  const workspaceLabel = selectedWorkspace !== undefined
    ? selectedWorkspace.title
    : workspaceId === '' ? t('detail.noWorkspace') : workspaceId + t('form.workspaceUnlisted')
  const leadLabel = leadPreset === '' ? t('squad.leadPresetInherit') : leadPreset
  const generate = (): void => {
    if (onDescribe === undefined || generating) return
    setGenerating(true)
    setGenerateError('')
    const intent = description.trim()
    void onDescribe({ name: trimmedName, ...(intent === '' ? {} : { intent }) })
      .then((text) => { setDescription(text) })
      .catch((failure: unknown) => {
        setGenerateError(failure instanceof Error ? failure.message : t('error.unknown'))
        // A model that cannot answer must not leave the field empty-handed: the
        // typed template offers the same three lines to fill in, and it never
        // overwrites text the user already wrote.
        if (intent === '') {
          setDescription(t('form.descriptionTemplate', { name: trimmedName === '' ? t('form.previewName') : trimmedName }))
        }
      })
      .finally(() => { setGenerating(false) })
  }
  const submit = (): void => {
    if (trimmedName === '') {
      setNameTouched(true)
      setError(t('form.nameRequired'))
      return
    }
    setError('')
    const pinnedLead = leadPreset.trim()
    onSubmit({
      ...(team === undefined ? {} : teamDraftOf(team)),
      name: trimmedName,
      description,
      workspaceId: workspaceId.trim(),
      // Always present so clearing the field actually clears the pin: the Host
      // reads an absent field as "keep nothing" for a replace and drops the key
      // from the JSON body either way.
      leadPreset: pinnedLead === '' ? undefined : pinnedLead,
    })
  }
  return (
    <form className={css.form + ' ' + css.formWide} data-dsh-part="team-form" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <div className={css.formLayout}>
        <div className={css.formGroups}>
          <fieldset className={css.formGroup} data-dsh-part="team-form-basics">
            <legend className={css.formGroupTitle}>{t('form.basics')}</legend>
            <p className={css.formGroupHint}>{t('form.basicsHint')}</p>
            <label className={css.field}>
              <span className={css.fieldLabel}>
                {t('form.name')}
                <span className={css.fieldRequired} aria-hidden="true">*</span>
              </span>
              <input
                className={css.input}
                required
                value={name}
                placeholder={t('form.namePlaceholder')}
                aria-invalid={invalidName}
                onChange={(event) => { setName(event.target.value) }}
                onBlur={() => { setNameTouched(true) }}
              />
              <span className={css.fieldHint + (invalidName ? ' ' + css.fieldHintError : '')}>
                {invalidName ? t('form.nameRequired') : t('form.nameHint')}
              </span>
            </label>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('form.description')}</span>
              <textarea
                className={css.textarea}
                rows={3}
                maxLength={DESCRIPTION_MAX_LENGTH}
                value={description}
                placeholder={t('form.descriptionPlaceholder')}
                onChange={(event) => { setDescription(event.target.value) }}
              />
              <div className={css.inlineRow}>
                {onDescribe === undefined ? null : (
                  <button
                    type="button"
                    className={css.action + ' ' + css.actionSmall}
                    disabled={busy || generating || (trimmedName === '' && description.trim() === '')}
                    onClick={generate}
                  >
                    {generating ? t('form.generating') : t('form.generate')}
                  </button>
                )}
                <span className={css.fieldHint}>{t('form.descriptionHint')}</span>
              </div>
              {generateError === '' ? null : <span className={css.fieldHint + ' ' + css.fieldHintError} role="status">{generateError}</span>}
            </div>
          </fieldset>
          <fieldset className={css.formGroup} data-dsh-part="team-form-runtime">
            <legend className={css.formGroupTitle}>{t('form.runtime')}</legend>
            <p className={css.formGroupHint}>{t('form.runtimeHint')}</p>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('form.workspace')}</span>
              {/* A pin this registry does not list keeps its own row: dropping it
                  would quietly clear a workspace the next save then loses. */}
              <select className={css.input} aria-label={t('form.workspace')} value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value) }}>
                <option value="">{t('form.workspaceInherit')}</option>
                {workspaces.map(workspace => (
                  <option key={workspace.id} value={workspace.id} title={workspace.path ?? workspace.id}>{workspace.title}</option>
                ))}
                {selectedWorkspace !== undefined || workspaceId === '' ? null : (
                  <option key={workspaceId} value={workspaceId}>{workspaceId + t('form.workspaceUnlisted')}</option>
                )}
              </select>
              <span className={css.fieldHint}>{t('form.workspaceHint')}</span>
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('form.leadPreset')}</span>
              {presets.length === 0 ? (
                <input className={css.input} value={leadPreset} placeholder={t('form.leadPresetPlaceholder')} onChange={(event) => { setLeadPreset(event.target.value) }} />
              ) : (
                <select className={css.input} value={leadPreset} aria-label={t('form.leadPreset')} onChange={(event) => { setLeadPreset(event.target.value) }}>
                  <option value="">{t('squad.leadPresetInherit')}</option>
                  {presets.map(id => <option key={id} value={id}>{id}</option>)}
                </select>
              )}
              <span className={css.fieldHint}>{presets.length === 0 ? t('form.leadPresetHintTyped') : t('form.leadPresetHint')}</span>
            </div>
          </fieldset>
        </div>
        <aside className={css.formPreview} data-dsh-part="team-form-preview" aria-label={t('form.preview')}>
          <span className={css.formPreviewLabel}>{t('form.preview')}</span>
          <div className={css.formPreviewCard}>
            <span className={css.formPreviewName}>{trimmedName === '' ? t('form.previewName') : trimmedName}</span>
            <span className={css.formPreviewMeta}>{t('list.memberCount', { count: String(team?.members.length ?? 0) })}</span>
            <span className={css.formPreviewDescription}>{description.trim() === '' ? t('list.noDescription') : description.trim()}</span>
            <span className={css.formPreviewFoot}>
              <span>{t('form.previewWorkspace', { name: workspaceLabel })}</span>
              <span>{t('form.previewLead', { name: leadLabel })}</span>
            </span>
          </div>
        </aside>
      </div>
      {error === '' ? null : <p className={css.noticeError} role="alert">{error}</p>}
      <div className={css.formActions}>
        <button type="submit" className={css.primary} disabled={busy || !canSubmit}>{team === undefined ? t('form.create') : t('form.save')}</button>
        <button type="button" className={css.secondary} onClick={onCancel}>{t('form.cancel')}</button>
      </div>
    </form>
  )
}

export interface MemberFormProps {
  teamId: string
  /** The member being edited; omitted when adding one. */
  member: MemberDefinition | undefined
  busy: boolean
  /**
   * The model catalog the Host published. Absent when it published none, and
   * the form then offers no model picker at all instead of an empty one.
   */
  models?: readonly AgentsModelOption[]
  /** The deployment-wide reasoning levels the Host published, when it published any. */
  efforts?: readonly string[]
  onSubmit: (teamId: string, draft: MemberDraft) => void
  onCancel: () => void
}

/**
 * Render the member form.
 * @param props - the member under edit and the page actions.
 */
export function MemberForm({ teamId, member, busy, models, efforts, onSubmit, onCancel }: MemberFormProps): ReactNode {
  const [name, setName] = useState(member?.name ?? '')
  const [preset, setPreset] = useState(member?.preset ?? '')
  const [permission, setPermission] = useState<string>(member?.permission ?? '')
  const [model, setModel] = useState(member?.model ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(member?.reasoningEffort ?? '')
  const [brief, setBrief] = useState(member?.brief ?? '')
  const [error, setError] = useState('')
  // Read per render: the picker follows the model currently chosen, not the one
  // the member arrived with.
  const levels = effortLevels(models, efforts, model)
  const submit = (): void => {
    if (name.trim() === '') {
      setError(t('form.nameRequired'))
      return
    }
    setError('')
    onSubmit(teamId, {
      ...(member === undefined ? {} : { id: member.id }),
      name: name.trim(),
      preset,
      permission: permission === '' ? undefined : (permission as AgentsPermission),
      model,
      reasoningEffort,
      brief,
    })
  }
  return (
    <form className={css.form + ' ' + css.memberForm} data-dsh-part="member-form" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <h3 className={css.sectionTitle}>{t('form.memberTitle')}</h3>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.name')}</span>
        <input className={css.input} value={name} placeholder={t('form.namePlaceholder')} onChange={(event) => { setName(event.target.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.preset')}</span>
        <input className={css.input} value={preset} placeholder={t('form.presetPlaceholder')} onChange={(event) => { setPreset(event.target.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.permission')}</span>
        <select className={css.input} value={permission} onChange={(event) => { setPermission(event.target.value) }}>
          <option value="">{t('form.permissionInherit')}</option>
          {PERMISSION_MODES.map(mode => <option key={mode} value={mode}>{permissionLabel(mode)}</option>)}
        </select>
      </label>
      {models === undefined ? null : (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('form.model')}</span>
          <select className={css.input} name="model" value={model} onChange={(event) => { setModel(event.target.value) }}>
            <option value="">{t('member.inherit')}</option>
            {modelRows(models, model).map(row => <option key={row.value} value={row.value}>{row.label}</option>)}
          </select>
        </label>
      )}
      {models === undefined && efforts === undefined ? null : (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('form.reasoningEffort')}</span>
          {/* The explicit name keeps the control's own label free of the hint
              beside it, which states why the picker offers so little. */}
          <select
            className={css.input}
            name="reasoningEffort"
            aria-label={t('form.reasoningEffort')}
            value={reasoningEffort}
            onChange={(event) => { setReasoningEffort(event.target.value) }}
          >
            <option value="">{t('form.effortInherit')}</option>
            {effortRows(levels, reasoningEffort).map(row => <option key={row.value} value={row.value}>{row.label}</option>)}
          </select>
          {modelDeclaresNoLevels(models, model) ? <span className={css.fieldHint}>{t('form.effortNoLevels')}</span> : null}
        </label>
      )}
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('form.brief')}</span>
        <textarea className={css.textarea} value={brief} placeholder={t('form.briefPlaceholder')} onChange={(event) => { setBrief(event.target.value) }} />
      </label>
      {error === '' ? null : <p className={css.noticeError} role="alert">{error}</p>}
      <div className={css.formActions}>
        <button type="submit" className={css.primary} disabled={busy}>{member === undefined ? t('form.create') : t('form.save')}</button>
        <button type="button" className={css.secondary} onClick={onCancel}>{t('form.cancel')}</button>
      </div>
    </form>
  )
}
