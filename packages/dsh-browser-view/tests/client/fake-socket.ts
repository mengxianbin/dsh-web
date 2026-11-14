/**
 * Fake transport for the panel tests.
 *
 * The panel accepts a socket factory, so the tests never open a network socket:
 * they capture the handlers, push protocol events into them, and read back the
 * commands the panel sent.
 */
import type { BrowserActionTrace, BrowserPanelState, BrowserViewCommand } from '../../src/core/protocol.ts'
import type {
  BrowserViewFrame,
  BrowserViewSocket,
  BrowserViewSocketHandlers,
  BrowserViewSocketStatus,
} from '../../src/client/socket.ts'

/** One captured connection. */
export interface FakeSocket {
  /** Handlers the panel installed. */
  readonly handlers: BrowserViewSocketHandlers
  /** Commands the panel sent, in order. */
  readonly sent: BrowserViewCommand[]
  /** Whether the panel closed this connection. */
  readonly closed: () => boolean
  send(command: BrowserViewCommand): void
  close(): void
  pushState(state: BrowserPanelState): void
  pushFrame(frame: BrowserViewFrame): void
  pushAction(trace: BrowserActionTrace): void
  pushError(code: string, message: string): void
  pushStatus(status: BrowserViewSocketStatus): void
}

/** Fixture returned by {@link createFakeSockets}. */
export interface FakeSocketFixture {
  /** Factory handed to the panel. */
  readonly factory: (handlers: BrowserViewSocketHandlers) => BrowserViewSocket
  /** Every connection the panel opened, in order. */
  readonly sockets: FakeSocket[]
  /** Most recent connection (fails loudly when the panel opened none). */
  latest(): FakeSocket
}

/**
 * Build one hermetic socket fixture.
 * @returns the factory plus its captured connections.
 */
export function createFakeSockets(): FakeSocketFixture {
  const sockets: FakeSocket[] = []
  const factory = (handlers: BrowserViewSocketHandlers): BrowserViewSocket => {
    let open = true
    const socket: FakeSocket = {
      handlers,
      sent: [],
      closed: () => !open,
      send(command: BrowserViewCommand): void {
        socket.sent.push(command)
      },
      close(): void {
        open = false
      },
      pushState(state: BrowserPanelState): void {
        handlers.onState(state)
      },
      pushFrame(frame: BrowserViewFrame): void {
        handlers.onFrame(frame)
      },
      pushAction(trace: BrowserActionTrace): void {
        handlers.onAction(trace)
      },
      pushError(code: string, message: string): void {
        handlers.onError(code, message)
      },
      pushStatus(status: BrowserViewSocketStatus): void {
        handlers.onStatus?.(status)
      },
    }
    sockets.push(socket)
    return {
      send: socket.send,
      close: socket.close,
      status: () => (open ? 'open' : 'closed'),
    }
  }
  return {
    factory,
    sockets,
    latest(): FakeSocket {
      const socket = sockets[sockets.length - 1]
      if (socket === undefined) throw new Error('the panel opened no socket')
      return socket
    },
  }
}
