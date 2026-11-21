/**
 * Canonical tests for the shared pairing trust fence (shared/host/pair-access.ts);
 * each consuming package keeps a small wrapper spec for its own wiring.
 */
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { isPairedOrLoopbackAllowed } from '../host/pair-access.ts'

function request(options: {
  remoteAddress?: string
  host?: string
  cookie?: string
} = {}): IncomingMessage {
  return {
    headers: {
      host: options.host ?? '127.0.0.1:3000',
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as IncomingMessage
}

describe('isPairedOrLoopbackAllowed', () => {
  it('allows loopback without a pairing service', () => {
    expect(isPairedOrLoopbackAllowed({} as never, request())).toBe(true)
  })

  it('refuses a LAN client when no pairing service is present', () => {
    const ctx = { get: () => undefined }
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
    }))).toBe(false)
  })

  it('allows a LAN client with a live paired-device cookie', () => {
    const isPairedDevice = vi.fn(() => true)
    const ctx = { get: (name: string) => name === 'remoteWebUiPairing' ? { isPairedDevice } : undefined }
    const req = request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
      cookie: 'dsh_pair=dev-1',
    })
    expect(isPairedOrLoopbackAllowed(ctx as never, req)).toBe(true)
    expect(isPairedDevice).toHaveBeenCalledWith(req)
  })

  it('refuses a LAN client when pairing returns false (revoked or unknown)', () => {
    const ctx = { get: () => ({ isPairedDevice: () => false }) }
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
      cookie: 'dsh_pair=revoked',
    }))).toBe(false)
  })

  it('falls back to the direct remoteWebUiPairing property when ctx.get is absent', () => {
    const ctx = { remoteWebUiPairing: { isPairedDevice: () => true } }
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
      cookie: 'dsh_pair=dev-1',
    }))).toBe(true)
  })

  it('refuses instead of throwing when the property lookup throws (un-injected cordis service)', () => {
    // cordis answers a property read of an un-injected service by throwing; the
    // fence must treat that as "no pairing service", never leak it to the route
    // handler where it becomes an empty-body 400 (#1942).
    const ctx = Object.defineProperty({}, 'remoteWebUiPairing', {
      get(): never {
        throw new Error('cannot get property "remoteWebUiPairing" without inject')
      },
    })
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
      cookie: 'dsh_pair=dev-1',
    }))).toBe(false)
  })

  it('never reads the throwing property when ctx.get already answered', () => {
    const get = vi.fn(() => undefined)
    const ctx = Object.defineProperty({ get }, 'remoteWebUiPairing', {
      get(): never {
        throw new Error('cannot get property "remoteWebUiPairing" without inject')
      },
    })
    expect(isPairedOrLoopbackAllowed(ctx as never, request({
      remoteAddress: '192.168.1.20',
      host: 'dsh.example:443',
    }))).toBe(false)
    expect(get).toHaveBeenCalledWith('remoteWebUiPairing', false)
  })
})
