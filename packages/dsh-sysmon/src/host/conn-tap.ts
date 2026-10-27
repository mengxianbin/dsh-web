/**
 * Socket-layer connection-segment tap (2026-10-27 revision). Wraps the
 * process-wide `net.connect` / `tls.connect` / `net.createConnection` entry
 * points the undici fetch stack calls — probe-verified on this machine's
 * Node 24 (2026-10-27): a direct request reaches `tls.connect({ host })`
 * and lands lookup/connect/secureConnect on the returned TLSSocket; a
 * proxied request reaches `net.connect(<local proxy>)` first and then
 * `tls.connect({ socket, servername })` over the CONNECT tunnel, so the
 * first hop's start time links to the TLS leg through the WeakMap. On
 * secureConnect it reports one {@link ConnSegment}: first-hop start →
 * TLS handshake done.
 *
 * Segment shapes — what the reading actually measures (stated honestly in
 * the chip tooltip, ruling `sysmon-net-direction` 2026-10-27):
 * - `direct`: DNS + TCP connect + TLS handshake, all of it real network.
 * - `proxy` (local HTTP proxy, HTTP CONNECT): the TCP leg to the proxy is
 *   loopback and NOT network; the measured span is that loopback connect +
 *   the CONNECT reply (the proxy's own TCP handshake to the origin) + the
 *   TLS handshake over the tunnel — network-dominated, on the order of a
 *   true RTT chain.
 *
 * Passive: listeners only, zero behavior change on any connection. The
 * disposer restores the entry points when they are still ours (a wrapper
 * installed later wins and is left alone) and drops late callbacks. Plain
 * HTTP connections never report — the model path is HTTPS.
 * @module dsh-sysmon/host/conn-tap
 */

import net from 'node:net'
import type { Socket } from 'node:net'
import tls from 'node:tls'
import type { TLSSocket } from 'node:tls'
import type { SysmonNetVia } from '../core/types.ts'

/** One settled connection segment: first-hop start → TLS secureConnect. */
export interface ConnSegment {
  /** Elapsed milliseconds, clamped at 0 (never negative). */
  ms: number
  /** Which handshake shape produced it. */
  via: SysmonNetVia
}

/** The socket identity the TLS leg looks its first hop up through. */
interface FirstHop {
  t0: number
  host: string | undefined
}

/** The net module face the tap wraps; `createConnection` aliases `connect` on the real module. */
export interface ConnTapNetModule {
  connect: typeof net.connect
  createConnection?: typeof net.connect
}

/** The seam tests drive without real sockets or the real clock. */
export interface ConnTapDeps {
  /** Module object whose connect aliases get wrapped (default: the real `node:net`). */
  netModule?: ConnTapNetModule
  /** Module object whose `connect` gets wrapped (default: the real `node:tls`). */
  tlsModule?: { connect: typeof tls.connect }
  /** Clock seam (default `Date.now`); tests hand-crank it. */
  now?(): number
}

/** Loopback test for the first hop: an undefined host means net.connect's localhost default. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true
  const normalized = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized.startsWith('127.')
}

/** First-hop host from net.connect's (options | port[, host]) overloads. */
function hostOf(args: readonly unknown[]): string | undefined {
  const first = args[0]
  if (typeof first === 'object' && first !== null) return (first as { host?: string }).host
  if (typeof first === 'number' && typeof args[1] === 'string') return args[1]
  return undefined
}

/** The tls.connect options object from its (options | port, host, …) overloads. */
function tlsOptions(args: readonly unknown[]): { socket?: unknown } {
  const first = args[0]
  return typeof first === 'object' && first !== null ? (first as { socket?: unknown }) : {}
}

/**
 * Install the connection-segment tap on the net/tls connect entry points.
 * @param onSegment - receives one segment per completed TLS handshake; its
 *   exceptions are swallowed (an observer must never break a socket).
 * @param deps - seam for tests: fake modules and clock; production omits it.
 * @returns a disposer restoring the entry points (idempotent, identity-guarded).
 */
export function tapConnections(
  onSegment: (segment: ConnSegment) => void,
  deps: ConnTapDeps = {},
): () => void {
  const now = deps.now ?? (() => Date.now())
  const netMod = deps.netModule ?? (net as unknown as ConnTapNetModule)
  const tlsMod = deps.tlsModule ?? (tls as unknown as { connect: typeof tls.connect })
  const firstHops = new WeakMap<Socket, FirstHop>()
  let alive = true

  const origNetConnect = netMod.connect
  const wrappedNetConnect = ((...args: unknown[]): Socket => {
    const socket = (origNetConnect as (...inner: unknown[]) => Socket)(...args)
    // Records only — no listeners, no behavior change; the TLS leg below
    // reads this back through its options.socket argument (proxy tunnel) or
    // never sees it (direct handshake, t0 = the tls.connect call itself).
    firstHops.set(socket, { t0: now(), host: hostOf(args) })
    return socket
  }) as typeof netMod.connect
  const origCreateConnection = netMod.createConnection
  netMod.connect = wrappedNetConnect
  if (origCreateConnection !== undefined) netMod.createConnection = wrappedNetConnect

  const origTlsConnect = tlsMod.connect
  const wrappedTlsConnect = ((...args: unknown[]): TLSSocket => {
    const options = tlsOptions(args)
    const firstHop = options.socket === undefined ? undefined : firstHops.get(options.socket as Socket)
    // Proxy tunnel: span starts at the (loopback) first hop — its TCP leg is
    // negligible, but the CONNECT reply that follows is real network.
    // Direct: the tls.connect call itself precedes DNS + TCP + TLS.
    const t0 = firstHop?.t0 ?? now()
    const via: SysmonNetVia = firstHop !== undefined && isLoopbackHost(firstHop.host) ? 'proxy' : 'direct'
    const socket = (origTlsConnect as (...inner: unknown[]) => TLSSocket)(...args)
    socket.once('secureConnect', () => {
      if (!alive) return
      try {
        onSegment({ ms: Math.max(0, now() - t0), via })
      } catch { /* observer must never break the socket */ }
    })
    return socket
  }) as typeof tlsMod.connect
  tlsMod.connect = wrappedTlsConnect

  return () => {
    alive = false
    // Identity-guarded: a wrapper someone else installed later still chains
    // to ours, so leave their layer alone and only unwind ours.
    if (netMod.connect === wrappedNetConnect) netMod.connect = origNetConnect
    if (netMod.createConnection === wrappedNetConnect) netMod.createConnection = origCreateConnection
    if (tlsMod.connect === wrappedTlsConnect) tlsMod.connect = origTlsConnect
  }
}
