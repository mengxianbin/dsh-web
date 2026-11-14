/**
 * The family-shared plugin settings card: the chrome every plugin settings page
 * renders around its own fields. These tests drive the card through its own
 * props and the field controls it exports, so what they certify is the
 * behaviour a consuming card depends on - the namespace gate, the disclosure,
 * the anatomy of a field row in each state, and when a pick versus a typed
 * draft becomes a write.
 */

import { act, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BooleanField,
  ChoiceField,
  PluginSettingsCard,
  ValueField,
  type FieldProps,
} from '../client/settings/PluginSettingsCard.tsx'
import type { CardShell } from '../client/settings/settings-form.ts'

// React only flushes an act() scope synchronously in an environment it
// recognizes as a test renderer, and the family vitest setup does not set the
// flag; without it every act() call warns and its scope is advisory.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The body's disclosure motion, mirroring --settings-card-motion on the card root. */
const BODY_MOTION_MS = 180

/** Copy the card reads: the shared chrome keys, plus the two this plugin's header uses. */
const copy = {
  'settings.collapse': 'Collapse',
  'settings.expand': 'Expand',
  'settings.notExposed': 'This deployment does not serve these settings',
  'settings.readOnly': 'This document is read-only',
  'settings.saveFailed': 'The write was refused',
  'plugin.title': 'Pet settings',
  'plugin.description': 'How the pet behaves',
} as const

type Key = keyof typeof copy

/** Locale reader over the copy above. */
function t(key: Key): string {
  return copy[key]
}

/** Form state of a served, writable namespace with no write in flight. */
function shell(overrides: Partial<CardShell> = {}): CardShell {
  return {
    available: true,
    exposed: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    ...overrides,
  }
}

/** A field row holding no draft, no override and no invalid value. */
function row(overrides: Partial<FieldProps> = {}): FieldProps {
  return {
    id: 'settings-pet-size',
    label: 'Size',
    hint: 'Cells across',
    text: '',
    overridden: false,
    invalid: false,
    overriddenLabel: 'Overridden',
    resetLabel: 'Reset',
    invalidLabel: 'Enter a whole number',
    disabled: false,
    onEdit: () => {},
    onReset: () => {},
    ...overrides,
  }
}

interface CardSetup {
  /** Shell fields this case overrides. */
  state?: Partial<CardShell>
  /** Whether the card arrives expanded; the card's own default is true. */
  defaultOpen?: boolean
  /** Render the fields even when the namespace is not exposed. */
  renderChildrenWhenNotExposed?: boolean
  /** Hide the not-exposed notice while the fields render anyway. */
  hideNotExposedNotice?: boolean
  /** The plugin's own controls. */
  children?: ReactNode
}

/** Render one card over a fixed shell and record each action it reports. */
function renderCard(setup: CardSetup = {}) {
  const saves: string[] = []
  const discards: string[] = []
  const view = render(
    <PluginSettingsCard<Key>
      t={t}
      titleKey="plugin.title"
      descriptionKey="plugin.description"
      state={shell(setup.state)}
      onSave={() => { saves.push('save') }}
      onDiscard={() => { discards.push('discard') }}
      defaultOpen={setup.defaultOpen}
      renderChildrenWhenNotExposed={setup.renderChildrenWhenNotExposed}
      hideNotExposedNotice={setup.hideNotExposedNotice}
    >
      {setup.children ?? null}
    </PluginSettingsCard>,
  )
  return { ...view, saves, discards }
}

/** The disclosure phase the body reports, or null while no body is mounted. */
function bodyPhase(container: HTMLElement): string | null {
  return container.querySelector('[data-state]')?.getAttribute('data-state') ?? null
}

/** Run the body's disclosure motion out deterministically. */
function settleMotion(): void {
  act(() => { vi.advanceTimersByTime(BODY_MOTION_MS) })
}

/** Run a timer interval deterministically, flushing what it updates. */
function advance(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('plugin settings card chrome', () => {
  it('user sees nothing where the plugin settings card would be while its namespace is unavailable', () => {
    // Given a namespace the Host has not answered for yet
    const { container } = renderCard({ state: { available: false }, children: <ValueField {...row()} /> })

    // When the user looks for the plugin's settings
    // Then there is no card at all: no header, no notice, none of its fields
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('user reading the header finds the plugin named and its settings explained', () => {
    // Given a served namespace rendered as a card
    renderCard()

    // When the user reads the disclosure header
    const header = screen.getByRole('button', { name: `Collapse: ${copy['plugin.title']}` })

    // Then the header names the plugin, explains what its settings govern, and
    // reports the body open
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTitle(copy['plugin.description']).textContent).toBe(copy['plugin.description'])
  })

  it('user collapsing and reopening the card hides and restores its fields', () => {
    // Given an open card holding one field row
    const { container } = renderCard({ children: <ValueField {...row()} /> })
    expect(screen.getByLabelText('Size').tagName).toBe('INPUT')

    // When the user collapses the card and the disclosure motion runs out
    fireEvent.click(screen.getByRole('button', { name: `Collapse: ${copy['plugin.title']}` }))
    settleMotion()

    // Then the header reports the card closed and the body is gone from the DOM
    const closed = screen.getByRole('button', { name: `Expand: ${copy['plugin.title']}` })
    expect(closed.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('input')).toBeNull()
    expect(bodyPhase(container)).toBeNull()

    // When the user opens it again
    fireEvent.click(screen.getByRole('button', { name: `Expand: ${copy['plugin.title']}` }))

    // Then the fields are back and the disclosure settles open
    expect(screen.getByLabelText('Size').tagName).toBe('INPUT')
    settleMotion()
    expect(bodyPhase(container)).toBe('shown')
  })

  it('user opening a card that arrives collapsed gets its fields and a settling disclosure', () => {
    // Given a card that arrives with its body collapsed
    const { container } = renderCard({ defaultOpen: false, children: <ValueField {...row()} /> })
    const header = screen.getByRole('button', { name: `Expand: ${copy['plugin.title']}` })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('input')).toBeNull()

    // When the user opens it
    fireEvent.click(header)

    // Then the body is mounted at once, reports itself opening, and settles open
    expect(screen.getByLabelText('Size').tagName).toBe('INPUT')
    expect(bodyPhase(container)).toBe('entering')
    settleMotion()
    expect(bodyPhase(container)).toBe('shown')
  })

  it('user editing a card sees every row as a label, a hint and a control', () => {
    // Given a served, writable namespace whose card renders three field kinds
    renderCard({
      children: (
        <>
          <ValueField {...row({ text: '8' })} />
          <BooleanField
            {...row({ id: 'settings-pet-enabled', label: 'Enabled', hint: 'Turn the pet on', text: 'true' })}
            inheritLabel="Inherit"
            onLabel="On"
            offLabel="Off"
          />
          <ChoiceField
            {...row({ id: 'settings-pet-mode', label: 'Mode', hint: 'Fast or slow', text: 'fast' })}
            inheritLabel="Inherit"
            presentation="segment"
            choices={[{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }]}
          />
        </>
      ),
    })

    // When the user reads each row
    // Then the typed row shows its label, its hint and the control holding the draft
    const size = screen.getByLabelText('Size') as HTMLInputElement
    expect(size.value).toBe('8')
    expect(screen.getByText('Cells across').tagName).toBe('P')

    // ...the boolean row shows its label, its hint and one pressed option
    expect(screen.getByRole('group', { name: 'Enabled' }).querySelectorAll('button')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('Turn the pet on').tagName).toBe('P')

    // ...and the choice row shows its label, its hint and the pressed choice
    expect(screen.getByRole('group', { name: 'Mode' }).querySelectorAll('button')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Fast' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Slow' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('Fast or slow').tagName).toBe('P')
  })

  it('user on a read-only document sees why above rows that keep label, hint and control', () => {
    // Given a served namespace whose Host document refuses writes
    renderCard({ state: { writable: false }, children: <ValueField {...row({ text: '8', disabled: true })} /> })

    // When the user reads the card
    // Then the card says why it cannot be edited, and the row is still whole:
    // its label, its hint, and a control the user can read but not operate
    expect(screen.getByRole('status').textContent).toBe(copy['settings.readOnly'])
    const size = screen.getByLabelText('Size') as HTMLInputElement
    expect(size.value).toBe('8')
    expect(size.disabled).toBe(true)
    expect(screen.getByText('Cells across').tagName).toBe('P')
  })

  it('user on a deployment that does not serve the namespace sees the explanation instead', () => {
    // Given a namespace the Host does not expose to this client
    const { container } = renderCard({ state: { exposed: false }, children: <ValueField {...row({ text: '8' })} /> })

    // When the user looks at the card
    // Then the card still names the plugin, explains the gap, and holds no field
    const header = screen.getByRole('button', { name: `Collapse: ${copy['plugin.title']}` })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe(copy['settings.notExposed'])
    expect(container.querySelector('input')).toBeNull()
  })

  it('user on a deployment that does not serve the namespace gets the rows and the explanation together', () => {
    // Given a card asked to render its fields without a served namespace
    renderCard({
      state: { exposed: false },
      renderChildrenWhenNotExposed: true,
      children: <ValueField {...row({ text: '8' })} />,
    })

    // When the user reads the card
    // Then the rows keep their label, hint and control, and the card still says
    // why those rows are not being saved by this deployment
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('8')
    expect(screen.getByText('Cells across').tagName).toBe('P')
    expect(screen.getByRole('status').textContent).toBe(copy['settings.notExposed'])
  })

  it('user whose card renders the rows anyway sees the notice hidden when the card hides it', () => {
    // Given a card that renders its fields without a served namespace and
    // hides the notice, the shape a family card uses when its rows stand alone
    renderCard({
      state: { exposed: false },
      renderChildrenWhenNotExposed: true,
      hideNotExposedNotice: true,
      children: <ValueField {...row({ text: '8' })} />,
    })

    // When the user reads the card
    // Then the rows are there and nothing explains a gap the card chose to absorb
    expect((screen.getByLabelText('Size') as HTMLInputElement).value).toBe('8')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('user pressing a segmented option has that pick reported in the same press', () => {
    // Given a card whose pick field reports every value the user picks
    const picks: string[] = []
    const { saves } = renderCard({
      children: (
        <BooleanField
          {...row({
            id: 'settings-pet-enabled',
            label: 'Enabled',
            hint: 'Turn the pet on',
            onEdit: (text) => { picks.push(text) },
          })}
          inheritLabel="Inherit"
          onLabel="On"
          offLabel="Off"
        />
      ),
    })

    // When the user presses the Off option
    fireEvent.click(screen.getByRole('button', { name: 'Off' }))

    // Then the pick left the control at that press, with no save step between
    // the press and the write
    expect(picks).toEqual(['false'])
    expect(saves).toEqual([])
  })

  it('user typing into a field sees nothing written until the field is left', () => {
    // Given a card whose typed field reports drafts and whose save action is recorded
    const drafts: string[] = []
    const { saves } = renderCard({ children: <ValueField {...row({ onEdit: (text) => { drafts.push(text) } })} /> })
    const size = screen.getByLabelText('Size') as HTMLInputElement

    // When the user types a value
    fireEvent.change(size, { target: { value: '64' } })

    // Then the draft is on its way while nothing is written, and no amount of
    // waiting writes it: the card holds no timer of its own
    expect(drafts).toEqual(['64'])
    expect(saves).toEqual([])
    advance(5000)
    expect(saves).toEqual([])

    // When the user leaves the field
    act(() => { size.focus() })
    act(() => { size.blur() })

    // Then the card writes the staged draft, once
    expect(saves).toEqual(['save'])
  })

  it('user pressing Escape in a typed field discards once and writes nothing', () => {
    // Given a focused typed field in a card whose actions are recorded
    const { saves, discards } = renderCard({ children: <ValueField {...row()} /> })
    const size = screen.getByLabelText('Size') as HTMLInputElement
    act(() => { size.focus() })

    // When the user presses Escape
    fireEvent.keyDown(size, { key: 'Escape' })

    // Then the card drops the draft once and writes nothing: leaving the field
    // on that key is the same discard arriving at the field's edge, not a save
    expect(discards).toEqual(['discard'])
    expect(saves).toEqual([])
    expect(document.activeElement).not.toBe(size)
  })

  it('user pressing Enter in a typed field writes once and leaves the field', () => {
    // Given a focused typed field in a card whose actions are recorded
    const { saves, discards } = renderCard({ children: <ValueField {...row({ text: '8' })} /> })
    const size = screen.getByLabelText('Size') as HTMLInputElement
    act(() => { size.focus() })

    // When the user presses Enter
    fireEvent.keyDown(size, { key: 'Enter' })

    // Then the card writes the draft once and writes no second time as focus
    // leaves, so one key press is one write
    expect(saves).toEqual(['save'])
    expect(discards).toEqual([])
    expect(document.activeElement).not.toBe(size)
  })

  it('user whose write the Host refused sees the failure line with the Host reason', () => {
    // Given a card whose last write did not land and whose Host gave a reason
    renderCard({ state: { failed: true, failedReason: 'denied by the schema' } })

    // When the user reads the card
    // Then one line reports the refusal and repeats the Host's reason
    expect(screen.getByRole('status').textContent).toBe(`${copy['settings.saveFailed']} - denied by the schema`)
  })

  it('user whose refused write carried no reason sees the failure line without a suffix', () => {
    // Given a card whose last write did not land and whose refusal carried no reason
    renderCard({ state: { failed: true } })

    // When the user reads the card
    // Then the line is the shared failure copy alone, with no dangling separator
    expect(screen.getByRole('status').textContent).toBe(copy['settings.saveFailed'])
  })
})
