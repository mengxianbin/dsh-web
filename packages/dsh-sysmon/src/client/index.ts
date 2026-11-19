/**
 * Browser-half entry for the dsh-sysmon plugin — runs inside the dsh web GUI.
 *
 * Registers the `sysmon` locale dictionaries and seats the surface in three
 * positions: the composer row's trailing seat
 * (`conversation.composer.dock.trailing` — the four read-outs at the right
 * end of the row below the composer card, after the context meter; mounted
 * only while that row renders for an open, non-blank Session), the session
 * header's utilities (`conversation.session.header.utilities` — the glance
 * wall clock, order -20 so it lands left of the open-in-app control), and
 * the conversation header's `leading` cell (always rendered, covering the
 * no-session, blank-session, and single-View states the composer row never
 * mounts for; it carries its own clock cell because those states have no
 * utilities row). The chip id `sysmon` puts the primary copy in its own
 * dock cell; the two chip copies coordinate through client/presence.ts so
 * exactly one paints at a time. The host route 404 contract hides the
 * read-outs when the host half is off or disabled — the clock never rides
 * the payload, so time keeps walking either way, and no settings UI is
 * required.
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
import { SysmonChip, SysmonClock, SysmonFallbackChip } from './SysmonChip.tsx'
import { en, zh, type SysmonKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sysmon chip copy. */
    sysmon: SysmonKey
  }

  /**
   * Type-only shim for the two resident seats the pinned SDK cohort
   * (dsh-client-ui-conversation ^0.1.2-rc.1) predates, but which the
   * harness it runs against declares and renders. Mirrors the harness
   * declarations verbatim (`ui-conversation` apply.ts); delete once the
   * repo's SDK cohort reaches a conversation build that carries them.
   */
  interface SlotMap {
    'conversation.header.leading': { kind: 'single'; scope: 'root' }
    'conversation.composer.dock.trailing': { kind: 'list'; scope: 'session' }
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'sysmon'

/** Unique occupant id inside the composer row's trailing list slot. */
const ENTRY_ID = 'sysmon'

/** Unique occupant id inside the session header's utilities list slot. */
const CLOCK_ID = 'sysmon-clock'

/**
 * Utilities order for the clock: below the open-in-app control (-10), so the
 * clock reads as the right cluster's first cell — "row one, left of the
 * folder" — without touching the shipped controls' own ordering.
 */
const CLOCK_ORDER = -20

/** Services required by this plugin. */
export const inject = ['slots', 'locale']

/**
 * Register the sysmon surface: dictionaries plus the three seat registrations.
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

  // Primary seat: the composer row's trailing cell, right of the context
  // meter — off the title row so the Session title keeps its full width,
  // and at the row's right end where a trailing indicator belongs. Mounted
  // only while the composer row renders for an open, non-blank Session.
  ctx.slots.inject('conversation.composer.dock.trailing', () => {
    try {
      return ctx.slots.register({
        name: 'conversation.composer.dock.trailing',
        id: ENTRY_ID,
        // Ascending order: sole occupant today; later indicators sort after.
        order: 0,
        locale: NS,
      }, SysmonChip)
    } catch {
      return () => {}
    }
  })

  // The glance wall clock (2026-10-29 ruling: fullscreen work hides the OS
  // taskbar clock): the session header's utilities, own 1s timer, no payload
  // fetch — a dead host half cannot stop it.
  ctx.slots.inject('conversation.session.header.utilities', () => {
    try {
      return ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: CLOCK_ID,
        order: CLOCK_ORDER,
        locale: NS,
      }, SysmonClock)
    } catch {
      return () => {}
    }
  })

  // Fallback seat: the header's leading cell, the one header position that
  // renders with no Session and stays visible while a blank Session or a
  // single-View header hides the utilities row. Yields to the primary copy
  // via client/presence.ts, so the two never paint together; it carries its
  // own clock cell because these states have no utilities row.
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
