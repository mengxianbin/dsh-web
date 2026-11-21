import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isLoopbackAddress, isLoopbackHostname, isLoopbackRequest, isProxiedRequest } from '../host/loopback.ts'

/** Minimal IncomingMessage stand-in: a socket address, a Host header, and optional extra headers. */
function fakeRequest(
  remoteAddress: string | undefined,
  host: string | undefined,
  extra: Record<string, string | undefined> = {},
): IncomingMessage {
  return { socket: { remoteAddress }, headers: { host, ...extra } } as unknown as IncomingMessage
}

describe('isLoopbackAddress', () => {
  it('accepts the full IPv4 127/8 range plus IPv6 loopback and IPv4-mapped forms', () => {
    for (const address of ['127.0.0.1', '127.0.0.2', '127.255.255.255', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(address)).toBe(true)
    }
  })

  it('rejects non-loopback and malformed addresses', () => {
    for (const address of ['128.0.0.1', '10.0.0.1', '127.999.0.1']) {
      expect(isLoopbackAddress(address)).toBe(false)
    }
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe('isLoopbackHostname', () => {
  it('accepts localhost, bracketed IPv6 loopback and 127/8 hostnames', () => {
    for (const hostname of ['localhost', '[::1]', '127.0.0.2']) {
      expect(isLoopbackHostname(hostname)).toBe(true)
    }
  })

  it('rejects non-loopback hostnames', () => {
    for (const hostname of ['example.com', '192.168.1.1']) {
      expect(isLoopbackHostname(hostname)).toBe(false)
    }
  })
})

describe('isLoopbackRequest', () => {
  it('passes a loopback socket with a loopback Host header', () => {
    expect(isLoopbackRequest(fakeRequest('127.0.0.1', '127.0.0.1:3000'))).toBe(true)
  })

  it('rejects a non-loopback socket even with a loopback Host', () => {
    expect(isLoopbackRequest(fakeRequest('192.168.1.20', '127.0.0.1:3000'))).toBe(false)
  })

  it('rejects cross-site fetches', () => {
    expect(isLoopbackRequest(fakeRequest('127.0.0.1', '127.0.0.1:3000', { 'sec-fetch-site': 'cross-site' }))).toBe(false)
  })

  it('rejects a mismatched origin', () => {
    expect(isLoopbackRequest(fakeRequest('127.0.0.1', '127.0.0.1:3000', { origin: 'http://evil.example' }))).toBe(false)
  })

  it('passes when no origin header is present', () => {
    const request = fakeRequest('127.0.0.1', 'localhost:3000')
    expect(request.headers.origin).toBeUndefined()
    expect(isLoopbackRequest(request)).toBe(true)
  })

  it('rejects an unparsable Host header', () => {
    expect(isLoopbackRequest(fakeRequest('127.0.0.1', '127.0.0.1:notaport'))).toBe(false)
  })
})

/**
 * A reverse proxy rewrites the Host to its own upstream literal and connects
 * over loopback, so both halves of the fence describe the proxy rather than the
 * client (Cloudflare Tunnel, frp, nginx). The forwarding header is what
 * separates such a request from a real desktop one (issue #1906).
 */
describe('isLoopbackRequest behind a reverse proxy', () => {
  it('keeps a direct desktop request loopback when no forwarding header is present', () => {
    const request = fakeRequest('127.0.0.1', '127.0.0.1:3080')
    expect(isProxiedRequest(request)).toBe(false)
    expect(isLoopbackRequest(request)).toBe(true)
  })

  it('refuses a loopback socket and loopback Host that carry cf-connecting-ip', () => {
    expect(isLoopbackRequest(fakeRequest('127.0.0.1', '127.0.0.1:3080', { 'cf-connecting-ip': '203.0.113.7' }))).toBe(false)
  })

  it('refuses a loopback socket and loopback Host that carry x-forwarded-for', () => {
    expect(isLoopbackRequest(fakeRequest('127.0.0.1', '127.0.0.1:3080', { 'x-forwarded-for': '203.0.113.7' }))).toBe(false)
  })

  it('refuses a forwarded request whose forwarding header is present but empty', () => {
    expect(isLoopbackRequest(fakeRequest('127.0.0.1', '127.0.0.1:3080', { 'x-forwarded-for': '' }))).toBe(false)
  })

  it('keeps the browser same-origin markers authoritative for a direct request', () => {
    expect(isLoopbackRequest(fakeRequest('127.0.0.1', '127.0.0.1:3080', { 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isLoopbackRequest(fakeRequest('127.0.0.1', '127.0.0.1:3080', { origin: 'http://evil.example' }))).toBe(false)
    expect(isLoopbackRequest(fakeRequest('127.0.0.1', '127.0.0.1:3080', { origin: 'http://127.0.0.1:3080' }))).toBe(true)
  })
})

describe('isProxiedRequest', () => {
  it('reports either forwarding header as a proxy hop', () => {
    expect(isProxiedRequest(fakeRequest('127.0.0.1', '127.0.0.1:3080', { 'cf-connecting-ip': '203.0.113.7' }))).toBe(true)
    expect(isProxiedRequest(fakeRequest('127.0.0.1', '127.0.0.1:3080', { 'x-forwarded-for': '203.0.113.7' }))).toBe(true)
  })

  it('reports a request with neither forwarding header as direct', () => {
    expect(isProxiedRequest(fakeRequest('127.0.0.1', '127.0.0.1:3080'))).toBe(false)
  })

  it('does not treat a transport-only marker as a forwarding header', () => {
    // x-forwarded-proto names the edge transport a tunnel terminates; it is not
    // a client-forwarding header, so it does not decide the classification.
    expect(isProxiedRequest(fakeRequest('127.0.0.1', '127.0.0.1:3080', { 'x-forwarded-proto': 'https' }))).toBe(false)
  })
})
