/** Connection tap: direct vs proxy segment shapes, first-hop linking, disposal, failure paths. */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type net from 'node:net'
import type tls from 'node:tls'
import { isLoopbackHost, tapConnections, type ConnSegment, type ConnTapNetModule } from '../src/host/conn-tap.ts'

/** A stand-in socket: EventEmitter is enough — the tap only reads .once. */
class FakeSocket extends EventEmitter {}

/** A fake node:net module face whose connect can be wrapped and restored. */
function fakeNet() {
  const original = vi.fn((..._args: unknown[]) => new FakeSocket())
  const module: ConnTapNetModule = { connect: original as unknown as typeof net.connect, createConnection: original as unknown as typeof net.connect }
  return { module, original }
}

/** A fake node:tls module face. */
function fakeTls() {
  const original = vi.fn((..._args: unknown[]) => new FakeSocket() as unknown as tls.TLSSocket)
  const module = { connect: original as unknown as typeof tls.connect }
  return { module, original }
}

/** Call the fake tls.connect with untyped args — the tap reads options structurally, overloads are irrelevant here. */
function callTls(fake: ReturnType<typeof fakeTls>, ...args: unknown[]): FakeSocket {
  return (fake.module.connect as unknown as (...inner: unknown[]) => FakeSocket)(...args)
}

function harness() {
  let now = 1_761_000_000_000
  const segments: ConnSegment[] = []
  const netFake = fakeNet()
  const tlsFake = fakeTls()
  const stop = tapConnections((segment) => segments.push(segment), {
    netModule: netFake.module,
    tlsModule: tlsFake.module,
    now: () => now,
  })
  return {
    segments,
    netFake,
    tlsFake,
    stop,
    advance(ms: number) { now += ms },
  }
}

describe('isLoopbackHost', () => {
  it('treats localhost forms and the undefined default as loopback', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.42.0.9')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost(undefined)).toBe(true)
  })

  it('treats real hosts as non-loopback', () => {
    expect(isLoopbackHost('api.deepseek.com')).toBe(false)
    expect(isLoopbackHost('203.0.113.7')).toBe(false)
  })
})

describe('tapConnections', () => {
  it('measures a direct handshake from the tls.connect call to secureConnect', () => {
    const h = harness()
    const socket = callTls(h.tlsFake, { host: 'api.deepseek.com', port: 443 })
    h.advance(25)
    socket.emit('secureConnect')
    expect(h.segments).toEqual([{ ms: 25, via: 'direct' }])
  })

  it('measures a proxy tunnel from the loopback first hop and labels it proxy', () => {
    const h = harness()
    const firstHop = h.netFake.module.connect({ host: '127.0.0.1', port: 7897 }) as unknown as FakeSocket
    h.advance(3) // loopback TCP to the local proxy
    const tunnel = callTls(h.tlsFake, { socket: firstHop, servername: 'api.deepseek.com' })
    h.advance(117) // CONNECT reply + TLS handshake over the tunnel
    tunnel.emit('secureConnect')
    // Span starts at the first hop: 3ms loopback + 117ms network-dominated.
    expect(h.segments).toEqual([{ ms: 120, via: 'proxy' }])
  })

  it('labels a TLS leg over a non-loopback first hop as direct (full real-network span)', () => {
    const h = harness()
    const firstHop = h.netFake.module.connect({ host: '203.0.113.7', port: 443 }) as unknown as FakeSocket
    const tunnel = callTls(h.tlsFake, { socket: firstHop, servername: 'origin.example' })
    h.advance(40)
    tunnel.emit('secureConnect')
    expect(h.segments).toEqual([{ ms: 40, via: 'direct' }])
  })

  it('falls back to direct when the TLS leg carries no instrumented socket', () => {
    const h = harness()
    const tunnel = callTls(h.tlsFake, { socket: new FakeSocket(), servername: 'origin.example' })
    h.advance(12)
    tunnel.emit('secureConnect')
    expect(h.segments).toEqual([{ ms: 12, via: 'direct' }])
  })

  it('reports nothing when the handshake errors out before secureConnect', () => {
    const h = harness()
    const socket = callTls(h.tlsFake, { host: 'api.deepseek.com', port: 443 })
    // The tap attaches no error listener (zero behavior change); the real
    // stack owns error handling, so stand in for it here.
    socket.on('error', () => { /* consumed by the real caller */ })
    socket.emit('error', new Error('ECONNRESET'))
    expect(h.segments).toEqual([])
  })

  it('never lets a segment observer break the socket', () => {
    let now = 1_761_000_000_000
    const netFake = fakeNet()
    const tlsFake = fakeTls()
    const stop = tapConnections(() => { throw new Error('observer bug') }, {
      netModule: netFake.module,
      tlsModule: tlsFake.module,
      now: () => now,
    })
    const socket = callTls(tlsFake, { host: 'api.deepseek.com', port: 443 })
    now += 5
    expect(() => { socket.emit('secureConnect') }).not.toThrow()
    stop()
  })

  it('wraps and restores both net aliases on dispose', () => {
    const h = harness()
    const wrapped = h.netFake.module.connect
    expect(h.netFake.module.createConnection).toBe(wrapped)
    expect(h.netFake.module.connect).not.toBe(h.netFake.original)
    h.stop()
    expect(h.netFake.module.connect).toBe(h.netFake.original)
    expect(h.netFake.module.createConnection).toBe(h.netFake.original)
    expect(h.tlsFake.module.connect).toBe(h.tlsFake.original)
    // A handshake completing after dispose reports nothing (alive flag).
    const socket = callTls(h.tlsFake, { host: 'api.deepseek.com', port: 443 })
    h.advance(9)
    socket.emit('secureConnect')
    expect(h.segments).toEqual([])
  })
})
