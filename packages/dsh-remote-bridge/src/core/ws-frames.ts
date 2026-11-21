/**
 * RFC 6455 server-side framing, kept as pure functions so the length, mask and
 * opcode rules are unit-tested without a socket.
 *
 * Only what a server must accept is implemented: client frames are always
 * masked, one logical message may arrive as a text frame or as a fragmented
 * sequence, and anything the protocol forbids answers with the close code that
 * names the violation instead of being ignored.
 * @module dsh-remote-bridge/core/ws-frames
 */

import { createHash } from 'node:crypto'

/** The magic GUID every WebSocket handshake is keyed with. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OPCODE_CONTINUATION = 0x0
export const OPCODE_TEXT = 0x1
export const OPCODE_BINARY = 0x2
export const OPCODE_CLOSE = 0x8
export const OPCODE_PING = 0x9
export const OPCODE_PONG = 0xa

/** Close code for a protocol violation. */
export const CLOSE_PROTOCOL_ERROR = 1002
/** Close code for a message this bridge will not carry. */
export const CLOSE_UNSUPPORTED_DATA = 1003
/** Close code for a message past the size this bridge will carry. */
export const CLOSE_TOO_LARGE = 1009
/**
 * Close code for a peer that stopped answering: a liveness ping went out and no
 * frame at all came back before its deadline.
 *
 * It is an application-range code (4000-4999), so a client can tell a peer that
 * went silent from a protocol fault, from a frame this bridge will not carry,
 * and from the ordinary 1001 teardown of a bridge that is unloading.
 */
export const CLOSE_LIVENESS_TIMEOUT = 4000

/** @returns the `Sec-WebSocket-Accept` value for a client's key. */
export function webSocketAccept(secWebSocketKey: string): string {
  return createHash('sha1').update(`${secWebSocketKey}${WS_GUID}`).digest('base64')
}

/** One decoded frame header plus its payload. */
export interface DecodedFrame {
  readonly fin: boolean
  readonly opcode: number
  readonly payload: Buffer
  /** Bytes this frame occupies in the stream. */
  readonly consumed: number
}

export type FrameParseOutcome =
  | { readonly status: 'incomplete' }
  | { readonly status: 'frame'; readonly frame: DecodedFrame }
  | { readonly status: 'fault'; readonly closeCode: number; readonly reason: string }

/**
 * Decode one frame from the head of a buffer.
 * @param buffer - the bytes received so far.
 * @param maxBytes - largest payload this bridge accepts.
 */
export function parseClientFrame(buffer: Buffer, maxBytes: number): FrameParseOutcome {
  if (buffer.length < 2) return { status: 'incomplete' }
  const first = buffer[0] ?? 0
  const second = buffer[1] ?? 0
  const fin = (first & 0x80) !== 0
  // RSV1-3 are only meaningful with an extension this bridge never negotiates.
  if ((first & 0x70) !== 0) return fault(CLOSE_PROTOCOL_ERROR, 'reserved bits set')
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  if (!masked) return fault(CLOSE_PROTOCOL_ERROR, 'client frames must be masked')
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < offset + 2) return { status: 'incomplete' }
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return { status: 'incomplete' }
    const wide = buffer.readBigUInt64BE(offset)
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return fault(CLOSE_TOO_LARGE, 'frame length out of range')
    length = Number(wide)
    offset += 8
  }
  if (length > maxBytes) return fault(CLOSE_TOO_LARGE, `frame payload exceeds ${maxBytes} bytes`)
  if (buffer.length < offset + 4 + length) return { status: 'incomplete' }
  const mask = buffer.subarray(offset, offset + 4)
  offset += 4
  const payload = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) payload[index] = (buffer[offset + index] ?? 0) ^ (mask[index % 4] ?? 0)
  return { status: 'frame', frame: { fin, opcode, payload, consumed: offset + length } }
}

function fault(closeCode: number, reason: string): FrameParseOutcome {
  return { status: 'fault', closeCode, reason }
}

/**
 * Encode one server frame. Server frames are never masked.
 * @param opcode - the frame opcode.
 * @param payload - already-serialized payload bytes.
 * @param fin - whether this frame completes the message.
 */
export function encodeServerFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length
  const header = length < 126
    ? Buffer.from([(fin ? 0x80 : 0) | opcode, length])
    : length <= 0xffff
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, 126, length >> 8, length & 0xff])
      : (() => {
        const wide = Buffer.alloc(10)
        wide[0] = (fin ? 0x80 : 0) | opcode
        wide[1] = 127
        wide.writeBigUInt64BE(BigInt(length), 2)
        return wide
      })()
  return Buffer.concat([header, payload])
}

/** Encode one text message. */
export function encodeTextFrame(text: string): Buffer {
  return encodeServerFrame(OPCODE_TEXT, Buffer.from(text, 'utf8'))
}

/** Encode one binary message: already-encoded payload bytes, never a text frame. */
export function encodeBinaryFrame(payload: Buffer): Buffer {
  return encodeServerFrame(OPCODE_BINARY, payload)
}

/** Encode one close frame with a code and a short reason. */
export function encodeCloseFrame(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return encodeServerFrame(OPCODE_CLOSE, payload)
}
