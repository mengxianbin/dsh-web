// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { MessageEditTail, type MessageEditTailProps } from '../src/client/MessageEditTail.tsx'
import { zh, type MessageEditKey } from '../src/client/locales.ts'

function translate(key: string, params?: Record<string, unknown>): string {
  let value = zh[key as MessageEditKey] ?? key
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}

function snapshot(): ChatSnapshot {
  const node = {
    kind: 'user',
    anchorSeq: 5,
    location: { kind: 'step', turn: { turn: 2 } },
    data: { seq: 5, content: [{ type: 'text', text: 'original text' }] },
  }
  return { nodes: { values: () => [node] } } as never
}

function props(overrides: {
  running?: boolean
  removed?: boolean
  forkAllowed?: boolean
  submitEdit?: MessageEditTailProps['submitEdit']
} = {}): MessageEditTailProps {
  const snap = snapshot()
  return {
    turn: { turn: 2 },
    sessionId: 'session-source',
    useChat: (selector: (value: ChatSnapshot) => unknown) => selector(snap),
    useSession: (selector: (value: { running: boolean; removed: boolean }) => unknown) => selector({
      running: overrides.running ?? false,
      removed: overrides.removed ?? false,
    }),
    useAccess: () => overrides.forkAllowed ?? true,
    submitEdit: overrides.submitEdit ?? vi.fn(async () => 'session-child'),
    t: translate,
  } as never
}

function clickEntry() {
  fireEvent.click(screen.getByRole('button', { name: zh['edit.button'] }))
  return screen.getByRole('textbox', { name: zh['edit.textarea'] }) as HTMLTextAreaElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MessageEditTail', () => {
  it('user opens an editor with the original text and side-effect warning', () => {
    // Given a Turn with an editable user message
    render(<MessageEditTail {...props()} />)
    // When the user opens the editor
    const textarea = clickEntry()
    // Then the original text, warning, and keyboard help are visible
    expect(textarea.value).toBe('original text')
    expect(screen.getByText(zh['edit.hint']).textContent).toBe(zh['edit.hint'])
    expect(screen.getByText(zh['edit.shortcut']).textContent).toBe(zh['edit.shortcut'])
  })

  it('user submits an edited draft with the exact preceding boundary', async () => {
    // Given an open editor with a corrected draft
    const submitEdit = vi.fn(async () => 'session-child')
    render(<MessageEditTail {...props({ submitEdit })} />)
    const textarea = clickEntry()
    fireEvent.change(textarea, { target: { value: 'corrected text' } })
    // When the user resends
    fireEvent.click(screen.getByRole('button', { name: zh['edit.save'] }))
    // Then the source, preceding seq, and edited text form one submission
    await waitFor(() => expect(submitEdit).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-source', forkAtSeq: 4, editedText: 'corrected text',
    }))
  })

  it('user can submit with Ctrl+Enter and cancel with Escape', async () => {
    // Given an editor that was cancelled once and reopened
    const submitEdit = vi.fn(async () => 'session-child')
    render(<MessageEditTail {...props({ submitEdit })} />)
    let textarea = clickEntry()
    // When Escape closes it and Ctrl+Enter later submits a new draft
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    textarea = clickEntry()
    fireEvent.change(textarea, { target: { value: 'keyboard edit' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    // Then cancellation discards no action and the keyboard submits once
    await waitFor(() => expect(submitEdit).toHaveBeenCalledTimes(1))
    expect(submitEdit).toHaveBeenCalledWith(expect.objectContaining({ editedText: 'keyboard edit' }))
  })

  it('user cannot fork a blank draft', () => {
    // Given an editor whose draft contains only whitespace
    const submitEdit = vi.fn(async () => 'session-child')
    render(<MessageEditTail {...props({ submitEdit })} />)
    const textarea = clickEntry()
    fireEvent.change(textarea, { target: { value: '  \n' } })
    const save = screen.getByRole('button', { name: zh['edit.save'] }) as HTMLButtonElement
    // When the user attempts to resend the blank draft
    fireEvent.click(save)
    // Then the control is disabled and no submission occurs
    expect(save.disabled).toBe(true)
    expect(submitEdit).not.toHaveBeenCalled()
  })

  it('user sees a submission error while the draft remains correctable', async () => {
    // Given a fork failure and an edited draft
    const submitEdit = vi.fn(async () => { throw new Error('session/fork-unavailable') })
    render(<MessageEditTail {...props({ submitEdit })} />)
    const textarea = clickEntry()
    fireEvent.change(textarea, { target: { value: 'try again' } })
    // When the failed submission settles
    fireEvent.click(screen.getByRole('button', { name: zh['edit.save'] }))
    const alert = await screen.findByRole('alert')
    // Then the reason and draft remain visible and saving has ended
    expect(alert.textContent).toContain('session/fork-unavailable')
    expect(textarea.value).toBe('try again')
    expect((screen.getByRole('button', { name: zh['edit.save'] }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('user cannot edit while running, removed, or denied fork access', () => {
    for (const options of [{ running: true }, { removed: true }, { forkAllowed: false }]) {
      // Given one unavailable Session state
      cleanup()
      render(<MessageEditTail {...props(options)} />)
      const entry = screen.getByRole('button', { name: zh['edit.button'] }) as HTMLButtonElement
      // When the entry is presented
      const title = entry.title
      // Then it is disabled and explains why editing is unavailable
      expect(entry.disabled).toBe(true)
      expect(title.length).toBeGreaterThan(0)
    }
  })
})
