/**
 * The WebSocket carrier of `/ios/v1`: RFC 6455 negotiation plus the frame loop.
 *
 * This is the only WebSocket in the family that terminates the protocol
 * itself — the other remote plugin proxies its upgrades to the host mux — so
 * the framing rules are implemented here against `core/ws-frames.ts` and every
 * socket failure funnels into one teardown path that the hub observes exactly
 * once.
 * @module dsh-remote-bridge/host/websocket
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { BridgeTransport, ConnectionAuth } from '../core/connection.ts'
import { MAX_FRAME_BYTES, outboundPayloadOf } from '../core/envelope.ts'
import type { BridgeHub } from '../core/hub.ts'
import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_TOO_LARGE,
  CLOSE_UNSUPPORTED_DATA,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_CONTINUATION,
  OPCODE_PING,
  OPCODE_PONG,
  OPCODE_TEXT,
  encodeBinaryFrame,
  encodeCloseFrame,
  encodeServerFrame,
  encodeTextFrame,
  parseClientFrame,
  webSocketAccept,
} from '../core/ws-frames.ts'

/** Close code a well-behaved peer sends when it goes away. */
const CLOSE_NORMAL = 1000

/**
 * Messages one carrier buffers while no handler is registered. The mounted
 * wiring registers one synchronously, so this only ever absorbs bytes that were
 * handed over before the handler existed; past it the socket is closed instead of
 * buffering a conversation nobody is reading.
 */
export const PENDING_MESSAGE_LIMIT = 32

/** @returns whether this request asks for a WebSocket upgrade. */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = req.headers.upgrade
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket'
}

/** @returns the client's `Sec-WebSocket-Key`, or undefined when the handshake is incomplete. */
export function readSecWebSocketKey(req: IncomingMessage): string | undefined {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string') return undefined
  const trimmed = key.trim()
  return trimmed === '' ? undefined : trimmed
}

/** @returns the device token on `Authorization: Bearer …`, if the client sent one. */
export function bearerTokenOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const value = match?.[1]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * @returns the token on `?token=…`, the fallback for clients whose handshake
 *   cannot set a header (share sheets, `wscat`, plain scripts).
 */
export function queryTokenOf(requestUrl: string | undefined): string | undefined {
  if (requestUrl === undefined || requestUrl === '') return undefined
  let value: string | null
  try {
    value = new URL(requestUrl, 'http://127.0.0.1').searchParams.get('token')
  } catch {
    return undefined
  }
  return value === null || value === '' ? undefined : value
}

/**
 * @returns the token this upgrade presents: the header first, then the query.
 *   A bootstrap token presented here is simply not a device token, which leaves
 *   the connection unpaired — the state `pair.begin` needs.
 */
export function presentedTokenOf(req: IncomingMessage): string | undefined {
  return bearerTokenOf(req) ?? queryTokenOf(req.url)
}

/**
 * Answer an upgrade this endpoint will not take, and close the write side.
 *
 * The refusal rides `end()`, which flushes the response before the FIN. Writing
 * and then destroying in the same tick aborts the in-flight write on Linux, and
 * that abort surfaces as the socket's own `error` event - which nothing on a
 * refused socket listens for, because the carrier's subscriptions only exist
 * once an upgrade is accepted. One malformed upgrade therefore reached the host
 * as an uncaught exception. The listener absorbs the transport's own failures: a
 * peer that vanished mid-refusal is the client's problem, never the host's.
 */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.on('error', () => {})
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
}

/** The Nagle switch a `net.Socket` carries; the bare duplexes of a suite need not have one. */
interface DelayableSocket extends Duplex {
  setNoDelay?: (noDelay: boolean) => void
}

/**
 * Ask the kernel to write each frame out as it is handed over.
 *
 * Every frame on this route is already one whole application message, and a
 * phone pays a round trip for each answer, so Nagle's coalescing window only
 * delays bytes that nothing else is waiting to join. It is set on acceptance
 * because that is the last moment the socket is still ours alone: once the
 * upgrade has been answered, a peer's frame can already be on the way.
 */
function stopNagleDelay(socket: Duplex): void {
  const delayable: DelayableSocket = socket
  if (typeof delayable.setNoDelay === 'function') delayable.setNoDelay(true)
}

/**
 * One accepted upgrade handed to the bridge.
 */
export interface UpgradeHandoff {
  /** The upgraded socket; the carrier both reads from and writes to it. */
  readonly socket: Duplex
  /** The client's `Sec-WebSocket-Key`, already read from the handshake. */
  readonly secWebSocketKey: string
  /** Bytes that arrived with the upgrade request itself. */
  readonly head: Buffer
  readonly hub: BridgeHub
  /** The device the handshake token proved, when it proved one. */
  readonly auth?: ConnectionAuth
}

/**
 * Hand one accepted upgrade to the hub, in the one order that is correct.
 *
 * Every step here is synchronous, which is what makes the carrier's own
 * pre-handler buffer unnecessary in practice — and the buffer is there anyway,
 * so the bytes of `head` (and anything that beats the handler) are delivered
 * instead of dropped. The order is the point of this function: reading the
 * socket without a handler, or attaching a connection whose carrier is never
 * written to, both end in a client that waits forever.
 * @param handoff - the socket, its handshake facts, and the hub to join.
 * @returns the carrier, for a caller that needs to observe it.
 */
export function serveUpgrade(handoff: UpgradeHandoff): WebSocketCarrier {
  const { socket, secWebSocketKey, head, hub, auth } = handoff
  stopNagleDelay(socket)
  const carrier = new WebSocketCarrier(socket)
  carrier.handshake(secWebSocketKey)
  const connection = hub.attach(carrier, auth)
  carrier.onMessage(text => { void connection.handleText(text) })
  carrier.onClose(() => { hub.detach(connection) })
  if (head.length > 0) carrier.feed(head)
  return carrier
}

/**
 * One accepted socket, framed.
 *
 * Frames are buffered until a whole one has arrived; a fragmented message is
 * reassembled up to {@link MAX_FRAME_BYTES} and anything larger closes the
 * socket with the code that names the violation. The carrier is inert until
 * {@link handshake} runs, so a caller can refuse a connection without having
 * written a byte of the protocol.
 */
export class WebSocketCarrier implements BridgeTransport {
  readonly #socket: Duplex
  #buffer: Buffer = Buffer.alloc(0)
  #fragments: Buffer[] = []
  #fragmentOpcode = 0
  #fragmentBytes = 0
  #opened = false
  #closed = false
  #onMessage: ((text: string) => void) | undefined
  #onClose: (() => void) | undefined
  /** Whether the peer declared it can inflate a compressed frame; see {@link frameDeflate}. */
  #deflate = false
  /** Messages that arrived before a handler was registered; see {@link deliver}. */
  readonly #pending: string[] = []

  constructor(socket: Duplex) {
    this.#socket = socket
    // The socket is this endpoint's ONLY source of bytes. Without this
    // subscription every frame a client sends after the handshake sits in the
    // socket's read buffer forever: the upgrade's leftover `head` is normally
    // empty, so the frame loop would never see a single byte — the client sees a
    // socket that stays open, answers nothing and never closes.
    socket.on('data', (chunk: Buffer) => { this.feed(chunk) })
    socket.on('error', () => { this.#shut() })
    socket.on('close', () => { this.#shut() })
    socket.on('end', () => { this.#shut() })
  }

  /** Write the 101 handshake carrying the accept value for the client's key. */
  handshake(secWebSocketKey: string): void {
    if (this.#opened || this.#closed) return
    this.#opened = true
    this.#socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'upgrade: websocket',
      'connection: Upgrade',
      `sec-websocket-accept: ${webSocketAccept(secWebSocketKey)}`,
      '',
      '',
    ].join('\r\n'))
  }

  /** Register the handler for every complete text message. */
  onMessage(handler: (text: string) => void): void {
    this.#onMessage = handler
    for (const text of this.#pending.splice(0)) handler(text)
  }

  /** Register the one teardown hook; it runs exactly once. */
  onClose(handler: () => void): void {
    this.#onClose = handler
  }

  /** Feed raw bytes from the socket into the frame loop. */
  feed(chunk: Buffer): void {
    if (this.#closed) return
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    for (;;) {
      const outcome = parseClientFrame(this.#buffer, MAX_FRAME_BYTES)
      if (outcome.status === 'incomplete') return
      if (outcome.status === 'fault') {
        this.close(outcome.closeCode, outcome.reason)
        return
      }
      this.#buffer = this.#buffer.subarray(outcome.frame.consumed)
      if (!this.#accept(outcome.frame.fin, outcome.frame.opcode, outcome.frame.payload)) return
    }
  }

  /**
   * Record the peer's `frame.deflate.v1` declaration, as `hello` reported it.
   *
   * It defaults to off, so a connection that never declares the capability keeps
   * the text frame this carrier always wrote, byte for byte.
   */
  frameDeflate(declared: boolean): void {
    this.#deflate = declared
  }

  /** Send one frame: the text itself, or raw DEFLATE of it as a binary frame. */
  send(text: string): void {
    if (this.#closed) return
    const payload = outboundPayloadOf(text, this.#deflate)
    this.#socket.write(payload.binary ? encodeBinaryFrame(payload.deflated) : encodeTextFrame(payload.text))
  }

  /** Send a close frame and end the socket. Idempotent. */
  close(code: number, reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.#socket.write(encodeCloseFrame(code, reason))
    this.#socket.end()
    this.#notifyClose()
  }

  /** @returns whether the carrier has been torn down. */
  get closed(): boolean {
    return this.#closed
  }

  #accept(fin: boolean, opcode: number, payload: Buffer): boolean {
    switch (opcode) {
      case OPCODE_TEXT:
      case OPCODE_BINARY: {
        if (this.#fragmentOpcode !== 0) {
          this.close(CLOSE_PROTOCOL_ERROR, 'a new message started before the previous one finished')
          return false
        }
        if (fin) return this.#deliver(opcode, payload)
        this.#fragmentOpcode = opcode
        this.#fragments = [payload]
        this.#fragmentBytes = payload.length
        return true
      }
      case OPCODE_CONTINUATION: {
        if (this.#fragmentOpcode === 0) {
          this.close(CLOSE_PROTOCOL_ERROR, 'continuation frame without a started message')
          return false
        }
        this.#fragmentBytes += payload.length
        if (this.#fragmentBytes > MAX_FRAME_BYTES) {
          this.close(CLOSE_TOO_LARGE, `a message may not exceed ${MAX_FRAME_BYTES} bytes`)
          return false
        }
        this.#fragments.push(payload)
        if (!fin) return true
        const message = Buffer.concat(this.#fragments, this.#fragmentBytes)
        const opcodeOfMessage = this.#fragmentOpcode
        this.#fragments = []
        this.#fragmentBytes = 0
        this.#fragmentOpcode = 0
        return this.#deliver(opcodeOfMessage, message)
      }
      case OPCODE_PING:
        this.#socket.write(encodeServerFrame(OPCODE_PONG, payload))
        return true
      case OPCODE_PONG:
        return true
      case OPCODE_CLOSE:
        this.close(CLOSE_NORMAL, '')
        return false
      default:
        this.close(CLOSE_PROTOCOL_ERROR, `unsupported opcode ${opcode}`)
        return false
    }
  }

  #deliver(opcode: number, payload: Buffer): boolean {
    if (opcode !== OPCODE_TEXT) {
      this.close(CLOSE_UNSUPPORTED_DATA, 'this endpoint carries text frames only')
      return false
    }
    const text = payload.toString('utf8')
    if (this.#onMessage === undefined) {
      // The mounted wiring order (handshake → attach → onMessage → feed(head)) is
      // synchronous, so this queue is never needed for it: `data` can only fire on
      // a later turn. It is here so that guarantee does not rest on a caller's tick
      // discipline — bytes the carrier is handed first are delivered the moment a
      // handler arrives, instead of being dropped. The bound turns a carrier nobody
      // ever wired into a closed socket rather than a growing buffer.
      if (this.#pending.length >= PENDING_MESSAGE_LIMIT) {
        this.close(CLOSE_TOO_LARGE, 'this connection has no message handler')
        return false
      }
      this.#pending.push(text)
      return true
    }
    this.#onMessage(text)
    return true
  }

  /** The socket went away without a close frame: tear down without writing. */
  #shut(): void {
    if (this.#closed) return
    this.#closed = true
    this.#notifyClose()
  }

  #notifyClose(): void {
    const handler = this.#onClose
    this.#onClose = undefined
    handler?.()
  }
}
