/**
 * Semantic attributes for the browser-view surface (semantic-attrs-v1).
 *
 * The plugin name lives on the root element of each surface so part values stay
 * bare words; a theme anchors on the pair, never on a part name that repeats
 * the plugin. The right-sidebar chip and the shell's tab strip around it are
 * not ours, so only this plugin's own elements are stamped.
 *
 * The body's part names follow the shipped browser tab's structure - a toolbar
 * with an address display, the frame, and the action trace - so a theme that
 * already anchors on that chrome reaches this tab the same way.
 */

/** Root plugin attribute value carried by every top-level browser-view element. */
export const BROWSER_VIEW_PLUGIN = 'browser-view'

/** Part names this plugin emits, in surface order. */
export const BROWSER_VIEW_PARTS = {
  /** The tab body the sidebar mounts in its content area. */
  panel: 'panel',
  /** Top chrome row: address display, connection state, refresh. */
  toolbar: 'toolbar',
  /** The read-only address display of the streamed page. */
  address: 'address',
  /** The controlled browser's tab chips; drawn only when it holds several. */
  tabs: 'tabs',
  /** The live frame image. */
  frame: 'frame',
  /** Bottom action trace. */
  trace: 'trace',
  /** Connection state marker in the toolbar. */
  status: 'status',
  /** No-frame placeholder. */
  empty: 'empty',
  /** Host-reported failure placeholder. */
  error: 'error',
  /** This plugin's share of the right-sidebar chip. */
  tabTitle: 'tab-title',
} as const
