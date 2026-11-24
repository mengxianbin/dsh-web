// @vitest-environment jsdom
/**
 * Hover-card session-origin line (hover-sessionclass-1121): the browser half
 * seats the `sidebar.session.row.hover` seat with this package's own occupant
 * id, and the line renders the raw triclass verbatim from the list snapshot's
 * `sessionClass` summary projection (sessionclass-summary-channel-1127) —
 * quiet absence when the standard hook is absent, the row carries no record,
 * or the value falls outside the triclass (never a banner, no fetch at all).
 *
 * test-standards-allow: render tests over a structural useSessions stub —
 * quiet-absence checks are existence assertions by design, and the seat
 * registration case asserts the component identity it was given.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.ts'
import { SessionClassLine, type SessionListRows, type UseSessions } from '../src/client/SessionClassLine.tsx'
import { zh } from '../src/client/locales.ts'

/** A `useSessions` stand-in bound to one snapshot (the git-graph fixture shape). */
function useSessionsAt(state: SessionListRows): UseSessions {
  return <S,>(selector: (s: SessionListRows) => S): S => selector(state)
}

/** The zh line copy with the class substituted (the label itself is locale copy). */
function lineCopy(sessionClass: string): string {
  return (zh as Record<string, string>)['arch.hover.class'].replace('{class}', sessionClass)
}

afterEach(() => {
  cleanup()
})

describe('sidebar.session.row.hover registration', () => {
  it('seats the hover line under this package’s own occupant id', () => {
    const registrations: { name: string; options: Record<string, unknown>; component: unknown }[] = []
    const configForm = {
      getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true }),
      subscribe: () => () => {},
      set: async () => true,
      unset: async () => true,
      mutate: async () => true,
    }
    const ctx = {
      effect: (run: () => unknown) => {
        run()
        return () => {}
      },
      get: () => undefined,
      configForms: { get: () => configForm },
      locale: {
        register: () => () => {},
        // Fidelity: the real bound translate interpolates `{name}` params —
        // apply() seats this into the module translate seat, and a params-
        // ignoring stub would leave `{class}` literal for every later case.
        bind: () => (key: string, params?: Record<string, unknown>) => {
          let text = (zh as Record<string, string>)[key] ?? key
          if (params !== undefined) {
            for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
          }
          return text
        },
      },
      slots: {
        inject: (_name: string, run: () => unknown) => {
          run()
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ name: String(options.name), options, component })
          return () => {}
        },
      },
    }
    apply(ctx as never)

    const hover = registrations.find(entry => entry.name === 'sidebar.session.row.hover')
    expect(hover).toBeDefined()
    expect(hover?.options.id).toBe('dsh-session-archive.class')
    expect(hover?.options.order).toBe(10)
    expect(hover?.component).toBe(SessionClassLine)
    // The settings section keeps its own seat alongside the new line.
    expect(registrations.map(entry => entry.name)).toContain('settings.section')
  })
})

describe('SessionClassLine rendering', () => {
  it.each(['human', 'bot-boss', 'bot-worker'] as const)('renders the raw %s class verbatim', (sessionClass) => {
    const state: SessionListRows = {
      byId: { 'session-1': { projectionValues: { sessionClass } } },
    }
    const view = render(<SessionClassLine sessionId="session-1" useSessions={useSessionsAt(state)} />)
    expect(screen.getByText(lineCopy(sessionClass))).toBeTruthy()
    expect(view.container.querySelector('[data-session-class]')?.getAttribute('data-session-class')).toBe(sessionClass)
  })

  it('renders nothing when the row carries no sessionClass record', () => {
    const state: SessionListRows = { byId: { 'session-1': {} } }
    const view = render(<SessionClassLine sessionId="session-1" useSessions={useSessionsAt(state)} />)
    expect(view.container.textContent).toBe('')
    expect(screen.queryByText(/会话类型/u)).toBeNull()
  })

  it('renders nothing when the list has no row for the session yet', () => {
    const view = render(<SessionClassLine sessionId="session-missing" useSessions={useSessionsAt({ byId: {} })} />)
    expect(view.container.textContent).toBe('')
    expect(screen.queryByText(/会话类型/u)).toBeNull()
  })

  it('renders nothing for a value outside the triclass', () => {
    const state: SessionListRows = {
      byId: { 'session-1': { projectionValues: { sessionClass: 'machine' } } },
    }
    const view = render(<SessionClassLine sessionId="session-1" useSessions={useSessionsAt(state)} />)
    expect(view.container.textContent).toBe('')
  })

  it('stays quietly absent without the standard list hook', () => {
    const view = render(<SessionClassLine sessionId="session-1" />)
    expect(view.container.textContent).toBe('')
    expect(screen.queryByText(/会话类型/u)).toBeNull()
  })

  it('reads the row under the owner id exactly as the seat passes it', () => {
    const state: SessionListRows = {
      byId: { 'session-abc': { projectionValues: { sessionClass: 'bot-worker' } } },
    }
    render(<SessionClassLine sessionId="session-abc" useSessions={useSessionsAt(state)} />)
    expect(screen.getByText(lineCopy('bot-worker'))).toBeTruthy()
  })
})
