/** Turn-tail editor for one ordinary text-only user message. */
import { memo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { messageEditTarget } from '../core/transcript.ts'
import type { SubmitMessageEditInput } from './wiring.ts'
import { MESSAGE_EDIT_PART_EDITOR, MESSAGE_EDIT_PART_ENTRY, MESSAGE_EDIT_PLUGIN_ATTR } from './semantic.ts'
import css from './message-edit.module.css'

/** Business verb supplied by the plugin registration. */
export interface MessageEditInjected {
  readonly submitEdit: (input: SubmitMessageEditInput) => Promise<unknown>
}

export type MessageEditTailProps = PropsRuntime<'conversation.chat.turnTail'>
  & PropsLocale<'message-edit'>
  & MessageEditInjected

function sameTarget(a: ReturnType<typeof messageEditTarget>, b: ReturnType<typeof messageEditTarget>): boolean {
  return a === b || (a !== null && b !== null && a.seq === b.seq && a.text === b.text && a.forkAtSeq === b.forkAtSeq)
}

/** Render the edit affordance and its inline editor for one Turn. */
export const MessageEditTail = memo(function MessageEditTail(props: MessageEditTailProps) {
  const { turn, sessionId, useChat, useSession, useAccess, submitEdit, t } = props
  const turnNumber = turn.turn
  const target = useChat(snapshot => messageEditTarget(snapshot, turnNumber), sameTarget)
  const unavailable = useSession(session => session.running || session.removed)
  const forkAllowed = useAccess('session/fork')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (target === null) return null
  const blockedReason = !forkAllowed ? t('edit.noAccess') : unavailable ? t('edit.running') : null
  const canSubmit = blockedReason === null && !saving && draft.trim() !== ''

  const startEdit = (): void => {
    setDraft(target.text)
    setError(null)
    setEditing(true)
  }
  const cancelEdit = (): void => {
    if (saving) return
    setEditing(false)
    setError(null)
  }
  const save = async (): Promise<void> => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      await submitEdit({ sessionId, forkAtSeq: target.forkAtSeq, editedText: draft })
      // Successful navigation remounts this Session-scoped entry. Keep the
      // controls disabled until then so a slow navigation cannot double-fork.
    } catch (reason) {
      setSaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={css.trigger}
        data-dsh-plugin={MESSAGE_EDIT_PLUGIN_ATTR}
        data-dsh-part={MESSAGE_EDIT_PART_ENTRY}
        disabled={blockedReason !== null}
        title={blockedReason ?? t('edit.hint')}
        onClick={startEdit}
      >
        {t('edit.button')}
      </button>
    )
  }

  return (
    <div
      className={css.editor}
      data-dsh-plugin={MESSAGE_EDIT_PLUGIN_ATTR}
      data-dsh-part={MESSAGE_EDIT_PART_EDITOR}
    >
      <textarea
        className={css.textarea}
        value={draft}
        autoFocus
        rows={4}
        aria-label={t('edit.textarea')}
        readOnly={saving}
        onChange={event => { setDraft(event.target.value) }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            cancelEdit()
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void save()
          }
        }}
      />
      <div className={css.hint}>{t('edit.hint')}</div>
      <div className={css.hint}>{blockedReason ?? t('edit.shortcut')}</div>
      {error !== null ? <div className={css.error} role="alert">{t('edit.failed', { reason: error })}</div> : null}
      <div className={css.actions}>
        <button type="button" className={css.secondary} disabled={saving} onClick={cancelEdit}>
          {t('edit.cancel')}
        </button>
        <button type="button" className={css.primary} disabled={!canSubmit} onClick={() => { void save() }}>
          {saving ? t('edit.saving') : t('edit.save')}
        </button>
      </div>
    </div>
  )
})
