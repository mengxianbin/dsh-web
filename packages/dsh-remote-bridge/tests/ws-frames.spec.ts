import { describe, expect, it } from 'vitest'
import {
  CLOSE_TOO_LARGE,
  OPCODE_CONTINUATION,
  OPCODE_TEXT,
  encodeBinaryFrame,
  encodeCloseFrame,
  encodeServerFrame,
  encodeTextFrame,
  parseClientFrame,
  webSocketAccept,
} from '../src/core/ws-frames.ts'

/** One masked client frame, built the way a browser or iOS client sends it. */
function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const masked = Buffer.from(payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0)))
  const header = payload.length < 126
    ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length])
    : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([header, mask, masked])
}

describe('WebSocket framing', () => {
  it('user completes the handshake and the accept value matches the protocol example', () => {
    // Given the key from the WebSocket specification's own example
    const key = 'dGhlIHNhbXBsZSBub25jZQ=='
    // When the accept value is computed
    const accept = webSocketAccept(key)
    // Then it is the value the specification prints
    expect(accept).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('user sends a masked text frame and the payload is unmasked', () => {
    // Given a masked text frame carrying one JSON object
    const frame = maskedFrame(OPCODE_TEXT, Buffer.from('{"t":"ping","ts":1}'))
    // When the parser reads it
    const outcome = parseClientFrame(frame, 1024)
    // Then the whole frame is consumed and the payload is readable
    if (outcome.status !== 'frame') throw new Error(`expected a frame, got ${outcome.status}`)
    expect(outcome.frame.opcode).toBe(OPCODE_TEXT)
    expect(outcome.frame.fin).toBe(true)
    expect(outcome.frame.payload.toString('utf8')).toBe('{"t":"ping","ts":1}')
    expect(outcome.frame.consumed).toBe(frame.length)
  })

  it('user sends an unmasked frame and the bridge closes with a protocol error', () => {
    // Given a frame that violates the client-must-mask rule
    const frame = Buffer.from([0x81, 0x02, 0x68, 0x69])
    // When the parser reads it
    const outcome = parseClientFrame(frame, 1024)
    // Then the refusal names the protocol error rather than guessing the payload
    expect(outcome).toEqual({ status: 'fault', closeCode: 1002, reason: 'client frames must be masked' })
  })

  it('user sends half a frame and the bridge waits for the rest', () => {
    // Given a frame whose masked payload has not fully arrived
    const complete = maskedFrame(OPCODE_TEXT, Buffer.from('hello'))
    // When the parser reads a prefix of it
    const outcome = parseClientFrame(complete.subarray(0, complete.length - 2), 1024)
    // Then it reports that more bytes are needed
    expect(outcome).toEqual({ status: 'incomplete' })
  })

  it('user sends a frame whose declared length exceeds the cap and it is refused', () => {
    // Given a 16-bit length header declaring more than this bridge carries
    const header = Buffer.from([0x81, 0x80 | 126, 0x08, 0x00])
    // When the parser reads it
    const outcome = parseClientFrame(header, 1024)
    // Then the refusal is the size rule
    expect(outcome).toEqual({ status: 'fault', closeCode: CLOSE_TOO_LARGE, reason: 'frame payload exceeds 1024 bytes' })
  })

  it('user sends a fragmented text message and the bridge reassembles it', () => {
    // Given a text frame without its fin bit and a following continuation
    const first = maskedFrame(OPCODE_TEXT, Buffer.from('{"t":'), false)
    const rest = maskedFrame(OPCODE_CONTINUATION, Buffer.from('"ping"}'))
    // When both are read in order
    const opening = parseClientFrame(first, 1024)
    const closing = parseClientFrame(rest, 1024)
    // Then the first is marked unfinished and the second finishes the message
    if (opening.status !== 'frame' || closing.status !== 'frame') throw new Error('both frames should parse')
    expect(opening.frame.fin).toBe(false)
    expect(closing.frame.fin).toBe(true)
    expect(closing.frame.opcode).toBe(OPCODE_CONTINUATION)
    expect(Buffer.concat([opening.frame.payload, closing.frame.payload]).toString('utf8')).toBe('{"t":"ping"}')
  })

  it('operator sends a text frame and its length encoding follows the payload size', () => {
    // Given a short and a long payload
    const short = encodeTextFrame('hi')
    const long = encodeTextFrame('x'.repeat(300))
    // When their headers are read
    const shortHeader = [short[0], short[1]]
    const longHeader = [long[0], long[1], long.readUInt16BE(2)]
    // Then the short one carries its length inline and the long one switches to the 16-bit form
    expect(shortHeader).toEqual([0x81, 2])
    expect(short.subarray(2).toString('utf8')).toBe('hi')
    expect(longHeader).toEqual([0x81, 126, 300])
    expect(long.length).toBe(304)
  })

  it('operator sends a binary frame and it carries the payload bytes under the binary opcode', () => {
    // Given already-encoded bytes, a short payload and one past the 7-bit length form
    const payload = Buffer.from([0xcb, 0x2a, 0x4d, 0x00])
    const long = encodeBinaryFrame(Buffer.alloc(300, 0x7f))
    // When they are framed
    const frame = encodeBinaryFrame(payload)
    // Then each is one unmasked binary frame whose header only states the length
    expect([frame[0], frame[1]]).toEqual([0x82, payload.length])
    expect(frame.subarray(2)).toEqual(payload)
    expect([long[0], long[1], long.readUInt16BE(2)]).toEqual([0x82, 126, 300])
    expect(long.length).toBe(304)
  })

  it('operator sends a close frame and it carries the code and the reason', () => {
    // Given a close frame for a too-large message
    const frame = encodeCloseFrame(CLOSE_TOO_LARGE, 'too large')
    // When its payload is read back through the client parser's rules
    const payload = frame.subarray(2)
    // Then the two-byte code leads and the reason follows
    expect(payload.readUInt16BE(0)).toBe(1009)
    expect(payload.subarray(2).toString('utf8')).toBe('too large')
  })

  it('operator sends a pong and the payload echoes what the client pinged', () => {
    // Given an echo of a client's ping payload
    const frame = encodeServerFrame(0xa, Buffer.from('keepalive'))
    // When the frame header is read
    // Then it is one unmasked pong carrying exactly that payload
    expect([frame[0], frame[1]]).toEqual([0x8a, 9])
    expect(frame.subarray(2).toString('utf8')).toBe('keepalive')
  })
})
