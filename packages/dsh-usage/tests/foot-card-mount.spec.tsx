/** @vitest-environment jsdom */

/**
 * Sidebar foot card mounting: the container seats in the shell foot area
 * directly above the Settings row (keeping Settings the terminal row),
 * self-heals through the shared body-mutation hub when the shell re-renders
 * around it, stays single under duplicate mounts, and opens the usage section
 * through the shell's settings store with a DOM replay as the fallback.
 * The React body is covered by foot-card.spec.tsx; here only DOM placement
 * and the settings-navigation paths are under test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  FOOT_CARD_SELECTOR, mountUsageFootCard, openUsageSettings, settingsShellStore,
  type SettingsShellStore, type SlotSeatReader,
} from '../src/client/foot-card-mount.tsx'
import type { UsageFootCardProps } from '../src/client/UsageFootCard.tsx'
import type { UsageSettings } from '../src/client/UsageSectionCard.tsx'
import type { UsageStoreInstance, UsageUiState } from '../src/client/usage-store.ts'

/** The section id the apply body registers and the store must select. */
const SECTION_ID = 'dsh-usage'

/** The section's nav label in the shell's zh locale. */
const SECTION_LABEL = '使用统计'

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.lang = ''
})

/** A minimal shell: the sidebar column with its foot area (actions above the Settings seat). */
function shell(): { column: HTMLElement; foot: HTMLElement; settingsArea: HTMLElement } {
  const column = document.createElement('div')
  column.setAttribute('data-pane', 'sidebar')
  const foot = document.createElement('div')
  foot.className = 'SidebarRoot-footArea-x'
  const actions = document.createElement('div')
  actions.className = 'SidebarRoot-footerActions-x'
  const settingsArea = document.createElement('div')
  settingsArea.className = 'SidebarRoot-settingsArea-x'
  foot.append(actions, settingsArea)
  column.append(foot)
  document.body.append(column)
  return { column, foot, settingsArea }
}

/** Mount props over a loading store; the React body is not under test here. */
function mountProps(extra: Partial<UsageFootCardProps> = {}): UsageFootCardProps {
  const state: UsageUiState = { snapshot: null, status: 'loading', error: null }
  const store = { subscribe: () => () => {}, getSnapshot: () => state } as unknown as UsageStoreInstance
  const snapshot: ConfigFormSnapshot<UsageSettings> = {
    status: 'ready',
    value: { enabled: false },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
  }
  const settings = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: () => Promise.resolve(true),
    unset: () => Promise.resolve(false),
    mutate: () => Promise.resolve(false),
  } as unknown as ConfigForm<UsageSettings>
  return { store, poll: () => {}, onOpen: () => {}, settings, ...extra }
}

/** A settings nav panel carrying one clickable row per label, mounted by a launcher. */
function panel(labels: string[]): HTMLElement {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const nav = document.createElement('nav')
  for (const label of labels) {
    const row = document.createElement('button')
    row.type = 'button'
    row.textContent = label
    row.addEventListener('click', () => { row.dataset.clicked = 'true' })
    nav.append(row)
  }
  dialog.append(nav)
  return dialog
}

/** The shell's own gear: a dialog trigger that mounts the panel on click. */
function gearTrigger(labels: string[]): { button: HTMLButtonElement; clicks: () => number } {
  let clicks = 0
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-haspopup', 'dialog')
  button.addEventListener('click', () => {
    clicks += 1
    document.body.append(panel(labels))
  })
  return { button, clicks: () => clicks }
}

/**
 * The account row: a menu launcher occupying settings.launcher. Its first item
 * is Settings, which mounts the panel — the shape the reported bug landed in.
 */
function accountRow(labels: string[]): {
  button: HTMLButtonElement
  clicks: () => number
  itemClicks: () => number
} {
  let clicks = 0
  let itemClicks = 0
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-haspopup', 'menu')
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const settingsItem = document.createElement('button')
  settingsItem.type = 'button'
  settingsItem.setAttribute('role', 'menuitem')
  settingsItem.textContent = '设置'
  settingsItem.addEventListener('click', () => {
    itemClicks += 1
    menu.remove()
    document.body.append(panel(labels))
  })
  menu.append(settingsItem)
  button.addEventListener('click', () => {
    clicks += 1
    document.body.append(menu)
  })
  return { button, clicks: () => clicks, itemClicks: () => itemClicks }
}

/** The shell settings store handle recording every section it is asked to open. */
function shellStore(): { store: SettingsShellStore; opened: string[] } {
  const opened: string[] = []
  return {
    store: { create: () => ({ actions: { openSection: (id: string) => { opened.push(id) } } }) },
    opened,
  }
}

describe('mountUsageFootCard placement', () => {
  it('user finds the card directly above the sidebar Settings row', () => {
    // Given the shell sidebar with its foot area
    const { foot, settingsArea } = shell()

    // When the foot card mounts
    const dispose = mountUsageFootCard(mountProps())

    // Then its container sits just before the Settings seat, which stays last
    const container = document.querySelector(FOOT_CARD_SELECTOR)
    expect(container?.parentElement).toBe(foot)
    expect(container?.nextElementSibling).toBe(settingsArea)
    expect(foot.lastElementChild).toBe(settingsArea)
    dispose()
  })

  it('user keeps exactly one card when the mount runs twice', () => {
    // Given one mounted card
    shell()
    const first = mountUsageFootCard(mountProps())

    // When a duplicate apply mounts again
    const second = mountUsageFootCard(mountProps())

    // Then the second mount is an inert no-op and the foot still carries one card
    expect(document.querySelectorAll(FOOT_CARD_SELECTOR)).toHaveLength(1)
    second()
    expect(document.querySelectorAll(FOOT_CARD_SELECTOR)).toHaveLength(1)
    first()
    expect(document.querySelectorAll(FOOT_CARD_SELECTOR)).toHaveLength(0)
  })

  it('user keeps the card directly above Settings when the shell inserts a node between them', async () => {
    // Given a mounted card seated directly above the Settings seat
    const { foot, settingsArea } = shell()
    const dispose = mountUsageFootCard(mountProps())
    const container = document.querySelector(FOOT_CARD_SELECTOR)

    // When the shell re-renders and a foreign node lands between the two
    foot.insertBefore(document.createElement('div'), settingsArea)

    // Then the next body-mutation flush re-seats the card above Settings
    await vi.waitFor(() => {
      expect(container?.nextElementSibling).toBe(settingsArea)
    })
    dispose()
  })

  it('user keeps the card when the shell rebuilds the whole sidebar pane', async () => {
    // Given a mounted card whose sidebar pane is torn down
    const first = shell()
    const dispose = mountUsageFootCard(mountProps())
    const container = document.querySelector(FOOT_CARD_SELECTOR)

    // When the shell rebuilds the pane from scratch
    first.column.remove()
    const second = shell()

    // Then the card re-seats into the new foot area, again above Settings
    await vi.waitFor(() => {
      expect(container?.parentElement).toBe(second.foot)
      expect(container?.nextElementSibling).toBe(second.settingsArea)
    })
    dispose()
  })

  it('user loses the card once the plugin unmounts it', () => {
    // Given a mounted card
    shell()
    const dispose = mountUsageFootCard(mountProps())
    expect(document.querySelectorAll(FOOT_CARD_SELECTOR)).toHaveLength(1)

    // When the apply body disposes the mount
    dispose()

    // Then the container leaves the sidebar foot
    expect(document.querySelectorAll(FOOT_CARD_SELECTOR)).toHaveLength(0)
  })
})

describe('settingsShellStore seat lookup', () => {
  it('user reads the shell settings store from the settings seat', () => {
    // Given the shell registered its settings shell with a store seat
    const { store } = shellStore()
    const slots: SlotSeatReader = { entries: () => [{ store }] }

    // When the card resolves the seat
    const resolved = settingsShellStore(slots)

    // Then it gets the shell's own handle back, not a copy
    expect(resolved).toBe(store)
  })

  it('user degrades to the DOM replay when the settings seat carries no store', () => {
    // Given a shell whose seat is unregistered, storeless, or torn down
    const { store } = shellStore()
    const empty: SlotSeatReader = { entries: () => [] }
    const storeless: SlotSeatReader = { entries: () => [{ store: {} }] }
    const tornDown: SlotSeatReader = { entries: () => { throw new Error('registry closed') } }

    // When the card resolves each seat
    // Then every shape yields no handle, so the replay path owns the click
    expect(settingsShellStore(empty)).toBeUndefined()
    expect(settingsShellStore(storeless)).toBeUndefined()
    expect(settingsShellStore(tornDown)).toBeUndefined()
    expect(settingsShellStore(undefined)).toBeUndefined()
    expect(settingsShellStore({ entries: () => [{ store }] })).toBe(store)
  })
})

describe('openUsageSettings store path', () => {
  it('user lands on the usage section through the seat store while an account row owns the launcher', () => {
    // Given an account row occupying settings.launcher and a shell store seat
    const { settingsArea } = shell()
    const account = accountRow(['General', SECTION_LABEL])
    settingsArea.append(account.button)
    const opened: string[] = []
    const store: SettingsShellStore = { create: () => ({ actions: { openSection: (id) => { opened.push(id) } } }) }

    // When the card opens settings
    openUsageSettings({ id: SECTION_ID, label: () => SECTION_LABEL, store })

    // Then the store opens the section itself, so no account menu ever opens
    expect(opened).toEqual([SECTION_ID])
    expect(account.clicks()).toBe(0)
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0)
  })

  it('user still reaches the panel when the seat store rejects the call', async () => {
    // Given a foreign store seat that throws and the shell's gear in the seat
    const { settingsArea } = shell()
    const gear = gearTrigger(['General', SECTION_LABEL])
    settingsArea.append(gear.button)
    const store: SettingsShellStore = { create: () => { throw new Error('not a settings shell') } }

    // When the card opens settings
    openUsageSettings({ id: SECTION_ID, label: () => SECTION_LABEL, store })

    // Then the DOM replay opens the panel and selects the usage row
    await vi.waitFor(() => {
      expect(gear.clicks()).toBe(1)
      const usageRow = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')]
        .find((row) => row.textContent?.includes(SECTION_LABEL))
      expect(usageRow?.dataset.clicked).toBe('true')
    })
  })
})

describe('openUsageSettings navigation replay', () => {
  it('user lands on the usage section when the card opens settings', async () => {
    // Given the shell sidebar whose Settings trigger opens a panel with a usage row
    const { settingsArea } = shell()
    const gear = gearTrigger(['General', SECTION_LABEL])
    settingsArea.append(gear.button)

    // When the card's open path runs
    openUsageSettings({ id: SECTION_ID, label: () => SECTION_LABEL })

    // Then the trigger opens the panel and the usage nav row gets selected
    await vi.waitFor(() => {
      expect(gear.clicks()).toBe(1)
      expect(document.querySelectorAll('[role="dialog"] nav button')).toHaveLength(2)
      const usageRow = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')]
        .find((row) => row.textContent?.includes(SECTION_LABEL))
      expect(usageRow?.dataset.clicked).toBe('true')
    })
    // And the foreign row stays untouched
    const general = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')]
      .find((row) => row.textContent === 'General')
    expect(general?.dataset.clicked).toBeUndefined()
  })

  it('user reaches the panel through the dialog trigger, not a menu sitting beside it', async () => {
    // Given a settings seat where the account row precedes the shell's gear
    const { settingsArea } = shell()
    const account = accountRow(['General', SECTION_LABEL])
    const gear = gearTrigger(['General', SECTION_LABEL])
    settingsArea.append(account.button, gear.button)

    // When the card's open path runs
    openUsageSettings({ id: SECTION_ID, label: () => SECTION_LABEL })

    // Then the dialog trigger is clicked and the account menu stays shut
    await vi.waitFor(() => {
      expect(gear.clicks()).toBe(1)
      const usageRow = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')]
        .find((row) => row.textContent?.includes(SECTION_LABEL))
      expect(usageRow?.dataset.clicked).toBe('true')
    })
    expect(account.clicks()).toBe(0)
  })

  it('user reaches the panel through the account menu when no gear is mounted', async () => {
    // Given a settings seat carrying only the account row (the reported shell)
    const { settingsArea } = shell()
    const account = accountRow(['General', SECTION_LABEL])
    settingsArea.append(account.button)

    // When the card's open path runs
    openUsageSettings({ id: SECTION_ID, label: () => SECTION_LABEL })

    // Then the account menu opens, its first Settings item runs, and the usage row is selected
    await vi.waitFor(() => {
      expect(account.clicks()).toBe(1)
      expect(account.itemClicks()).toBe(1)
      const usageRow = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')]
        .find((row) => row.textContent?.includes(SECTION_LABEL))
      expect(usageRow?.dataset.clicked).toBe('true')
    })
  })

  it('user keeps the already open panel when its nav lacks the usage row', () => {
    // Given an already open settings panel without the usage section
    const open = panel(['General'])
    document.body.append(open)
    const { settingsArea } = shell()
    const gear = gearTrigger(['General'])
    settingsArea.append(gear.button)

    // When the card's open path runs
    openUsageSettings({ id: SECTION_ID, label: () => SECTION_LABEL })

    // Then the launcher never toggles the open panel shut and no foreign row is clicked
    expect(gear.clicks()).toBe(0)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    const general = document.querySelector<HTMLButtonElement>('[role="dialog"] nav button')
    expect(general?.dataset.clicked).toBeUndefined()
  })
})
