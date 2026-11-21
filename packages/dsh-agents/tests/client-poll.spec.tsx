// @vitest-environment jsdom
/**
 * Poll lifecycle of the agents page.
 *
 * M1 refreshes by polling GET state every five seconds while the page is
 * mounted, plus the manual refresh control; there is no stream. These cases
 * drive the real interval with fake timers and assert both the reads and the
 * DOM they produce, so a loop that never stops (or never starts) fails here.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENTS_POLL_INTERVAL_MS, AgentsPage } from '../src/client/AgentsPage.tsx'
import { t } from '../src/client/locales.ts'
import { click, flush, mount, unmount, unmountAll } from './render.tsx'
import { fakeTransport, stateOf, teamOf } from './agents-fixtures.ts'

beforeEach(() => { vi.useFakeTimers() })

afterEach(() => {
  vi.useRealTimers()
  unmountAll()
})

/** Let the given amount of wall time pass and every read it triggers settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('agents page poll lifecycle', () => {
  it('operator sees the list refresh on its own every five seconds while it stays open', async () => {
    // Given a Host whose every read publishes a new squad name
    const transport = fakeTransport({
      state: async (read: number) => stateOf([teamOf({ id: 'team-' + String(read), name: 'Squad ' + String(read) })]),
    })
    // When the page mounts and stays open for one interval
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    expect(view.container.textContent).toContain('Squad 1')
    await advance(AGENTS_POLL_INTERVAL_MS)
    // Then the second read replaced the list with no user gesture
    expect(view.container.textContent).toContain('Squad 2')
    expect(transport.reads).toBe(2)
  })

  it('operator sees polling stop when the page unmounts', async () => {
    // Given a mounted page that already completed its first read
    const transport = fakeTransport({ state: async (read: number) => stateOf([teamOf({ name: 'Squad ' + String(read) })]) })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    expect(transport.reads).toBe(1)
    // When the page unmounts
    unmount(view)
    await advance(AGENTS_POLL_INTERVAL_MS * 4)
    // Then no further read happens and nothing of the page is left in the DOM
    expect(transport.reads).toBe(1)
    expect(view.container.isConnected).toBe(false)
  })

  it('operator sees the refresh control read immediately, without waiting for the interval', async () => {
    // Given a mounted page before its first interval elapsed
    const transport = fakeTransport({
      state: async (read: number) => stateOf([teamOf({ id: 'team-' + String(read), name: 'Squad ' + String(read) })]),
    })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    // When the refresh control is used
    click(view.container.querySelector('[aria-label="' + t('agents.refresh') + '"]') as Element)
    await flush()
    // Then a fresh read landed right away
    expect(view.container.textContent).toContain('Squad 2')
    expect(transport.reads).toBe(2)
  })

  it('operator sees a failed poll keep the last list and report it as a banner', async () => {
    // Given a Host that answers once and then breaks
    const transport = fakeTransport({
      state: async (read: number) => {
        if (read > 1) throw new Error('link lost')
        return stateOf([teamOf({ name: 'Squad one' })])
      },
    })
    // When the next poll fails
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    await advance(AGENTS_POLL_INTERVAL_MS)
    // Then the squad stays on screen and the failure is a non-blocking banner
    expect(view.container.textContent).toContain('Squad one')
    expect(view.container.querySelector('[data-dsh-part="agents-stale"]')?.textContent).toBe(t('error.unknown'))
  })
})
