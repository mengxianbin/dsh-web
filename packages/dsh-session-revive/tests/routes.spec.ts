import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { REVIVE_API_PREFIX, makeStatusRoute } from '../src/host/routes.ts'

/** Minimal req/res doubles: the route only reads method/url/headers/socket and writes one JSON response. */
function fakeReq(method: string, opts: { loopback?: boolean } = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from('')]) as IncomingMessage
  stream.method = method
  stream.url = `${REVIVE_API_PREFIX}/status`
  stream.headers = { host: '127.0.0.1:3080' }
  stream.socket = { remoteAddress: opts.loopback === false ? '203.0.113.7' : '127.0.0.1' } as IncomingMessage['socket']
  return stream
}

interface Captured {
  status: number
  body: unknown
}
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return res
    },
    end(payload?: string) {
      if (payload !== undefined) captured.body = JSON.parse(payload)
    },
  } as unknown as ServerResponse
  return { res, captured }
}

async function run(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  req: IncomingMessage,
): Promise<Captured> {
  const { res, captured } = fakeRes()
  await handler(req, res)
  return captured
}

describe('GET /api/session-revive/status', () => {
  it('serves mode and the fresh snapshot over loopback', async () => {
    const route = makeStatusRoute(() => ({ mode: 'shadow', counters: { detected: 2 } }))
    expect(route.kind).toBe('exact')
    expect(route.path).toBe(`${REVIVE_API_PREFIX}/status`)
    const captured = await run(route.handler, fakeReq('GET'))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({
      ok: true,
      service: 'dsh-session-revive',
      mode: 'shadow',
      counters: { detected: 2 },
    })
  })

  it('refuses non-loopback callers with 403', async () => {
    const route = makeStatusRoute(() => ({ mode: 'shadow' }))
    const captured = await run(route.handler, fakeReq('GET', { loopback: false }))
    expect(captured.status).toBe(403)
    expect(captured.body).toMatchObject({ ok: false, error: 'forbidden: loopback-only' })
  })

  it('refuses non-GET methods with 405', async () => {
    const route = makeStatusRoute(() => ({ mode: 'shadow' }))
    const captured = await run(route.handler, fakeReq('POST'))
    expect(captured.status).toBe(405)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('GET') })
  })
})
