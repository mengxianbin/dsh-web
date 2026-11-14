/**
 * Hide the official automation-tasks entry while the board is on.
 *
 * The shell mounts two scheduling surfaces side by side in the sidebar: the
 * official `ui-schedule` client half ("Automation tasks" — the Host Schedule
 * service's own page) and this package's board ("Task board" — a Host ledger
 * that runs real DSH sessions). The board is the family's complete surface, so
 * while it is enabled the official row is hidden and the sidebar offers one
 * scheduling entry instead of two.
 *
 * The shell owns that row: it renders the button, the label, the tooltip, the
 * active highlight and the collapsed rail, and the host's own end-to-end suite
 * addresses the row by its accessible name. The row is therefore located the
 * same way — the shell's global panel list seat (`sidebar.panellist`), whose
 * per-row anchor the slot renderer stamps — and it is identified by the label
 * the shell itself resolves for that entry (`resolveSlotLabel`, exactly the
 * call the shell's panel projection makes), so the match follows the active
 * language instead of a hard-coded translation.
 *
 * The write is one inline `display: none` on the shell's own button: the row
 * stays mounted (React keeps owning it) and the official panel keeps working
 * everywhere else it is reachable — only the duplicate sidebar entry goes
 * away. The board's master switch owns the state, exactly as it owns the
 * board's own row: with the board off, the official row comes back.
 */

import { resolveSlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { subscribeBodyInvalidations } from './body-mutations.ts'

/**
 * The official automation-tasks panel id.
 *
 * The host `ui-schedule` client half registers its sidebar row and its
 * center-column page under this id; the shell's panel projection addresses
 * both by it.
 */
export const OFFICIAL_SCHEDULE_PANEL_ID = 'schedules'

/** The shell's global panel list seat; every rendered panel row carries one anchor. */
const PANEL_LIST_SLOT = 'sidebar.panellist'

/** The anchor the slot renderer stamps for each global panel row. */
const PANEL_ROW_ANCHOR = `[data-slot="${PANEL_LIST_SLOT}"]`

/**
 * The family's own hook on a plugin-owned panel row.
 *
 * A row carrying it belongs to a plugin that owns its entry, never to the
 * official automation-tasks row, so the guard skips those rows: it must not
 * be able to hide the board's own entry.
 */
const PLUGIN_ROW_HOOK = '[data-dsh-panel-entry]'

/** The slot-service slice the guard reads. */
export interface PanelSlotReader {
  entriesOfSlot?(key: string): readonly StoredEntry[]
}

/** The context slice the guard needs. */
export interface ScheduleRowGuardContext {
  slots?: PanelSlotReader
}

/**
 * The live panel-list ledger, or an empty one.
 *
 * A context that serves no slot registry (a capture-only test context, or a
 * shell that never declared the seat) has no official row to hide, and the
 * guard must read that as "nothing to do" instead of failing the page.
 * @param ctx - the client context.
 * @returns the panel-list entries the shell currently projects.
 */
function panelEntries(ctx: ScheduleRowGuardContext): readonly StoredEntry[] {
  const reader = ctx.slots
  if (reader === undefined || typeof reader.entriesOfSlot !== 'function') return []
  try {
    return reader.entriesOfSlot(PANEL_LIST_SLOT) ?? []
  } catch {
    return []
  }
}

/** The guard's controls. */
export interface ScheduleRowGuard {
  /** Hide the official row, and keep it hidden while the board is on. */
  hide(): void
  /** Restore the official row: the board's master switch is off. */
  show(): void
  /** Release the listeners and restore the row. */
  dispose(): void
}

/**
 * The accessible name the shell renders on the official automation-tasks row.
 *
 * The shell projects its panel list with `resolveSlotLabel(options.label) ??
 * id`, and that value becomes the row's accessible name. Reading the same
 * value out of the same ledger is what keeps the DOM match correct in every
 * language.
 * @param entries - the live panel-list ledger.
 * @returns the row's accessible name, or undefined when the official panel is not mounted.
 */
export function officialScheduleRowLabel(entries: readonly StoredEntry[]): string | undefined {
  const entry = entries.find(candidate => candidate.options.id === OFFICIAL_SCHEDULE_PANEL_ID)
  if (entry === undefined) return undefined
  try {
    return resolveSlotLabel(entry.options.label) ?? entry.options.id
  } catch {
    // A label thunk that throws must not take the sidebar down with it.
    return undefined
  }
}

/**
 * The shell's button for the panel row carrying this accessible name.
 *
 * Every global panel row renders one slot anchor inside the shell's own
 * button, so the anchor is the row's handle and the button is what the user
 * sees. Rows a plugin owns (they carry the family's own entry hook) are
 * skipped.
 * @param root - the document (or a subtree) to search.
 * @param label - the accessible name to match.
 * @returns the row button, or undefined when no row carries that name.
 */
export function findPanelRow(root: ParentNode, label: string): HTMLElement | undefined {
  for (const anchor of root.querySelectorAll(PANEL_ROW_ANCHOR)) {
    if (anchor.querySelector(PLUGIN_ROW_HOOK) !== null) continue
    const button = anchor.closest('button') as HTMLElement | null
    if (button !== null && button.getAttribute('aria-label') === label) return button
  }
  return undefined
}

/**
 * Guard the official automation-tasks row against the board's presence.
 *
 * The guard hides the row while the board is enabled and restores it when the
 * board is switched off. It re-applies its write after every DOM change,
 * because the shell owns the row and may mount or replace it at any time (a
 * re-render, a panel-list change, the official plugin arriving late).
 * @param ctx - client context carrying the slot registry.
 * @param root - the document to search; defaults to the ambient one.
 * @returns the guard's controls.
 */
export function createScheduleRowGuard(ctx: ScheduleRowGuardContext, root?: ParentNode): ScheduleRowGuard {
  const scope = root ?? (typeof document === 'undefined' ? undefined : document)
  let hidden: HTMLElement | undefined
  let previousDisplay: string | null = null
  let stopWatching: (() => void) | undefined

  const restoreRow = (): void => {
    if (hidden === undefined) return
    const button = hidden
    hidden = undefined
    if (previousDisplay === null) button.style.removeProperty('display')
    else button.style.setProperty('display', previousDisplay)
    previousDisplay = null
  }

  const hideRow = (): void => {
    if (scope === undefined) return
    const label = officialScheduleRowLabel(panelEntries(ctx))
    if (label === undefined) return
    const button = findPanelRow(scope, label)
    if (button === undefined) return
    if (hidden === button) return
    restoreRow()
    hidden = button
    previousDisplay = button.style.getPropertyValue('display')
    // The shell's own row rule sets a display value, so the write has to beat
    // it: an inline declaration outranks any author rule that is not itself
    // important, and the important flag also survives a skin's own overrides.
    button.style.setProperty('display', 'none', 'important')
  }

  const sync = (): void => {
    // A replaced row is a new element: the old write died with it.
    if (hidden !== undefined && !hidden.isConnected) restoreRow()
    hideRow()
  }

  const hide = (): void => {
    hideRow()
    if (stopWatching === undefined) {
      // The page-wide hub: one body observer for every family consumer, and
      // the row is re-hidden after whatever the shell did to the DOM.
      stopWatching = subscribeBodyInvalidations(sync)
    }
  }

  const show = (): void => {
    stopWatching?.()
    stopWatching = undefined
    restoreRow()
  }

  return { hide, show, dispose: show }
}
