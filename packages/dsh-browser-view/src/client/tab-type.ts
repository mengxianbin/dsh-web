/**
 * The right-sidebar tab type this plugin contributes: its kind, its identity,
 * the navigation parameters it accepts, and the guide capsule that opens it.
 *
 * A tab type is registered in two stages. Stage one is a purely static
 * declaration (ctx.sidebarRightTabs.register) naming the kind, the chip's
 * initial text and the guide entry; stage two is the keyed 'sidebar.right.pane.tab'
 * body and 'sidebar.right.pane.tab.title' registration under this same id, which
 * is what the seat dispatches on. The kind is what openTabIn/openTab name, and
 * it is also the key of the params map below.
 *
 * The `guide` entry is what puts this type on the right sidebar's guide page -
 * the list a user sees when the column has no page in front. It is the one place
 * that opens the tab now that the conversation header carries no entry of its
 * own, and the guide owns the click:
 * it renders one capsule per registered entry and opens the entry's own `kind`
 * (GuideBody: tab.actions.openTab(entry.kind, { replaceTab: true })), so this
 * plugin declares the capsule and never wires a handler of its own. No
 * commandId is declared: the plugin registers no keyboard shortcut, and the
 * guide would draw a key hint the shortcut table cannot honour.
 *
 * The kind is deliberately NOT 'browser': the shipped
 * @deepseek-ai/dsh-client-ui-sidebar-browser registers that kind, and a
 * registration in the extension band takes a kind over, so reusing it would
 * shadow the shipped browser tab out of existence - the one thing this
 * package's AGENTS.md forbids. A distinct kind is what lets both live in the
 * same column.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { BrowserViewGuideGlyph } from './guide-icon.tsx'
import type { BrowserViewKey } from './locales.ts'

/** What this plugin's tabs are, and what openTabIn/openTab name. */
export const BROWSER_VIEW_TAB_KIND = 'browser-view'

/** This implementation's identity in the tab system; also the keyed slot dispatch key. */
export const BROWSER_VIEW_TAB_ID = '@linxin666/dsh-client-ui-browser-view'

/** Identity of this type's capsule on the guide page, stable within the provider. */
export const BROWSER_VIEW_GUIDE_ENTRY_ID = 'open'

/**
 * Position of this type's capsule among every registered type's entries. The
 * shipped browser tab sits at 30; this one follows it instead of competing for
 * the same slot, because it is a companion view rather than a replacement.
 */
export const BROWSER_VIEW_GUIDE_ENTRY_ORDER = 40

/** Navigation parameters this tab type accepts. */
export interface BrowserViewTabParams {
  /** Chrome tab the pane should stream first, when the opener knows one. */
  readonly tabId?: string
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Parameters of a browser-view page. */
    'browser-view': BrowserViewTabParams
  }
}

/**
 * Build stage one of the registration.
 * @param t - translate function of this plugin's dictionary.
 * @returns the static tab type the registry keeps.
 */
export function browserViewTabDefinition(t: (key: BrowserViewKey) => string): SidebarRightTabDefinition {
  return {
    id: BROWSER_VIEW_TAB_ID,
    kind: BROWSER_VIEW_TAB_KIND,
    // A visited body stays mounted while another chip is in front, so the
    // screencast socket survives a tab switch instead of redialing the host.
    keepMounted: true,
    // A type from outside the product: the honest band, and the default one.
    priority: 'extension',
    title: () => t('tab.title'),
    guide: [{
      id: BROWSER_VIEW_GUIDE_ENTRY_ID,
      order: BROWSER_VIEW_GUIDE_ENTRY_ORDER,
      // Thunked, like the type's own title: a language switch needs no
      // re-registration, and the guide reads the copy again on every use.
      title: () => t('tab.title'),
      description: () => t('guide.description'),
      icon: BrowserViewGuideGlyph,
    }],
  }
}
