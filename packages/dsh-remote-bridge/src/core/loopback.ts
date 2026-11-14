/**
 * The gate in front of the bootstrap token endpoint.
 *
 * The socket address alone is NOT a loopback proof on this deployment: a
 * request that arrives over a public tunnel is terminated by the tunnel client
 * on the same machine, so cloudflared connects to the origin from loopback and
 * `req.socket.remoteAddress` reads `127.0.0.1` for a request the whole internet
 * can reach. The reliable discriminator is the `Host` header, which both the
 * market relay and a plain tunnel rewrite to the public hostname before the
 * origin sees the request (`market/worker/src/relay.js:263` sets it to the
 * registered tunnel host). Both conditions must hold, so a forged
 * `remoteAddress` in a test — or a proxy that forgets to rewrite `Host` — still
 * cannot mint a pairing token.
 * @module dsh-remote-bridge/core/loopback
 */

import type { IncomingMessage } from 'node:http'

/** Socket addresses that count as "this machine". */
export const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Host header values that count as "this machine". */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** @returns whether a socket's remote address is this machine. */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_ADDRESSES.has(remoteAddress)
}

/**
 * @returns whether a `Host` header names this machine. The port is ignored;
 *   anything that is not a loopback literal — including a public tunnel
 *   hostname — is refused.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const name = host.trim().toLowerCase()
  if (name === '') return false
  const bare = name.startsWith('[')
    // IPv6 literals carry their port after the closing bracket.
    ? name.slice(0, name.indexOf(']') + 1)
    : name.split(':')[0] ?? ''
  return LOOPBACK_HOSTS.has(bare)
}

/**
 * Why this request may not reach the bootstrap token endpoint, or undefined
 * when it may.
 * @param req - the incoming request.
 * @returns a one-line reason, or undefined.
 */
export function loopbackDenialOf(req: IncomingMessage): string | undefined {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return 'the request did not arrive from this machine'
  }
  if (!isLoopbackHost(req.headers.host)) {
    return 'the request names a Host that is not this machine'
  }
  return undefined
}
