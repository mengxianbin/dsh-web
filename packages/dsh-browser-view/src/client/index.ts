/**
 * Browser-half entry for the browser-view plugin - runs inside the dsh web GUI.
 *
 * The browser view is a tab in the official right sidebar, beside the
 * conversation, not a page that takes the whole window. It contributes exactly
 * the seats a tab type needs, and only those:
 * - `sidebarRightTabs.register` (stage one): the static tab type - its id, its
 *   kind ('browser-view'), the band it ranks in, the chip's initial text and the
 *   guide capsule that opens it from the column's own tab strip.
 * - 'sidebar.right.pane.tab' + 'sidebar.right.pane.tab.title' (stage two, one
 *   keyed registration each under the SAME id): the tab's body and its chip
 *   contents, which is exactly the shape the shipped terminal tab uses.
 *
 * The session-header shortcut is deliberately gone: the column's tab strip and
 * the guide capsule already open the tab, so a second entry in the conversation
 * header only crowded that row.
 *
 * `main` and 'sidebar.panellist' are deliberately NOT registered any more: the
 * first took the whole center column over, and the second put a row in the
 * shell's global panel list that addressed that column. A right-sidebar tab
 * needs neither.
 *
 * The two slot seats go through `ctx.slots.inject` so the contribution waits for
 * the owning plugin to declare the seat: load order between this plugin and the
 * sidebar plugin therefore does not matter, and a shell that cannot serve a seat
 * simply leaves the surface absent.
 *
 * Export discipline (packages/AGENTS.md): the /client surface carries only what
 * cordis loading needs plus types.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and its
// LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer's ctx.slots merge (the slot registry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the sidebar service's Context merge (ctx.sidebarRightTabs) and
// the two pane SlotMap declarations it owns.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createLiveTitleStore } from './live-title.ts'
import { en, zh, type BrowserViewKey } from './locales.ts'
import { BrowserViewPanel } from './panel.tsx'
import { BROWSER_VIEW_TAB_ID, browserViewTabDefinition } from './tab-type.ts'
import { BrowserViewTabTitle } from './tab-title.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Browser-view surface copy. */
    'browser-view': BrowserViewKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'browser-view'

/** Services required by this plugin. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Register the browser-view tab type and its surfaces.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'browser-view: dictionaries')

  // The tab type's chip text and the guide capsule's copy are resolved on every
  // read, so the thunk below must translate at call time rather than bake a
  // language in at boot.
  let translate: ((key: BrowserViewKey) => string) | undefined
  try {
    translate = ctx.locale.bind(NS)
  } catch {
    // A locale face that cannot bind leaves the chip on its source-language copy.
  }
  const copy = (key: BrowserViewKey): string => translate?.(key) ?? zh[key]

  // Stage one: the static type. Without it an open of this kind throws, so the
  // registration is the seat everything else depends on - the column's tab strip
  // and its guide capsule both read this definition to offer the tab.
  ctx.effect(() => {
    try {
      return ctx.sidebarRightTabs.register(browserViewTabDefinition(copy))
    } catch {
      return () => {}
    }
  }, 'browser-view: tab type')

  // The one channel between the tab body and its own chip: the body learns the
  // streamed page's title, the chip shows it.
  const liveTitle = createLiveTitleStore()

  // Stage two, body: the tab's content, under the type's own id.
  ctx.slots.inject('sidebar.right.pane.tab', () => {
    try {
      return ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: BROWSER_VIEW_TAB_ID,
          locale: NS,
          inject: (sessionId: string) => ({ sessionId, liveTitle }),
        },
        BrowserViewPanel,
      )
    } catch {
      return () => {}
    }
  })

  // Stage two, title: the chip's contents, same key, same face.
  ctx.slots.inject('sidebar.right.pane.tab.title', () => {
    try {
      return ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab.title',
          key: BROWSER_VIEW_TAB_ID,
          locale: NS,
          inject: (sessionId: string) => ({ sessionId, liveTitle }),
        },
        BrowserViewTabTitle,
      )
    } catch {
      return () => {}
    }
  })
}

export type { BrowserViewPanelFace, BrowserViewPanelProps, BrowserViewSocketFactory } from './panel.tsx'
export type { BrowserViewLiveTitleStore } from './live-title.ts'
export type { BrowserViewTabParams } from './tab-type.ts'
export type { BrowserViewTabTitleFace, BrowserViewTabTitleProps } from './tab-title.tsx'
export type { BrowserViewFrame, BrowserViewSocketStatus } from './socket.ts'
export type { BrowserViewKey } from './locales.ts'
