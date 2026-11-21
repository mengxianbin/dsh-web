// @vitest-environment jsdom
/**
 * Wire client: URL derivation, backoff, event narrowing, stale-frame dropping
 * and reconnection. A fake transport constructor stands in for the network, so
 * no socket is ever opened.
 */
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_VIEW_SOCKET_PATH } from '../../src/core/protocol.ts'
import type { BrowserViewSocketHandlers, BrowserViewWebSocketLike } from '../../src/client/socket.ts'
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  browserViewSocketUrl,
  connectBrowserViewSocket,
  parseBrowserViewEvent,
  reconnectDelay,
} from '../../src/client/socket.ts'

/** Transport double recording everything the client does to it. */
class FakeTransport implements BrowserViewWebSocketLike {
  /** Every instance created, in order (the class is a constructor seam). */
  static readonly instances: FakeTransport[] = []

  /** URL the client asked for. */
  readonly url: string
  /** Raw payloads the client sent. */
  readonly sent: string[] = []
  /** Whether the client closed this transport. */
  closed = false

  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeTransport.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  /** Simulate a completed handshake. */
  fireOpen(): void {
    this.onopen?.({})
  }

  /** Simulate an inbound frame. */
  fireMessage(value: unknown): void {
    this.onmessage?.({ data: value })
  }

  /** Simulate the host going away. */
  fireClose(): void {
    this.onclose?.({})
  }

  /** Decoded commands, in send order. */
  commands(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw) as unknown)
  }
}

/** Collected handler calls. */
interface Recorded {
  readonly handlers: BrowserViewSocketHandlers
  readonly frames: Array<{ tabId: string; seq: number }>
  readonly actions: Array<{ tool: string; summary: string }>
  readonly errors: Array<{ code: string; message: string }>
  readonly states: unknown[]
  readonly statuses: string[]
}

/** Build a handler set that records every callback. */
function record(): Recorded {
  const frames: Array<{ tabId: string; seq: number }> = []
  const actions: Array<{ tool: string; summary: string }> = []
  const errors: Array<{ code: string; message: string }> = []
  const states: unknown[] = []
  const statuses: string[] = []
  const handlers: BrowserViewSocketHandlers = {
    onStatus: (status) => { statuses.push(status) },
    onState: (state) => { states.push(state) },
    onFrame: (frame) => { frames.push({ tabId: frame.tabId, seq: frame.seq }) },
    onAction: (trace) => { actions.push({ tool: trace.tool, summary: trace.summary }) },
    onError: (code, message) => { errors.push({ code, message }) },
  }
  return { handlers, frames, actions, errors, states, statuses }
}

/** Timer seam that runs callbacks only when the test advances them. */
function manualTimers(): {
  readonly setTimer: (handler: () => void, ms: number) => unknown
  readonly clearTimer: (handle: unknown) => void
  readonly pending: () => ReadonlyArray<{ handler: () => void; ms: number }>
  readonly runNext: () => void
} {
  const queue: Array<{ handler: () => void; ms: number }> = []
  return {
    setTimer: (handler, ms) => {
      const handle = { handler, ms }
      queue.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      const index = queue.indexOf(handle as { handler: () => void; ms: number })
      if (index >= 0) queue.splice(index, 1)
    },
    pending: () => queue,
    runNext: () => {
      const next = queue.shift()
      next?.handler()
    },
  }
}

/** Reset the constructor double between cases. */
function resetTransports(): void {
  FakeTransport.instances.length = 0
}

const origin = { protocol: 'http:', host: '127.0.0.1:3080' }

describe('browser view socket url', () => {
  it('user loads the GUI over http and the client derives a same-origin ws url', () => {
    // Given an http page served from 127.0.0.1:3080
    // When the client derives the socket url
    // Then it is ws:// on that exact host plus the contract socket path
    expect(browserViewSocketUrl(origin)).toBe('ws://127.0.0.1:3080' + BROWSER_VIEW_SOCKET_PATH)
  })

  it('user loads the GUI over https and the client upgrades the socket url to wss', () => {
    // Given an https page on another host
    // When the client derives the socket url
    // Then the scheme upgrades to wss and the contract socket path is kept
    expect(browserViewSocketUrl({ protocol: 'https:', host: 'gui.example.test' }))
      .toBe('wss://gui.example.test' + BROWSER_VIEW_SOCKET_PATH)
  })

  it('user opens the desktop GUI and the client dials the shell-owned host', () => {
    // Given the official dsh-app page and the network Host its shell published
    // When the client derives the socket url
    // Then it uses that Host, preserving TLS, rather than refusing the app page
    const desktop = { protocol: 'dsh-app:', host: 'app' }
    expect(browserViewSocketUrl(desktop, 'http://127.0.0.1:3080'))
      .toBe('ws://127.0.0.1:3080' + BROWSER_VIEW_SOCKET_PATH)
    expect(browserViewSocketUrl(desktop, 'https://127.0.0.1:3080'))
      .toBe('wss://127.0.0.1:3080' + BROWSER_VIEW_SOCKET_PATH)
  })

  it('user stays on the page origin unless an application shell publishes a safe host', () => {
    // Given a web page with a transport hook and an app page with unsafe bases
    // When the client derives their socket urls
    // Then the web page never gets rerouted, and unsafe bases are refused
    expect(browserViewSocketUrl(origin, 'http://192.168.1.20:3080'))
      .toBe('ws://127.0.0.1:3080' + BROWSER_VIEW_SOCKET_PATH)
    for (const base of ['', 'not a url', 'dsh-app://app', 'ftp://127.0.0.1:3080', 'http://', 'http://user:pw@127.0.0.1:3080']) {
      expect(browserViewSocketUrl({ protocol: 'dsh-app:', host: 'app' }, base), base).toBeNull()
    }
  })

  it('user opens a page whose scheme cannot carry a socket and no url is derived', () => {
    // Given pages on a custom app scheme and on file
    // When the client derives the socket url for each
    // Then both derive nothing, so the client never dials
    expect(browserViewSocketUrl({ protocol: 'dsh-app:', host: '-' })).toBeNull()
    expect(browserViewSocketUrl({ protocol: 'file:', host: '' })).toBeNull()
  })
})

describe('browser view reconnect backoff', () => {
  it('user keeps losing the host and the reconnect delay doubles until it stops at the ceiling', () => {
    // Given the base and ceiling delays from the socket contract
    // When the delay is computed for attempts 0, 1, 3 and 20
    // Then it doubles per attempt and the twentieth attempt is capped at the ceiling
    expect(reconnectDelay(0)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelay(1)).toBe(RECONNECT_BASE_MS * 2)
    expect(reconnectDelay(3)).toBe(RECONNECT_BASE_MS * 8)
    expect(reconnectDelay(20)).toBe(RECONNECT_MAX_MS)
  })
})

describe('browser view event narrowing', () => {
  it('user receives a well-formed state push and the client narrows it as a state event', () => {
    // Given a serialized state push at the current protocol version
    // When the client parses the inbound frame
    // Then the narrowed event kind is state
    const event = parseBrowserViewEvent(JSON.stringify({
      v: 1,
      kind: 'state',
      state: {
        tabs: [{ id: 'tab-1', url: 'https://example.test', title: 'Example', loading: false }],
        activeTabId: 'tab-1',
        running: true,
      },
    }))
    expect(event?.kind).toBe('state')
  })

  it('user receives a stale version, an unknown kind or malformed fields and the client narrows them to null', () => {
    // Given frames carrying version 2, an unknown kind, a non-array tab list, a frame with no pixels, non-JSON text and a null payload
    // When each frame is parsed
    // Then every one narrows to null instead of reaching a handler
    expect(parseBrowserViewEvent(JSON.stringify({ v: 2, kind: 'state', state: {} }))).toBeNull()
    expect(parseBrowserViewEvent(JSON.stringify({ v: 1, kind: 'mystery' }))).toBeNull()
    expect(parseBrowserViewEvent(JSON.stringify({ v: 1, kind: 'state', state: { tabs: 'nope' } }))).toBeNull()
    expect(parseBrowserViewEvent(JSON.stringify({ v: 1, kind: 'frame', tabId: 'tab-1' }))).toBeNull()
    expect(parseBrowserViewEvent('not json')).toBeNull()
    expect(parseBrowserViewEvent(null)).toBeNull()
  })

  it('user receives an action trace and an error and both narrow to their exact wire shape', () => {
    // Given an action trace and an error frame at the current version
    // When the client parses each frame
    // Then both equal their full wire object field for field
    const action = parseBrowserViewEvent({
      v: 1,
      kind: 'action',
      trace: { tool: 'click', summary: 'Clicked', at: 12 },
    })
    expect(action).toEqual({ v: 1, kind: 'action', trace: { tool: 'click', summary: 'Clicked', at: 12 } })

    const error = parseBrowserViewEvent({ v: 1, kind: 'error', code: 'boom', message: 'nope' })
    expect(error).toEqual({ v: 1, kind: 'error', code: 'boom', message: 'nope' })
  })
})

describe('browser view socket lifecycle', () => {
  it('user opens the panel and the client attaches its session once the transport opens', () => {
    // Given a socket client connecting with session-1
    // When the transport fires open
    // Then the status becomes open and one attach command carrying session-1 is sent
    resetTransports()
    const seen = record()
    const socket = connectBrowserViewSocket(seen.handlers, {
      WebSocketImpl: FakeTransport,
      location: origin,
      sessionId: 'session-1',
    })

    const transport = FakeTransport.instances[0]
    expect(transport.url).toBe('ws://127.0.0.1:3080' + BROWSER_VIEW_SOCKET_PATH)
    expect(socket.status()).toBe('connecting')

    transport.fireOpen()
    expect(socket.status()).toBe('open')
    expect(transport.commands()).toEqual([{ v: 1, kind: 'attach', sessionId: 'session-1' }])
    expect(seen.statuses).toContain('open')
  })

  it('user opens the desktop panel and the client connects through the published host', () => {
    // Given a dsh-app page whose official transport hook names the loopback Host
    // When the panel connects and the transport opens
    // Then a real transport is constructed against that Host and reaches open
    resetTransports()
    const seen = record()
    vi.stubGlobal('__DSH_TRANSPORT__', { streamBaseUrl: 'http://127.0.0.1:3080' })
    const socket = connectBrowserViewSocket(seen.handlers, {
      WebSocketImpl: FakeTransport,
      location: { protocol: 'dsh-app:', host: 'app' },
    })
    try {
      expect(FakeTransport.instances).toHaveLength(1)
      const transport = FakeTransport.instances[0]
      expect(transport.url).toBe('ws://127.0.0.1:3080' + BROWSER_VIEW_SOCKET_PATH)
      transport.fireOpen()
      expect(socket.status()).toBe('open')
    } finally {
      socket.close()
      vi.unstubAllGlobals()
    }
  })

  it('user receives frames out of order and the client drops everything older than the painted one', () => {
    // Given an open socket that already painted tab-1 frame 5
    // When tab-1 frames 4 and 6 and tab-2 frame 6 arrive
    // Then only frame 5, frame 6 and the tab-2 frame reach the panel
    resetTransports()
    const seen = record()
    connectBrowserViewSocket(seen.handlers, { WebSocketImpl: FakeTransport, location: origin })
    const transport = FakeTransport.instances[0]
    transport.fireOpen()

    const frame = (seq: number) => ({
      v: 1,
      kind: 'frame',
      tabId: 'tab-1',
      seq,
      width: 640,
      height: 400,
      data: 'AAAA',
    })
    transport.fireMessage(frame(5))
    transport.fireMessage(frame(4))
    transport.fireMessage(frame(6))
    transport.fireMessage({ ...frame(6), tabId: 'tab-2' })

    expect(seen.frames).toEqual([
      { tabId: 'tab-1', seq: 5 },
      { tabId: 'tab-1', seq: 6 },
      { tabId: 'tab-2', seq: 6 },
    ])
  })

  it('user receives an action and an error and the panel handlers see both', () => {
    // Given an open socket with recording handlers
    // When an action trace and an error frame arrive
    // Then each handler receives exactly its payload
    resetTransports()
    const seen = record()
    connectBrowserViewSocket(seen.handlers, { WebSocketImpl: FakeTransport, location: origin })
    const transport = FakeTransport.instances[0]
    transport.fireOpen()

    transport.fireMessage({ v: 1, kind: 'action', trace: { tool: 'navigate', summary: 'Opened /cart', at: 7 } })
    transport.fireMessage({ v: 1, kind: 'error', code: 'timeout', message: 'No frame in 3s' })

    expect(seen.actions).toEqual([{ tool: 'navigate', summary: 'Opened /cart' }])
    expect(seen.errors).toEqual([{ code: 'timeout', message: 'No frame in 3s' }])
  })

  it('user keeps the panel open while the host closes and the client reconnects with the backoff delay', () => {
    // Given an open socket wired to a manual timer seam
    // When the host closes the transport and the pending timer fires
    // Then one reconnect is scheduled at the base delay, a second transport attaches, and a successful open resets the escalation
    resetTransports()
    const seen = record()
    const timers = manualTimers()
    connectBrowserViewSocket(seen.handlers, {
      WebSocketImpl: FakeTransport,
      location: origin,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    const first = FakeTransport.instances[0]
    first.fireOpen()
    first.fireClose()

    expect(timers.pending()).toHaveLength(1)
    expect(timers.pending()[0].ms).toBe(RECONNECT_BASE_MS)
    expect(seen.statuses).toContain('reconnecting')

    timers.runNext()
    expect(FakeTransport.instances).toHaveLength(2)
    const second = FakeTransport.instances[1]
    second.fireOpen()
    expect(second.commands()).toEqual([{ v: 1, kind: 'attach' }])

    // A successful open resets the attempt counter, so the next failure waits
    // the base delay again instead of inheriting the previous escalation.
    second.fireClose()
    expect(timers.pending()[0].ms).toBe(RECONNECT_BASE_MS)
  })

  it('user closes the panel and the client stops reconnecting and closes the transport', () => {
    // Given an open socket with a reconnect timer available
    // When the panel closes the socket and the transport then reports a close
    // Then the transport is closed, the status is closed and no reconnect stays scheduled
    resetTransports()
    const seen = record()
    const timers = manualTimers()
    const socket = connectBrowserViewSocket(seen.handlers, {
      WebSocketImpl: FakeTransport,
      location: origin,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const transport = FakeTransport.instances[0]
    transport.fireOpen()

    socket.close()
    expect(transport.closed).toBe(true)
    expect(socket.status()).toBe('closed')

    transport.fireClose()
    expect(timers.pending()).toHaveLength(0)
  })

  it('user acts before the handshake completes and the client buffers the command', () => {
    // Given a socket client that has not finished connecting
    // When a request-frame command is sent and the transport then opens
    // Then the buffered command is flushed ahead of the attach
    resetTransports()
    const seen = record()
    const socket = connectBrowserViewSocket(seen.handlers, { WebSocketImpl: FakeTransport, location: origin })
    socket.send({ v: 1, kind: 'request-frame' })

    const transport = FakeTransport.instances[0]
    transport.fireOpen()

    expect(transport.commands()).toEqual([
      { v: 1, kind: 'request-frame' },
      { v: 1, kind: 'attach' },
    ])
  })

  it('user opens a page that cannot host the socket and the client reports closed instead of retrying', () => {
    // Given a page on a scheme that cannot carry a socket
    // When the client is asked to connect
    // Then no transport is constructed and the reported status is closed
    resetTransports()
    const seen = record()
    const socket = connectBrowserViewSocket(seen.handlers, {
      WebSocketImpl: FakeTransport,
      location: { protocol: 'dsh-app:', host: '' },
    })

    expect(FakeTransport.instances).toHaveLength(0)
    expect(socket.status()).toBe('closed')
    expect(seen.statuses).toContain('closed')
    vi.restoreAllMocks()
  })
})
