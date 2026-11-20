/**
 * GET /api/session-dispatch/attention — the read-only id → class face the
 * hover card's session-origin line consumes (hover-sessionclass-1121).
 *
 * Covers the route contract end to end: a real AttentionLedger over a temp
 * ledger file answers 200 with the stored map (keys passed through as
 * stored), the route mounts only while an attention service is composed, the
 * method and loopback fences hold, and a ledger failure answers 500 rather
 * than a partial map.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import {
  AttentionLedger,
  defaultAttentionPath,
  type AttentionRegistry,
} from '../src/host/attention.ts'
import {
  makeAttentionRoute,
  makeDispatchRoutes,
  type DispatchAttentionApi,
} from '../src/host/routes.ts'

const tempDirs: string[] = []
afterEach(() => {
  tempDirs.length = 0
})

/** Minimal req/res doubles (same shape as routes.spec.ts). */
function fakeReq(method: string, opts: { loopback?: boolean; url?: string } = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from('')]) as IncomingMessage
  stream.method = method
  stream.url = opts.url ?? '/api/session-dispatch/attention'
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

async function run(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void, req: IncomingMessage): Promise<Captured> {
  const { res, captured } = fakeRes()
  await handler(req, res)
  return captured
}

/** Registry double: no members, pins never touched (the read face must not pin). */
class IdleRegistry implements AttentionRegistry {
  list(): readonly { readonly sessionIds: readonly string[] }[] {
    return []
  }

  get archivedSessionIds(): readonly string[] {
    return []
  }

  async pinSession(): Promise<void> {}

  async unpinSession(): Promise<void> {}
}

/** Ledger over a temp file pre-seeded with one document. */
async function ledgerFor(sessions: Record<string, unknown>): Promise<{ ledger: AttentionLedger; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-attention-route-'))
  tempDirs.push(dir)
  const path = defaultAttentionPath(dir)
  await writeFile(path, JSON.stringify({ version: 1, sessions }), 'utf8')
  return { ledger: new AttentionLedger({ registry: new IdleRegistry(), attentionPath: path }), path }
}

describe('GET /api/session-dispatch/attention', () => {
  it('answers 200 with the stored id → class map, keys as stored', async () => {
    const { ledger } = await ledgerFor({
      'session-a': { class: 'bot-worker', defaultApplied: true, source: 'dispatch', updatedAt: '2026-11-21T00:00:00.000Z' },
      'session-b': { class: 'human', defaultApplied: true, source: 'startup', updatedAt: '2026-11-21T00:00:00.000Z' },
      // A bare key (no session- prefix) passes through untouched: the client
      // resolves both spellings, the endpoint never rewrites ledger keys.
      'bare-c': { class: 'bot-boss', defaultApplied: true, source: 'first-message', updatedAt: '2026-11-21T00:00:00.000Z' },
    })
    const captured = await run(makeAttentionRoute(ledger).handler!, fakeReq('GET'))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({
      ok: true,
      classes: {
        'session-a': 'bot-worker',
        'session-b': 'human',
        'bare-c': 'bot-boss',
      },
    })
  })

  it('answers 200 with an empty map when the ledger file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-attention-route-'))
    tempDirs.push(dir)
    const ledger = new AttentionLedger({ registry: new IdleRegistry(), attentionPath: defaultAttentionPath(dir) })
    const captured = await run(makeAttentionRoute(ledger).handler!, fakeReq('GET'))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, classes: {} })
  })

  it('answers 405 for a non-GET method and 403 off the loopback fence', async () => {
    const { ledger } = await ledgerFor({})
    const route = makeAttentionRoute(ledger)
    const post = await run(route.handler!, fakeReq('POST'))
    expect(post.status).toBe(405)
    const offHost = await run(route.handler!, fakeReq('GET', { loopback: false }))
    expect(offHost.status).toBe(403)
  })

  it('answers 500 with the error detail when the ledger read fails', async () => {
    const broken: DispatchAttentionApi = {
      async declare() {},
      async classes() { throw new Error('ledger read failed') },
    }
    const captured = await run(makeAttentionRoute(broken).handler!, fakeReq('GET'))
    expect(captured.status).toBe(500)
    expect(captured.body).toEqual({ ok: false, error: 'ledger read failed' })
  })

  it('mounts the attention route only while an attention service is composed', () => {
    const attention: DispatchAttentionApi = {
      async declare() {},
      async classes() { return {} },
    }
    const paths = (services: { attention?: DispatchAttentionApi }): string[] =>
      makeDispatchRoutes({
        sessions: {
          async create() { return { sessionId: 'session-abc' } },
          async rename() { return {} },
          async prompt() { return { accepted: true } },
          async cancel() { return { accepted: true } },
        },
        workspaces: { get: () => undefined },
        ...(services.attention === undefined ? {} : { attention: services.attention }),
      }).map(route => route.path)
    expect(paths({ attention })).toContain('/api/session-dispatch/attention')
    expect(paths({})).not.toContain('/api/session-dispatch/attention')
  })
})
