import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { AUTO_ROUTE_API_PREFIX, makeAutoRouteRoutes, makeStatusRoute, type AutoRouteStatusProvider } from '../src/host/routes.ts'

/** Minimal req/res doubles: routes read method/url/headers/socket and write one JSON response. */
function fakeReq(method: string, opts: { loopback?: boolean } = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from('')]) as IncomingMessage
  stream.method = method
  stream.url = `${AUTO_ROUTE_API_PREFIX}/status`
  stream.headers = { host: '127.0.0.1:3080' }
  stream.socket = { remoteAddress: opts.loopback === false ? '203.0.113.7' : '127.0.0.1' } as IncomingMessage['socket']
  return stream
}

interface Captured { status: number; body: unknown; headers: Record<string, unknown> }
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined, headers: {} }
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) { captured.status = status; captured.headers = headers ?? {}; return res },
    end(payload?: string) { if (payload !== undefined) captured.body = JSON.parse(payload) },
  } as unknown as ServerResponse
  return { res, captured }
}

function provider(override: Partial<AutoRouteStatusProvider> = {}): AutoRouteStatusProvider {
  return { status: () => ({ service: 'dsh-auto-route', policy: { phase: 'baseline', effectiveSource: 'opencode-go' } }), ...override }
}

async function run(routeHandler: ReturnType<typeof makeStatusRoute>['handler'], req: IncomingMessage): Promise<Captured> {
  const { res, captured } = fakeRes()
  await routeHandler(req, res)
  return captured
}

describe('GET /api/auto-route/status', () => {
  it('answers 200 with ok plus the policy object, no-store', async () => {
    const captured = await run(makeStatusRoute(provider()).handler, fakeReq('GET'))
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({
      ok: true,
      service: 'dsh-auto-route',
      policy: { phase: 'baseline', effectiveSource: 'opencode-go' },
    })
    expect(captured.headers['cache-control']).toBe('no-store')
  })

  it('refuses non-loopback callers with 403', async () => {
    const captured = await run(makeStatusRoute(provider()).handler, fakeReq('GET', { loopback: false }))
    expect(captured.status).toBe(403)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('loopback-only') })
  })

  it('refuses non-GET methods with 405', async () => {
    const captured = await run(makeStatusRoute(provider()).handler, fakeReq('POST'))
    expect(captured.status).toBe(405)
  })

  it('answers 500 when the status producer throws', async () => {
    const captured = await run(
      makeStatusRoute({ status: () => { throw new Error('boom') } }).handler,
      fakeReq('GET'),
    )
    expect(captured.status).toBe(500)
    expect(captured.body).toMatchObject({ ok: false, error: 'boom' })
  })

  it('exposes exactly one route', () => {
    const routes = makeAutoRouteRoutes(provider())
    expect(routes).toHaveLength(1)
    expect(routes[0].kind).toBe('exact')
    expect(routes[0].path).toBe('/api/auto-route/status')
  })
})
