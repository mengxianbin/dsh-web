/**
 * Panel-side WebSocket client.
 *
 * The host half owns the CDP connection and pushes state, JPEG frames, tool
 * actions and errors over one socket per mounted panel (see ../core/protocol.ts
 * for the frozen wire contract). This module is the only place the browser half
 * touches the wire: it derives the page or shell-owned socket URL, narrows every
 * incoming message through the protocol's discriminant, drops stale frames,
 * and reconnects with exponential backoff.
 *
 * Nothing here imports the DOM's WebSocket type directly: the constructor is
 * injectable so the tests drive a fake transport instead of a network.
 *
 * @module @linxin666/dsh-client-ui-browser-view/client/socket
 */
import {
  BROWSER_VIEW_API_VERSION,
  BROWSER_VIEW_SOCKET_PATH,
} from '../core/protocol.ts'
import type {
  BrowserActionTrace,
  BrowserPanelState,
  BrowserTabView,
  BrowserViewCommand,
  BrowserViewEvent,
} from '../core/protocol.ts'

/** Connection phase the panel renders in its status line. */
export type BrowserViewSocketStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

/** First reconnect delay, doubled per failed attempt. */
export const RECONNECT_BASE_MS = 500

/** Reconnect ceiling; a host that stays down must not spin the tab. */
export const RECONNECT_MAX_MS = 15_000

/** One decoded frame, exactly as the panel needs it. */
export interface BrowserViewFrame {
  /** Tab the frame belongs to. */
  readonly tabId: string
  /** Host-side monotonic counter for this tab. */
  readonly seq: number
  /** Frame width in CSS pixels. */
  readonly width: number
  /** Frame height in CSS pixels. */
  readonly height: number
  /** Base64 JPEG, no data: prefix. */
  readonly data: string
}

/** Callbacks the panel installs on a connection. */
export interface BrowserViewSocketHandlers {
  /** Connection phase changed. */
  onStatus?(status: BrowserViewSocketStatus): void
  /** Tabs, active tab and running flag were (re)published. */
  onState(state: BrowserPanelState): void
  /** A fresh frame arrived, already filtered for staleness. */
  onFrame(frame: BrowserViewFrame): void
  /** The agent performed one tool action. */
  onAction(trace: BrowserActionTrace): void
  /** The host reported a failure the panel must show instead of a frame. */
  onError(code: string, message: string): void
}

/** The minimal socket face this client needs; the DOM WebSocket satisfies it. */
export interface BrowserViewWebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** Constructor shape of the transport; injectable for tests. */
export type BrowserViewWebSocketCtor = new (url: string) => BrowserViewWebSocketLike

/** Options for one connection. */
export interface BrowserViewSocketOptions {
  /** Transport constructor; defaults to the page's WebSocket. */
  readonly WebSocketImpl?: BrowserViewWebSocketCtor
  /** Origin source for the URL; defaults to `globalThis.location`. */
  readonly location?: { readonly protocol: string; readonly host: string }
  /** Session the panel attaches to, forwarded in the `attach` command. */
  readonly sessionId?: string
  /** Timer seam so backoff can be advanced deterministically in tests. */
  readonly setTimer?: (handler: () => void, ms: number) => unknown
  /** Timer cancellation seam paired with `setTimer`. */
  readonly clearTimer?: (handle: unknown) => void
}

/** The handle a panel keeps for the lifetime of one mounted connection. */
export interface BrowserViewSocket {
  /** Send one command, buffered while the socket is not open. */
  send(command: BrowserViewCommand): void
  /** Stop reconnecting and close the transport. */
  close(): void
  /** Current connection phase. */
  status(): BrowserViewSocketStatus
}

/** Commands held while the socket is down; the oldest drop first. */
const PENDING_COMMAND_LIMIT = 16

/** The network authority of a shell-owned Host, without credentials or a path. */
function hostAuthorityOf(base: string | undefined): { protocol: string; authority: string } | undefined {
  if (base === undefined || base === '') return undefined
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '' || url.host === '') return undefined
  return { protocol: url.protocol, authority: url.host }
}

/**
 * Derive the socket URL from a web page or its application shell's Host.
 *
 * A web page keeps its own origin even when a transport hook is present. An
 * application-delivered page such as the desktop shell's dsh-app: cannot carry
 * a WebSocket upgrade on that scheme, so it uses the Host authority the shell
 * publishes instead. The shell rewrites that handshake; the Host fence is unchanged.
 * @param location - origin the panel is rendered on.
 * @param streamBaseUrl - official `__DSH_TRANSPORT__.streamBaseUrl`, when published.
 * @returns the absolute ws/wss URL, or null when no safe Host authority is known.
 */
export function browserViewSocketUrl(
  location: { readonly protocol: string; readonly host: string },
  streamBaseUrl?: string,
): string | null {
  const pageProtocol = location.protocol === 'https:'
    ? 'wss:'
    : location.protocol === 'http:'
      ? 'ws:'
      : null
  if (pageProtocol !== null) return `${pageProtocol}//${location.host}${BROWSER_VIEW_SOCKET_PATH}`
  const base = hostAuthorityOf(streamBaseUrl)
  if (base === undefined) return null
  const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${base.authority}${BROWSER_VIEW_SOCKET_PATH}`
}

/**
 * Backoff for one reconnect attempt.
 * @param attempt - zero-based attempt index.
 * @returns delay in milliseconds, capped at RECONNECT_MAX_MS.
 */
export function reconnectDelay(attempt: number): number {
  const exponential = RECONNECT_BASE_MS * 2 ** Math.max(0, Math.floor(attempt))
  return Math.min(exponential, RECONNECT_MAX_MS)
}

/** Narrow a tab row from the wire. */
function readTab(value: unknown): BrowserTabView | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string') return null
  if (typeof candidate.url !== 'string') return null
  if (typeof candidate.title !== 'string') return null
  if (typeof candidate.loading !== 'boolean') return null
  return {
    id: candidate.id,
    url: candidate.url,
    title: candidate.title,
    loading: candidate.loading,
    ...(typeof candidate.sessionId === 'string' ? { sessionId: candidate.sessionId } : {}),
  }
}

/** Narrow the panel state from the wire. */
function readPanelState(value: unknown): BrowserPanelState | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.tabs)) return null
  if (typeof candidate.running !== 'boolean') return null
  if (candidate.activeTabId !== null && typeof candidate.activeTabId !== 'string') return null
  const tabs: BrowserTabView[] = []
  for (const entry of candidate.tabs) {
    const tab = readTab(entry)
    if (tab === null) return null
    tabs.push(tab)
  }
  return {
    tabs,
    activeTabId: candidate.activeTabId as string | null,
    running: candidate.running,
    ...(typeof candidate.message === 'string' ? { message: candidate.message } : {}),
  }
}

/**
 * Narrow one decoded payload into a protocol event.
 *
 * The protocol is a discriminated union over `kind`, so an unknown kind or a
 * wrong field type is a shape this panel cannot render: it is dropped rather
 * than half-applied, which keeps one malformed push from corrupting the view.
 * @param value - parsed JSON value (or a raw frame string).
 * @returns the event, or null when the payload is not one this version reads.
 */
export function parseBrowserViewEvent(value: unknown): BrowserViewEvent | null {
  let payload = value
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return null
    }
  }
  if (typeof payload !== 'object' || payload === null) return null
  const candidate = payload as Record<string, unknown>
  if (candidate.v !== BROWSER_VIEW_API_VERSION) return null
  switch (candidate.kind) {
    case 'hello':
    case 'state': {
      const state = readPanelState(candidate.state)
      if (state === null) return null
      return { v: BROWSER_VIEW_API_VERSION, kind: candidate.kind, state }
    }
    case 'frame': {
      if (typeof candidate.tabId !== 'string') return null
      if (typeof candidate.seq !== 'number') return null
      if (typeof candidate.width !== 'number') return null
      if (typeof candidate.height !== 'number') return null
      if (typeof candidate.data !== 'string') return null
      return {
        v: BROWSER_VIEW_API_VERSION,
        kind: 'frame',
        tabId: candidate.tabId,
        seq: candidate.seq,
        width: candidate.width,
        height: candidate.height,
        data: candidate.data,
      }
    }
    case 'action': {
      const trace = candidate.trace
      if (typeof trace !== 'object' || trace === null) return null
      const row = trace as Record<string, unknown>
      if (typeof row.tool !== 'string' || typeof row.summary !== 'string' || typeof row.at !== 'number') return null
      return {
        v: BROWSER_VIEW_API_VERSION,
        kind: 'action',
        trace: { tool: row.tool, summary: row.summary, at: row.at },
      }
    }
    case 'error': {
      if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null
      return { v: BROWSER_VIEW_API_VERSION, kind: 'error', code: candidate.code, message: candidate.message }
    }
    default:
      return null
  }
}

/**
 * Open one connection to the host half and keep it alive.
 *
 * Sequencing: every successful open sends `attach` (the host answers with
 * `hello` plus frames), and the per-tab frame counter is cleared because the
 * host restarts its `seq` for a new connection — keeping the old high-water
 * mark would drop the whole fresh stream.
 * @param handlers - panel callbacks.
 * @param options - transport, origin, session and timer seams.
 * @returns the handle the panel closes on unmount.
 */
export function connectBrowserViewSocket(
  handlers: BrowserViewSocketHandlers,
  options: BrowserViewSocketOptions = {},
): BrowserViewSocket {
  const globals = globalThis as {
    WebSocket?: BrowserViewWebSocketCtor
    location?: { protocol: string; host: string }
    __DSH_TRANSPORT__?: { streamBaseUrl?: unknown }
  }
  const WebSocketImpl = options.WebSocketImpl ?? globals.WebSocket
  const location = options.location ?? globals.location
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  const publishedBase = globals.__DSH_TRANSPORT__?.streamBaseUrl
  const streamBaseUrl = typeof publishedBase === 'string' ? publishedBase : undefined
  const url = location === undefined ? null : browserViewSocketUrl(location, streamBaseUrl)

  let status: BrowserViewSocketStatus = 'connecting'
  let socket: BrowserViewWebSocketLike | null = null
  let attempt = 0
  let disposed = false
  let timer: unknown = null
  const pending: BrowserViewCommand[] = []
  const lastSeqByTab = new Map<string, number>()

  /** Publish a phase change once. */
  const setStatus = (next: BrowserViewSocketStatus): void => {
    if (status === next) return
    status = next
    handlers.onStatus?.(next)
  }

  /** Send without buffering (open socket only). */
  const sendNow = (command: BrowserViewCommand): boolean => {
    if (socket === null) return false
    try {
      socket.send(JSON.stringify(command))
      return true
    } catch {
      return false
    }
  }

  /** Dispatch one decoded event, dropping frames older than what is on screen. */
  const dispatch = (event: BrowserViewEvent): void => {
    switch (event.kind) {
      case 'hello':
      case 'state':
        handlers.onState(event.state)
        return
      case 'frame': {
        const previous = lastSeqByTab.get(event.tabId)
        if (previous !== undefined && event.seq <= previous) return
        lastSeqByTab.set(event.tabId, event.seq)
        handlers.onFrame({
          tabId: event.tabId,
          seq: event.seq,
          width: event.width,
          height: event.height,
          data: event.data,
        })
        return
      }
      case 'action':
        handlers.onAction(event.trace)
        return
      case 'error':
        handlers.onError(event.code, event.message)
        return
      default:
        return
    }
  }

  /** Arm the next reconnect; each failure doubles the wait until the ceiling. */
  const scheduleReconnect = (): void => {
    if (disposed) return
    if (url === null || WebSocketImpl === undefined) {
      setStatus('closed')
      return
    }
    setStatus('reconnecting')
    if (timer !== null) clearTimer(timer)
    const delay = reconnectDelay(attempt)
    attempt += 1
    timer = setTimer(() => {
      timer = null
      connect()
    }, delay)
  }

  /** Open one transport and wire it to the handlers. */
  const connect = (): void => {
    if (disposed) return
    if (url === null || WebSocketImpl === undefined) {
      setStatus('closed')
      return
    }
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting')
    let transport: BrowserViewWebSocketLike
    try {
      transport = new WebSocketImpl(url)
    } catch {
      socket = null
      scheduleReconnect()
      return
    }
    socket = transport
    transport.onopen = () => {
      if (disposed) return
      attempt = 0
      lastSeqByTab.clear()
      setStatus('open')
      while (pending.length > 0) {
        const command = pending.shift()
        if (command !== undefined) sendNow(command)
      }
      sendNow({ v: BROWSER_VIEW_API_VERSION, kind: 'attach', ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) })
    }
    transport.onmessage = (event) => {
      if (disposed) return
      const parsed = parseBrowserViewEvent(event.data)
      if (parsed !== null) dispatch(parsed)
    }
    transport.onerror = () => {
      // A close event always follows a failed handshake; reconnection is armed there.
    }
    transport.onclose = () => {
      if (socket === transport) socket = null
      if (disposed) return
      scheduleReconnect()
    }
  }

  connect()

  return {
    send(command: BrowserViewCommand): void {
      if (sendNow(command)) return
      pending.push(command)
      if (pending.length > PENDING_COMMAND_LIMIT) pending.shift()
    },
    close(): void {
      if (disposed) return
      disposed = true
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      const transport = socket
      socket = null
      setStatus('closed')
      if (transport !== null) {
        try {
          transport.close()
        } catch {
          // A transport that already failed may throw on close; nothing left to do.
        }
      }
    },
    status(): BrowserViewSocketStatus {
      return status
    },
  }
}
