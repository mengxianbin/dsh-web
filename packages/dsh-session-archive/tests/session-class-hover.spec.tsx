// @vitest-environment jsdom
/**
 * Hover-card session-origin line (hover-sessionclass-1121): the browser half
 * seats the `sidebar.session.row.hover` seat with this package's own occupant
 * id, and the line renders the raw triclass verbatim — quiet absence when the
 * ledger has no record or the endpoint is unreachable (never a banner), one
 * cached fetch per page, zero polling.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { SessionClassLine } from '../src/client/SessionClassLine.tsx'
import { resetSessionClassLookup } from '../src/client/session-class.ts'
import { zh } from '../src/client/locales.ts'

const fetchMock = vi.fn()

function jsonOk(body: unknown): Response {
  return { ok: true, json: async () => body } as Response
}

/** Flush the microtask queue inside act so effect-driven state settles. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** The zh line copy with the class substituted (the label itself is locale copy). */
function lineCopy(sessionClass: string): string {
  return (zh as Record<string, string>)['arch.hover.class'].replace('{class}', sessionClass)
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  resetSessionClassLookup()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
  it.each(['human', 'bot-boss', 'bot-worker'] as const)('renders the raw %s class verbatim', async (sessionClass) => {
    fetchMock.mockResolvedValue(jsonOk({ ok: true, classes: { 'session-1': sessionClass } }))
    const view = render(<SessionClassLine sessionId="session-1" />)
    await flush()
    expect(screen.getByText(lineCopy(sessionClass))).toBeTruthy()
    expect(view.container.querySelector('[data-session-class]')?.getAttribute('data-session-class')).toBe(sessionClass)
  })

  it('renders nothing when the ledger has no record for the session', async () => {
    fetchMock.mockResolvedValue(jsonOk({ ok: true, classes: { 'session-other': 'human' } }))
    const view = render(<SessionClassLine sessionId="session-missing" />)
    await flush()
    expect(view.container.textContent).toBe('')
    expect(screen.queryByText(/会话类型/u)).toBeNull()
  })

  it('stays quietly absent when the endpoint is unreachable, and never retries', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'))
    const view = render(<SessionClassLine sessionId="session-1" />)
    await flush()
    await flush()
    expect(view.container.textContent).toBe('')
    expect(screen.queryByText(/会话类型/u)).toBeNull()
    // The failure settles the cache: one attempt for the page's lifetime.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stays quietly absent when the endpoint refuses with a non-2xx status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ ok: false }) } as Response)
    const view = render(<SessionClassLine sessionId="session-1" />)
    await flush()
    expect(view.container.textContent).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('renders nothing for a value outside the triclass', async () => {
    fetchMock.mockResolvedValue(jsonOk({ ok: true, classes: { 'session-1': 'machine' } }))
    const view = render(<SessionClassLine sessionId="session-1" />)
    await flush()
    expect(view.container.textContent).toBe('')
  })

  it('resolves a bare workspace id against the canonical ledger key', async () => {
    fetchMock.mockResolvedValue(jsonOk({ ok: true, classes: { 'session-abc': 'bot-worker' } }))
    render(<SessionClassLine sessionId="abc" />)
    await flush()
    expect(screen.getByText(lineCopy('bot-worker'))).toBeTruthy()
  })

  it('fetches once per page and serves every later hover from the cache', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      ok: true,
      classes: { 'session-a': 'human', 'session-b': 'bot-boss' },
    }))
    const first = render(<SessionClassLine sessionId="session-a" />)
    await flush()
    expect(screen.getByText(lineCopy('human'))).toBeTruthy()
    first.unmount()

    const second = render(<SessionClassLine sessionId="session-b" />)
    await flush()
    expect(screen.getByText(lineCopy('bot-boss'))).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
