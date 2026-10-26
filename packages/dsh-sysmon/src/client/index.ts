/**
 * Browser-half entry for the dsh-sysmon plugin — runs inside the dsh web GUI.
 *
 * Registers the `sysmon` locale dictionaries and seats the chip in two
 * mutually exclusive header positions: the conversation session header's
 * `actions` list slot (the row that holds the agent-preset label; mounted only
 * for an open, non-blank Session) and the conversation header's `leading` cell
 * (always rendered, covering the no-session and blank-session states the
 * actions row never mounts for). The chip id `sysmon` puts the primary copy in
 * its own cell beside the preset label; the two copies coordinate through
 * client/presence.ts so exactly one paints at a time. The host route 404
 * contract makes the whole thing hide itself when the plugin is disabled, so
 * no settings UI is required.
 * @module dsh-sysmon/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and its
// LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the header holes).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SysmonChip, SysmonFallbackChip } from './SysmonChip.tsx'
import { en, zh, type SysmonKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sysmon chip copy. */
    sysmon: SysmonKey
  }

  /**
   * Type-only shim for the resident header-leading seat: the pinned SDK cohort
   * (dsh-client-ui-conversation ^0.1.2-rc.1) predates this slot, but the
   * harness it runs against declares and renders it. Mirrors the harness
   * declaration verbatim (`ui-conversation` apply.ts); delete once the repo's
   * SDK cohort reaches a conversation build that carries the slot.
   */
  interface SlotMap {
    'conversation.header.leading': { kind: 'single'; scope: 'root' }
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'sysmon'

/** Unique occupant id inside the shared header-actions list slot. */
const ENTRY_ID = 'sysmon'

/** Services required by this plugin. */
export const inject = ['slots', 'locale']

/**
 * Register the sysmon surface: dictionaries plus the two chip seats.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'sysmon: dictionaries')

  // Primary seat: the session-header actions row, beside the preset label.
  // Mounted only while an open, non-blank Session renders the header chrome.
  ctx.slots.inject('conversation.session.header.actions', () => {
    try {
      return ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: ENTRY_ID,
        // Ascending order: the preset label holds -10, ours sits after it.
        order: 10,
        locale: NS,
      }, SysmonChip)
    } catch {
      return () => {}
    }
  })

  // Fallback seat: the header's leading cell, the one header position that
  // renders with no Session and stays visible while a blank Session hides the
  // actions row. Yields to the primary copy via client/presence.ts, so the two
  // never paint together.
  ctx.slots.inject('conversation.header.leading', () => {
    try {
      return ctx.slots.register({
        name: 'conversation.header.leading',
        locale: NS,
      }, SysmonFallbackChip)
    } catch {
      return () => {}
    }
  })
}
