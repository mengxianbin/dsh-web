/**
 * dsh-task-fsm browser half — seats four occupants:
 * `sidebar.session.row.leading` (the ❄️/🔒 freeze mark, title = freeze
 * reason) and `sidebar.session.row.hover` (queue tier + §4.2 four-piece
 * sub-reasons + freeze reason line) read the host projection over
 * GET /api/task-fsm/session; `conversation.composer` elects the frozen
 * read-only takeover and `conversation.input.overlay` carries its
 * freshness watcher (frozen-open-1123, §3.5 点开形态). Absent record or
 * unreachable endpoint renders nothing (quiet absence). Declares no
 * settings section and binds no Session — the owner share is the row's id
 * only (ui-workspace contract: occupants must not retain the Session).
 * @module @linxin666/dsh-task-fsm/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { FsmHoverLines } from './FsmHoverLines.tsx'
import { FsmFreezeMark } from './FsmFreezeMark.tsx'
import { wireFrozenOpen } from './frozenOpen.ts'
import { NS, en, setRuntimeTranslate, zh } from './locales.ts'

/** Occupant ids (distinct per seat — one id each, no collisions). */
const MARK_ID = 'task-fsm-freeze-mark'
const HOVER_ID = 'task-fsm-hover-lines'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Leading cell of one Session row (freeze mark; owner share = row id only). */
    'sidebar.session.row.leading': { kind: 'list'; scope: 'root'; inline: true; owner: { readonly sessionId: string } }
    /** Hover-card section between relative time and trailing status line. */
    'sidebar.session.row.hover': { kind: 'list'; scope: 'root'; owner: { readonly sessionId: string } }
  }
}

/**
 * Client plugin body: register the dictionaries and the two row occupants.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'dsh-task-fsm: dictionaries')

  try {
    setRuntimeTranslate(ctx.locale.bind(NS) as (key: string) => string)
  } catch {
    // Locale service absent: locales.ts keeps the zh fallback.
  }

  ctx.slots.inject('sidebar.session.row.leading', () => {
    try {
      const unregister = ctx.slots.register({
        name: 'sidebar.session.row.leading',
        id: MARK_ID,
        order: 20,
        locale: NS,
      }, FsmFreezeMark)
      return () => {
        unregister()
      }
    } catch {
      return () => {}
    }
  })

  ctx.slots.inject('sidebar.session.row.hover', () => {
    try {
      const unregister = ctx.slots.register({
        name: 'sidebar.session.row.hover',
        id: HOVER_ID,
        order: 20,
        locale: NS,
      }, FsmHoverLines)
      return () => {
        unregister()
      }
    } catch {
      return () => {}
    }
  })

  // Frozen-open (frozen-open-1123): the composer takeover, its watcher and
  // the pending-interaction publish bridge.
  wireFrozenOpen(ctx)
}
