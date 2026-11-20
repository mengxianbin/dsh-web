// @vitest-environment jsdom
/**
 * First-open list state (#inventory-first-open-1120): while the very first
 * load is in flight the list says so instead of claiming there are no
 * sessions, and the refresh button asks the host for a rebuild
 * (`?fresh=1`) rather than the cached window it was already showing.
 */
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ArchiveApi } from '../src/client/api.ts'
import { ArchiveController } from '../src/client/archive-controller.ts'
import { en } from '../src/client/locales.ts'
import { SessionArchiveCard } from '../src/client/SessionArchiveCard.tsx'
import type { SessionArchiveConfig } from '../src/core/config.ts'
import type { ArchiveSessionRow, InventoryView } from '../src/core/types.ts'

/** Ready config form; the panel binds subscribe/getSnapshot before subscribing. */
class ReadyConfigForm implements ConfigForm<SessionArchiveConfig> {
  private readonly snapshot: ConfigFormSnapshot<SessionArchiveConfig>

  constructor(value: Partial<SessionArchiveConfig>) {
    this.snapshot = { status: 'ready', value, base: {}, user: {}, revision: 1, writable: true }
  }

  getSnapshot(): ConfigFormSnapshot<SessionArchiveConfig> {
    return this.snapshot
  }

  subscribe(): () => void {
    return () => {}
  }

  async set(): Promise<boolean> {
    return true
  }

  async unset(): Promise<boolean> {
    return true
  }

  async mutate(): Promise<boolean> {
    return true
  }
}

function row(overrides: Partial<ArchiveSessionRow> & { id: string }): ArchiveSessionRow {
  return {
    workspaceIds: [],
    archived: false,
    lastActivityReliable: true,
    running: false,
    blank: false,
    childIds: [],
    childCount: 0,
    issues: [],
    ...overrides,
  }
}

function makeInventory(rows: ArchiveSessionRow[]): InventoryView {
  return {
    generatedAt: 0,
    rows,
    workspaces: [],
    archivedSessionIds: [],
    auto: { cycleRunning: false },
  }
}

/** A full ArchiveApi whose inventory answers per test; the rest stay unused. */
function stubApi(overrides: Partial<ArchiveApi> = {}): ArchiveApi {
  const api: ArchiveApi = {
    inventory: () => Promise.resolve(makeInventory([])),
    preview: () => Promise.reject(new Error('not used')),
    archive: () => Promise.reject(new Error('not used')),
    unarchive: () => Promise.reject(new Error('not used')),
    deleteSessions: () => Promise.reject(new Error('not used')),
    autoPreview: () => Promise.reject(new Error('not used')),
    autoRun: () => Promise.reject(new Error('not used')),
    ...overrides,
  }
  return api
}

function mount(api: ArchiveApi): void {
  const controller = new ArchiveController({ api, sessions: undefined })
  render(createElement(SessionArchiveCard, {
    controller,
    settings: new ReadyConfigForm({}),
    close: () => {},
  }))
}

describe('archived-sessions card list state', () => {
  beforeEach(() => {
    // English document: the assertions read the en dictionary whichever way
    // the fallback chain resolves, never a hard-coded sentence.
    document.documentElement.lang = 'en'
  })

  afterEach(() => {
    cleanup()
    document.documentElement.lang = ''
  })

  it('user reads a loading line, not "no sessions", while the first load is in flight', () => {
    // Given a controller whose first inventory read never settles
    const api = stubApi({ inventory: () => new Promise<InventoryView>(() => {}) })

    // When the card mounts and its load is still pending
    mount(api)

    // Then the list says it is loading instead of claiming emptiness
    expect(screen.getByText(en['arch.loading'])).toBeTruthy()
    expect(screen.queryByText(en['arch.empty'])).toBeNull()
  })

  it('user reads the empty line once a load lands with nothing to show', async () => {
    // Given a controller whose inventory resolves with zero rows
    const api = stubApi({ inventory: () => Promise.resolve(makeInventory([])) })

    // When the card mounts and that load lands
    mount(api)

    // Then the list reports the truth about the data, not about the load
    await screen.findByText(en['arch.empty'])
    expect(screen.queryByText(en['arch.loading'])).toBeNull()
  })

  it('user asks the host for a rebuild when clicking refresh', async () => {
    // Given a card whose first load already landed with one row (the section
    // opens on the archived view, so the fixture row is archived)
    const inventoryCalls: ({ fresh?: boolean } | undefined)[] = []
    const api = stubApi({
      inventory: (options) => {
        inventoryCalls.push(options)
        return Promise.resolve(makeInventory([row({ id: 'session-a', title: 'Alpha', archived: true })]))
      },
    })
    mount(api)
    await screen.findByText('Alpha')

    // When the user clicks refresh
    fireEvent.click(screen.getByRole('button', { name: en['arch.refresh'] }))

    // Then that read asked for the fresh rebuild, unlike the initial load
    expect(inventoryCalls).toEqual([undefined, { fresh: true }])
    // And the button shows the refresh in flight while it waits
    expect(screen.getByRole('button', { name: en['arch.refreshing'] })).toBeTruthy()
  })

  it('keeps the rows on screen while a refresh waits', async () => {
    // Given a card holding one archived row (the default view) whose fresh read hangs
    let resolveFresh: ((inventory: InventoryView) => void) | undefined
    const api = stubApi({
      inventory: (options) => {
        if (options?.fresh === true) {
          return new Promise<InventoryView>((resolve) => { resolveFresh = resolve })
        }
        return Promise.resolve(makeInventory([row({ id: 'session-a', title: 'Alpha', archived: true })]))
      },
    })
    mount(api)
    await screen.findByText('Alpha')

    // When the user clicks refresh and it waits
    fireEvent.click(screen.getByRole('button', { name: en['arch.refresh'] }))

    // Then the old row never blanks out
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.queryByText(en['arch.loading'])).toBeNull()

    // When the rebuilt payload lands
    resolveFresh?.(makeInventory([row({ id: 'session-b', title: 'Beta', archived: true })]))
    await screen.findByText('Beta')
    expect(screen.queryByText('Alpha')).toBeNull()
  })
})
