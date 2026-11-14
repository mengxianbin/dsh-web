/**
 * The browser-view wire contract, shared by both halves.
 *
 * One source of truth for the host <-> browser messages and for the shapes the
 * agent tools return. Both halves compile this file (src/core is compiled into
 * the host program and the browser bundle), so a change here is a change to
 * both sides at once and needs no second definition.
 *
 * Transport: one WebSocket per mounted panel, created by the host half through
 * `ctx.webServer.registerUpgrade`. The host pushes events; the panel sends
 * commands. The browser itself is driven over CDP by the host half, so the
 * panel never speaks the devtools protocol.
 *
 * @module @linxin666/dsh-client-ui-browser-view/core/protocol
 */

/** Version of the wire contract; a mismatch rejects the socket instead of guessing. */
export const BROWSER_VIEW_API_VERSION = 1

/** Mount path of the panel socket, relative to the GUI origin. */
export const BROWSER_VIEW_SOCKET_PATH = '/api/dsh-browser-view/socket'

/** JPEG quality the host asks CDP for; the panel only displays frames. */
export const DEFAULT_JPEG_QUALITY = 70

/** Viewport the host pins on every tab it creates, in CSS pixels. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const

/** How long a tab may live without any session binding before it is reaped. */
export const IDLE_TAB_TTL_MS = 10 * 60_000

/** Deepest DOM snapshot walk the host will perform, in nodes. */
export const SNAPSHOT_NODE_LIMIT = 4000

/** Ring size for captured console and network entries per tab. */
export const EVENT_RING_SIZE = 500

/** One open tab as the panel and the tools see it. */
export interface BrowserTabView {
  /** Stable CDP target id, the handle tools accept. */
  id: string
  /** Current top-level URL. */
  url: string
  /** Current document title, empty when the page has none. */
  title: string
  /** Whether the tab is loading right now. */
  loading: boolean
  /** Session that last acted on the tab, when any. */
  sessionId?: string
}

/** What the header of the panel shows. */
export interface BrowserPanelState {
  /** Tabs in creation order. */
  tabs: BrowserTabView[]
  /** Tab the panel is watching, null when none is open. */
  activeTabId: string | null
  /** Whether the host half currently owns a live browser process. */
  running: boolean
  /** Last error text the host wants the panel to show instead of a frame. */
  message?: string
}

/** One line of the panel's "what is the agent doing" trace. */
export interface BrowserActionTrace {
  /** Tool name that produced the change, without its `browser_` prefix. */
  tool: string
  /** One-line human description, already localized by the host. */
  summary: string
  /** Millisecond timestamp of the action. */
  at: number
}

/** Host pushes one of these to every attached panel. */
export type BrowserViewEvent =
  | { v: 1; kind: 'hello'; state: BrowserPanelState }
  | { v: 1; kind: 'state'; state: BrowserPanelState }
  | {
      v: 1
      kind: 'frame'
      /** Tab the frame belongs to. */
      tabId: string
      /** Monotonic frame counter, so a slow panel can drop intermediate frames. */
      seq: number
      /** Frame size in CSS pixels. */
      width: number
      /** Frame size in CSS pixels. */
      height: number
      /** Base64 JPEG, no data: prefix. */
      data: string
    }
  | { v: 1; kind: 'action'; trace: BrowserActionTrace }
  | { v: 1; kind: 'error'; code: string; message: string }

/** Panel sends one of these to the host. */
export type BrowserViewCommand =
  | { v: 1; kind: 'attach'; sessionId?: string }
  | { v: 1; kind: 'select-tab'; tabId: string }
  | { v: 1; kind: 'request-frame' }
  | { v: 1; kind: 'close-tab'; tabId: string }

/** A console entry the host rang in while the tab was open. */
export interface BrowserConsoleEntry {
  /** Console level: log, info, warn, error, debug. */
  level: string
  /** Already-stringified arguments. */
  text: string
  /** Millisecond timestamp. */
  at: number
}

/** A network request the host observed, reduced to what verification needs. */
export interface BrowserNetworkEntry {
  /** Request URL. */
  url: string
  /** HTTP method. */
  method: string
  /** Response status, 0 while pending or on a transport failure. */
  status: number
  /** Response mime type when known. */
  mimeType?: string
  /** CDP failure text when the request failed. */
  failure?: string
  /** Millisecond timestamp of the request. */
  at: number
}

/** One node of the DOM snapshot the tools return. */
export interface BrowserSnapshotNode {
  /** Depth-first index, the handle `browser_click` accepts as `ref`. */
  ref: number
  /** Lowercase tag name. */
  tag: string
  /** Element id, when set. */
  id?: string
  /** Element classes, when set. */
  classes?: string[]
  /** Accessible role when Chrome reports one. */
  role?: string
  /** Accessible name when Chrome reports one. */
  name?: string
  /** Visible text for leaf nodes, truncated by the host. */
  text?: string
  /** Bounding box in CSS pixels, window-relative. */
  box?: { x: number; y: number; width: number; height: number }
  /** Depth in the walked tree. */
  depth: number
}

/** What `browser_snapshot` returns to the model. */
export interface BrowserSnapshot {
  /** Tab the snapshot came from. */
  tabId: string
  /** Top-level URL at snapshot time. */
  url: string
  /** Document title. */
  title: string
  /** Walked nodes, bounded by SNAPSHOT_NODE_LIMIT. */
  nodes: BrowserSnapshotNode[]
  /** True when the walk hit the node limit. */
  truncated: boolean
}

/** Whether a decoded JSON value is a command this version accepts. */
export function isBrowserViewCommand(value: unknown): value is BrowserViewCommand {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate.v !== BROWSER_VIEW_API_VERSION) return false
  switch (candidate.kind) {
    case 'attach':
      return candidate.sessionId === undefined || typeof candidate.sessionId === 'string'
    case 'select-tab':
      return typeof candidate.tabId === 'string'
    case 'close-tab':
      return typeof candidate.tabId === 'string'
    case 'request-frame':
      return true
    default:
      return false
  }
}
