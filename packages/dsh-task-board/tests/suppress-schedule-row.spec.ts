// @vitest-environment jsdom
/**
 * The official automation-tasks entry is hidden while the board is on.
 *
 * The shell mounts two scheduling rows in the same sidebar: the official
 * "Automation tasks" row (the host `ui-schedule` client half) and the board's
 * own row. The board is the family's complete surface, so its master switch
 * hides the official row while it is on and brings it back when it is off.
 *
 * The row belongs to the shell: the guard locates it in the shell's global
 * panel list seat and identifies it by the label the shell itself resolves,
 * so the assertions here pin that contract (the anchor, the accessible name,
 * and the plugin-owned rows the guard must never touch).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createScheduleRowGuard,
  findPanelRow,
  officialScheduleRowLabel,
  OFFICIAL_SCHEDULE_PANEL_ID,
  type ScheduleRowGuard,
} from '../src/client/suppress-schedule-row.ts'

/** One row of the shell's global panel list. */
interface RowSpec {
  /** The accessible name the shell renders on the row. */
  label: string
  /** Set when the row is a plugin's own entry (the family stamps its own hook). */
  pluginHook?: string
}

/** Render the shell's panel list: one button per row, each holding one slot anchor. */
function renderPanelList(rows: readonly RowSpec[]): void {
  document.body.replaceChildren()
  const list = document.createElement('nav')
  for (const row of rows) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', row.label)
    const glyph = document.createElement('span')
    const anchor = document.createElement('div')
    anchor.setAttribute('data-slot', 'sidebar.panellist')
    anchor.style.display = 'contents'
    if (row.pluginHook !== undefined) {
      const owned = document.createElement('svg')
      owned.setAttribute('data-dsh-panel-entry', row.pluginHook)
      anchor.append(owned)
    }
    glyph.append(anchor)
    button.append(glyph)
    list.append(button)
  }
  document.body.append(list)
}

/** The live panel-list ledger the shell projects its rows from. */
function ledger(rows: readonly { id: string; label: string }[]): StoredEntry[] {
  return rows.map(row => ({
    component: () => null,
    options: { id: row.id, label: () => row.label, order: 0 },
  }))
}

/** A client context carrying only the slot registry the guard reads. */
function context(entries: readonly StoredEntry[]): { slots: { entriesOfSlot: (key: string) => readonly StoredEntry[] } } {
  return { slots: { entriesOfSlot: () => entries } }
}

/** The row button carrying this accessible name, if the list renders it. */
function rowButton(label: string): HTMLElement | undefined {
  for (const button of document.querySelectorAll('button')) {
    if (button.getAttribute('aria-label') === label) return button as HTMLElement
  }
  return undefined
}

/** Whether the row is hidden from the sidebar. */
function hidden(label: string): boolean {
  return rowButton(label)?.style.getPropertyValue('display') === 'none'
}

/** Wait for the shared body hub to flush and re-apply the write. */
async function waitForHiddenRow(label: string): Promise<void> {
  await vi.waitFor(() => {
    expect(hidden(label)).toBe(true)
  })
}

const guards: ScheduleRowGuard[] = []

afterEach(() => {
  for (const guard of guards.splice(0)) guard.dispose()
  document.body.replaceChildren()
})

describe('the official automation-tasks row', () => {
  it('operator sees the official row hidden while the board is on', () => {
    // Given the shell's panel list with the official row and the board's row
    renderPanelList([
      { label: 'Plugins' },
      { label: 'Automation tasks' },
      { label: 'Task board', pluginHook: 'task-board' },
    ])
    const guard = createScheduleRowGuard(context(ledger([
      { id: 'plugins', label: 'Plugins' },
      { id: OFFICIAL_SCHEDULE_PANEL_ID, label: 'Automation tasks' },
      { id: 'task-board', label: 'Task board' },
    ])))
    guards.push(guard)

    // When the board switches on
    guard.hide()

    // Then the official row is gone and the other rows stay
    expect(hidden('Automation tasks')).toBe(true)
    expect(hidden('Plugins')).toBe(false)
    expect(hidden('Task board')).toBe(false)
  })

  it('operator sees the official row come back when the board is off', () => {
    // Given a hidden official row
    renderPanelList([{ label: 'Plugins' }, { label: 'Automation tasks' }])
    const guard = createScheduleRowGuard(context(ledger([
      { id: 'plugins', label: 'Plugins' },
      { id: OFFICIAL_SCHEDULE_PANEL_ID, label: 'Automation tasks' },
    ])))
    guards.push(guard)
    guard.hide()
    expect(hidden('Automation tasks')).toBe(true)

    // When the board switches off
    guard.show()

    // Then the official row is visible again
    expect(hidden('Automation tasks')).toBe(false)
    expect(rowButton('Automation tasks')?.style.getPropertyValue('display')).toBe('')
  })

  it('operator sees nothing hidden on a deployment without the official plugin', () => {
    // Given a panel list without the official row
    renderPanelList([{ label: 'Plugins' }, { label: 'Task board', pluginHook: 'task-board' }])
    const guard = createScheduleRowGuard(context(ledger([
      { id: 'plugins', label: 'Plugins' },
      { id: 'task-board', label: 'Task board' },
    ])))
    guards.push(guard)

    // When the board switches on
    guard.hide()

    // Then no row is touched
    expect(hidden('Plugins')).toBe(false)
    expect(hidden('Task board')).toBe(false)
  })

  it('operator sees the board own row never hidden', () => {
    // Given a panel list whose board row carries the family own hook
    renderPanelList([{ label: 'Task board', pluginHook: 'task-board' }])
    const guard = createScheduleRowGuard(context(ledger([
      { id: 'task-board', label: 'Task board' },
    ])))
    guards.push(guard)

    // When the board switches on
    guard.hide()

    // Then its own row stays visible
    expect(hidden('Task board')).toBe(false)
  })

  it('operator sees the row hidden again after the shell replaces it', async () => {
    // Given a hidden official row
    renderPanelList([{ label: 'Automation tasks' }])
    const guard = createScheduleRowGuard(context(ledger([
      { id: OFFICIAL_SCHEDULE_PANEL_ID, label: 'Automation tasks' },
    ])))
    guards.push(guard)
    guard.hide()
    expect(hidden('Automation tasks')).toBe(true)

    // When the shell re-renders the panel list with a fresh row
    renderPanelList([{ label: 'Automation tasks' }])
    await waitForHiddenRow('Automation tasks')

    // Then the new row is hidden too
    expect(hidden('Automation tasks')).toBe(true)
  })

  it('operator sees the label read from the shell own projection', () => {
    // Given the shell's ledger and the row it renders for the official entry
    const entries = ledger([{ id: OFFICIAL_SCHEDULE_PANEL_ID, label: '自动化任务' }])
    renderPanelList([{ label: '自动化任务' }])

    // When the guard reads the accessible name and looks the row up
    const label = officialScheduleRowLabel(entries)
    const row = label === undefined ? undefined : findPanelRow(document, label)

    // Then both are the shell's own values, and a label nobody renders matches no row
    expect(label).toBe('自动化任务')
    expect(row).toBe(rowButton('自动化任务'))
    expect(findPanelRow(document, 'Automation tasks')).toBeUndefined()
  })
})
