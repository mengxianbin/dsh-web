/**
 * Browser-half entry for the dsh-sysmon plugin — runs inside the dsh web GUI.
 *
 * Registers the `sysmon` locale dictionaries and seats the chip into the
 * conversation session header's `actions` list slot (the row that holds the
 * agent-preset label). The chip id `sysmon` puts it in its own cell beside
 * the preset label; the host route 404 contract makes the whole thing hide
 * itself when the plugin is disabled, so no settings UI is required.
 * @module dsh-sysmon/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and its
// LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions hole).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SysmonChip } from './SysmonChip.tsx'
import { en, zh, type SysmonKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sysmon chip copy. */
    sysmon: SysmonKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'sysmon'

/** Unique occupant id inside the shared header-actions list slot. */
const ENTRY_ID = 'sysmon'

/** Services required by this plugin. */
export const inject = ['slots', 'locale']

/**
 * Register the sysmon surface: dictionaries plus the header chip.
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
}
