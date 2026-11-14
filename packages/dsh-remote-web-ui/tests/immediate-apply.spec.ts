/**
 * A settings card applies what the operator does without a save button: a
 * pick is written the moment it is made, typed text once typing pauses or the
 * field is left, and Escape puts the stored value back. A refused pick springs
 * back to the stored value; refused text stays on screen to be corrected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, TYPE_PAUSE_MS, booleanField, textField } from '../src/client/settings-form.ts'

/**
 * A form double whose user layer takes every accepted batch, and which can be
 * told to refuse.
 * @param initial - the stored user layer.
 * @returns the form double, the batches it was sent, and its refusal switch.
 */
function settingsForm(initial: Record<string, unknown>) {
  const user: Record<string, unknown> = { ...initial }
  const batches: unknown[] = []
  const control = { accepts: true }
  const snapshot = (): ConfigFormSnapshot<Record<string, unknown>> => ({
    status: 'ready',
    value: { ...user },
    user: { ...user },
    revision: batches.length + 1,
    writable: true,
  }) as unknown as ConfigFormSnapshot<Record<string, unknown>>
  const form = {
    getSnapshot: snapshot,
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async (batch: Array<{ op: 'set' | 'unset', path: string[], value?: unknown }>) => {
      batches.push(batch)
      if (!control.accepts) return false
      for (const op of batch) {
        if (op.op === 'set') user[op.path[0]!] = op.value
        else delete user[op.path[0]!]
      }
      return true
    },
  } as unknown as ConfigForm<Record<string, unknown>>
  return { form, batches, user, control }
}

/** Let the write the card started settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('settings card: changes apply without a save button', () => {
  it('operator picking an option sees it written at once', async () => {
    // Given a card over a stored switch
    const target = settingsForm({ relay: true })
    const card = new CardForm(target.form, [booleanField('relay')])

    // When the operator picks off
    card.actions().edit('relay', 'false')
    await settle()

    // Then the pick is in the user layer with no further step
    expect(target.batches).toEqual([[{ op: 'set', path: ['relay'], value: false }]])
    expect(card.shell().dirty).toBe(false)
    card.dispose()
  })

  it('operator typing sees the text written once typing pauses, in one write', async () => {
    // Given a card over a stored text field
    const target = settingsForm({ name: 'a' })
    const card = new CardForm(target.form, [textField('name')])

    // When the operator types two characters in quick succession
    card.actions().edit('name', 'ab')
    await vi.advanceTimersByTimeAsync(TYPE_PAUSE_MS / 2)
    card.actions().edit('name', 'abc')
    await vi.advanceTimersByTimeAsync(TYPE_PAUSE_MS - 1)

    // Then nothing is written while typing goes on, and the pause writes the last text once
    expect(target.batches).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(target.batches).toEqual([[{ op: 'set', path: ['name'], value: 'abc' }]])
    card.dispose()
  })

  it('operator pressing Enter writes the typed text without waiting for the pause', async () => {
    // Given typed text that has not paused yet
    const target = settingsForm({ name: 'a' })
    const card = new CardForm(target.form, [textField('name')])
    card.actions().edit('name', 'ab')

    // When the operator commits it
    card.actions().save()
    await settle()

    // Then it is written now, and the pause that follows writes nothing more
    expect(target.user.name).toBe('ab')
    await vi.advanceTimersByTimeAsync(TYPE_PAUSE_MS)
    expect(target.batches).toHaveLength(1)
    card.dispose()
  })

  it('operator pressing Escape gets the stored value back and nothing is written', async () => {
    // Given typed text that has not paused yet
    const target = settingsForm({ name: 'a' })
    const card = new CardForm(target.form, [textField('name')])
    card.actions().edit('name', 'ab')

    // When the operator backs out
    card.actions().discard()
    await vi.advanceTimersByTimeAsync(TYPE_PAUSE_MS)

    // Then the field shows the stored text and the Host saw no write
    expect(card.field('name').text).toBe('a')
    expect(target.batches).toEqual([])
    card.dispose()
  })

  it('operator whose pick is refused sees the stored value back and the failure', async () => {
    // Given a Host that refuses writes
    const target = settingsForm({ relay: true })
    target.control.accepts = false
    const card = new CardForm(target.form, [booleanField('relay')])

    // When the operator picks off
    card.actions().edit('relay', 'false')
    await settle()

    // Then the control is back on the stored value and the card reports the refusal
    expect(card.field('relay').text).toBe('true')
    expect(card.shell().failed).toBe(true)
    card.dispose()
  })

  it('operator whose typed text is refused keeps it on screen to correct', async () => {
    // Given a Host that refuses writes
    const target = settingsForm({ name: 'a' })
    target.control.accepts = false
    const card = new CardForm(target.form, [textField('name')])

    // When the operator's typed text is committed
    card.actions().edit('name', 'ab')
    card.actions().save()
    await settle()

    // Then the text stays as typed and the card reports the refusal
    expect(card.field('name').text).toBe('ab')
    expect(card.shell().failed).toBe(true)
    card.dispose()
  })
})
