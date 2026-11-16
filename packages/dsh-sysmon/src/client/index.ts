/**
 * Browser-half entry for the dsh-sysmon plugin — runs inside the dsh web GUI.
 *
 * Registers the `sysmon` locale dictionaries and seats the chip in two
 * mutually exclusive header positions: the conversation session header's view
 * tab row trailing seat (`conversation.session.header.views.trailing`, right
 * of the More launcher; mounted only while the tab row renders for an open,
 * non-blank Session with two or more Views) and the conversation header's
 * `leading` cell (always rendered, covering the no-session, blank-session,
 * and single-View states the tab row never mounts for). The chip id `sysmon`
 * puts the primary copy in its own cell after More; the two copies coordinate
 * through client/presence.ts so exactly one paints at a time. The host route
 * 404 contract makes the whole thing hide itself when the plugin is disabled,
 * so no settings UI is required.
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
   * Type-only shim for the two resident header seats: the pinned SDK cohort
   * (dsh-client-ui-conversation ^0.1.2-rc.1) predates both slots, but the
   * harness it runs against declares and renders them. Mirrors the harness
   * declarations verbatim (`ui-conversation` apply.ts); delete once the repo's
   * SDK cohort reaches a conversation build that carries both slots.
   */
  interface SlotMap {
    'conversation.header.leading': { kind: 'single'; scope: 'root' }
    'conversation.session.header.views.trailing': { kind: 'list'; scope: 'session' }
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'sysmon'

/** Unique occupant id inside the shared tab-row trailing list slot. */
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

  // Primary seat: the view tab row's trailing cell, right of the More
  // launcher — off the title row so the Session title keeps its full width.
  // Mounted only while the tab row renders for an open, non-blank Session
  // with two or more Views.
  ctx.slots.inject('conversation.session.header.views.trailing', () => {
    try {
      return ctx.slots.register({
        name: 'conversation.session.header.views.trailing',
        id: ENTRY_ID,
        // Ascending order: sole occupant today; later indicators sort after.
        order: 0,
        locale: NS,
      }, SysmonChip)
    } catch {
      return () => {}
    }
  })

  // Fallback seat: the header's leading cell, the one header position that
  // renders with no Session and stays visible while a blank Session or a
  // single-View header hides the tab row. Yields to the primary copy via
  // client/presence.ts, so the two never paint together.
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
