import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { makeSamplesRoute, type SamplesSnapshot } from '../src/host/routes.ts'

/** Minimal req double: the route reads url/headers/socket and writes once. */
function fakeReq(opts: { loopback?: boolean; url?: string } = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from('')]) as IncomingMessage
  stream.method = 'GET'
  stream.url = opts.url ?? '/api/sysmon/samples'
  stream.headers = { host: '127.0.0.1:3080' }
  stream.socket = { remoteAddress: opts.loopback === false ? '203.0.113.7' : '127.0.0.1' } as IncomingMessage['socket']
  return stream
}

interface Captured { status: number; body: unknown }
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(payload?: string) { if (payload !== undefined) captured.body = JSON.parse(payload) },
  } as unknown as ServerResponse
  return { res, captured }
}

function fakeCtx(): Context {
  return { get: () => undefined } as unknown as Context
}

function fakeSnapshot(): SamplesSnapshot {
  const sample = {
    t: 1_761_000_000_000,
    cpu: 12.4,
    mem: 61.2,
    memUsedBytes: 9_600_000_000,
    memTotalBytes: 15_700_000_000,
    diskBusy: 8.1,
    diskRead: 1_258_291,
    diskWrite: 419_430,
  }
  return {
    latest: sample,
    warn: { cpu: false, mem: false, disk: false },
    thresholds: { cpu: 90, mem: 90, disk: 90 },
    net: { connMs: 128, connAt: 1_761_000_000_000, connVia: 'direct', ttftMs: null, failures: 2, provider: 'deepseek', warn: true },
    history: [sample],
  }
}

async function run(handler: (req: IncomingMessage, res: ServerResponse) => void, req: IncomingMessage): Promise<Captured> {
  const { res, captured } = fakeRes()
  handler(req, res)
  return captured
}

describe('makeSamplesRoute', () => {
  it('serves the snapshot for a loopback request without history by default', async () => {
    const route = makeSamplesRoute(fakeCtx(), fakeSnapshot)
    const captured = await run(route.handler as (r: IncomingMessage, s: ServerResponse) => void, fakeReq())
    expect(captured.status).toBe(200)
    const body = captured.body as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect((body.latest as { cpu: number }).cpu).toBe(12.4)
    expect(body.warn).toEqual({ cpu: false, mem: false, disk: false })
    expect(body.thresholds).toEqual({ cpu: 90, mem: 90, disk: 90 })
    expect(body.net).toEqual({ connMs: 128, connAt: 1_761_000_000_000, connVia: 'direct', ttftMs: null, failures: 2, provider: 'deepseek', warn: true })
    expect(body.history).toBeUndefined()
  })

  it('includes history only when asked with ?history=1', async () => {
    const route = makeSamplesRoute(fakeCtx(), fakeSnapshot)
    const captured = await run(
      route.handler as (r: IncomingMessage, s: ServerResponse) => void,
      fakeReq({ url: '/api/sysmon/samples?history=1' }),
    )
    expect(captured.status).toBe(200)
    expect((captured.body as { history: unknown[] }).history).toHaveLength(1)
  })

  it('403s a non-loopback request (unpaired tunnel or LAN client)', async () => {
    const route = makeSamplesRoute(fakeCtx(), fakeSnapshot)
    const captured = await run(route.handler as (r: IncomingMessage, s: ServerResponse) => void, fakeReq({ loopback: false }))
    expect(captured.status).toBe(403)
    expect(captured.body).toMatchObject({ ok: false })
  })

  it('registers at the exact /api/sysmon/samples path', () => {
    const route = makeSamplesRoute(fakeCtx(), fakeSnapshot)
    expect(route.kind).toBe('exact')
    expect(route.path).toBe('/api/sysmon/samples')
  })
})
