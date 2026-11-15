import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { STAGGER_MIN_MS } from '../src/config.ts'
import { RevivalPolicy } from '../src/policy.ts'
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

  it('echoes the effective condition lists from the status payload (拍板⑨ 回显生效清单)', async () => {
    const route = makeStatusRoute(() => ({
      mode: 'shadow',
      conditions: { revive: ['TRANSPORT', 'TIMEOUT'], wall: ['QUOTA'], overridden: ['wallCodes'] },
      counters: { detected: 1 },
    }))
    const captured = await run(route.handler, fakeReq('GET'))
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({
      ok: true,
      mode: 'shadow',
      conditions: { revive: ['TRANSPORT', 'TIMEOUT'], wall: ['QUOTA'], overridden: ['wallCodes'] },
    })
  })

  it('echoes the selflearn statistics block while the existing fields keep their shape (拍板⑭ 统计回显)', async () => {
    const policy = new RevivalPolicy({ staggerMs: STAGGER_MIN_MS })
    const at = 1_760_000_000_000
    policy.onError({ sessionId: 'A', code: 'TRANSPORT', at })
    policy.onSuccess('A', at + 1_000)
    const route = makeStatusRoute(() => ({ mode: 'live', ...policy.snapshot(at + 1_000) }))
    const captured = await run(route.handler, fakeReq('GET'))
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({
      ok: true,
      service: 'dsh-session-revive',
      mode: 'live',
      // 既有字段零改动 (验收②): counters/quota/skipReasons still ride unchanged.
      counters: expect.objectContaining({ detected: expect.any(Number) }),
      quota: expect.any(Array),
      skipReasons: expect.any(Object),
      // 新增字段 = the selflearn statistics echo (拍板⑭).
      selflearn: {
        windowDays: 30,
        thresholds: { minN: 10, minRate: 0.55, evictStrikes: 3 },
        admitted: [],
        evicted: [],
        codes: [{ code: 'TRANSPORT', n: 1, recovered: 1, rate: 1, excluded: 0, strikes: 0 }],
      },
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
