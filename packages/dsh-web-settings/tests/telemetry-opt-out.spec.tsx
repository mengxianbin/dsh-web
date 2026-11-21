/** @vitest-environment jsdom */

/**
 * The family-wide telemetry switch in the Web Plugins settings section: it
 * reflects the stored preference, writes it back, and reports the browser's Do
 * Not Track state without pretending the switch caused it.
 *
 * The switch's value is the positive one (checked = the heartbeat runs, the
 * default), while the stored preference is the opt-out; the two are inverses,
 * so each case below pins both directions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TelemetryToggle } from '../src/client/TelemetryToggle.tsx'
import { en } from '../src/client/locales.ts'

/** English translate stub, reading the published dictionary. */
const t = (key: string): string => (en as Record<string, string>)[key] ?? key

const OPT_OUT_KEY = 'dsh-web-ui-telemetry-opt-out'
const DNT_NOTE = en['telemetry.dnt']

/** Minimal Storage double; Node's partial global localStorage leaks into jsdom here. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => { map.delete(key) },
    setItem: (key, value) => { map.set(key, String(value)) },
  }
}

const toggle = (): HTMLElement => screen.getByRole('switch')

describe('TelemetryToggle', () => {
  let store: Storage

  beforeEach(() => {
    store = memoryStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true })
    Object.defineProperty(navigator, 'doNotTrack', { value: undefined, configurable: true })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(navigator, 'doNotTrack', { value: undefined, configurable: true })
  })

  it('Visitor who stored nothing sees the switch on and no Do Not Track note', () => {
    // Given: this browser stores no opt-out and sends no Do Not Track signal.
    // When: the Web Plugins section renders the control.
    render(<TelemetryToggle t={t} />)
    // Then: telemetry reads as on (the default) and the DNT note is absent.
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText(DNT_NOTE)).toBeNull()
    expect(screen.getByText(en['telemetry.title']).textContent).toBe(en['telemetry.title'])
  })

  it('Visitor who switches telemetry off stores the family-wide opt-out', () => {
    // Given: the section rendered with the switch on.
    render(<TelemetryToggle t={t} />)
    // When: the visitor switches telemetry off.
    fireEvent.click(toggle())
    // Then: the shared storage key holds '1' and the switch reads as off.
    expect(store.getItem(OPT_OUT_KEY)).toBe('1')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('Visitor who already opted out sees the switch off on arrival', () => {
    // Given: a previous session stored the opt-out.
    store.setItem(OPT_OUT_KEY, '1')
    // When: the section renders the control.
    render(<TelemetryToggle t={t} />)
    // Then: the switch reports the stored preference.
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('Visitor who turns telemetry back on drops the stored opt-out', () => {
    // Given: the switch starts off because the opt-out is stored.
    store.setItem(OPT_OUT_KEY, '1')
    render(<TelemetryToggle t={t} />)
    // When: the visitor switches telemetry on.
    fireEvent.click(toggle())
    // Then: the key is gone rather than holding '0', and the switch reads as on.
    expect(store.getItem(OPT_OUT_KEY)).toBeNull()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('Visitor whose browser sends Do Not Track sees the note while the switch stays on', () => {
    // Given: the browser answers Do Not Track and nothing is stored.
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true })
    // When: the section renders the control.
    render(<TelemetryToggle t={t} />)
    // Then: the note explains the heartbeat stopped on its own and the stored
    // preference is still the default, which is on.
    expect(screen.getByRole('status').textContent).toBe(DNT_NOTE)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('Visitor whose browser sends Do Not Track and who also opted out sees no note', () => {
    // Given: Do Not Track is on and the switch is already stored as off.
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true })
    store.setItem(OPT_OUT_KEY, '1')
    // When: the section renders the control.
    render(<TelemetryToggle t={t} />)
    // Then: the preference itself explains the state, so the note stays hidden.
    expect(screen.queryByText(DNT_NOTE)).toBeNull()
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })
})
