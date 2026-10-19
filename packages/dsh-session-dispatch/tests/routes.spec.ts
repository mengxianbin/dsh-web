import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import {
  makeDispatchRoutes,
  makeHealthRoute,
  makeBindingsRoute,
  parseDispatchBody,
  type DispatchBinding,
  type DispatchBindingStore,
  type DispatchServices,
} from '../src/host/routes.ts'

/** Minimal req/res doubles: the routes only read method/url/headers/socket and write one JSON response. */
function fakeReq(method: string, body: unknown, opts: { loopback?: boolean; url?: string } = {}): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from([Buffer.from(payload)]) as IncomingMessage
  stream.method = method
  stream.url = opts.url ?? '/api/session-dispatch'
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

function happyServices(overrides: Partial<DispatchServices> = {}): DispatchServices {
  return {
    sessions: {
      async create() { return { sessionId: 'session-abc' } },
      async rename() { return {} },
      async prompt() { return { accepted: true } },
    },
    workspaces: { get: (id: string) => (id === 'ws-1' ? { id: 'ws-1' } : undefined) },
    ...overrides,
  }
}

async function run(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void, req: IncomingMessage): Promise<Captured> {
  const { res, captured } = fakeRes()
  await handler(req, res)
  return captured
}

describe('parseDispatchBody', () => {
  it('accepts a minimal request and trims fields', () => {
    const parsed = parseDispatchBody({ workspaceId: ' ws-1 ', prompt: 'do the thing' })
    expect(parsed).toEqual({ ok: true, value: { workspaceId: 'ws-1', prompt: 'do the thing' } })
  })

  it('carries optional title, mode, and permission through', () => {
    const parsed = parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', title: 'T', mode: 'standard', permission: 'danger-full-access' })
    expect(parsed).toEqual({ ok: true, value: { workspaceId: 'ws-1', prompt: 'x', title: 'T', mode: 'standard', permission: 'danger-full-access' } })
  })

  it('rejects a non-object body', () => {
    expect(parseDispatchBody('nope').ok).toBe(false)
    expect(parseDispatchBody(null).ok).toBe(false)
    expect(parseDispatchBody([]).ok).toBe(false)
  })

  it('rejects a missing or blank workspaceId', () => {
    expect(parseDispatchBody({ prompt: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('workspaceId') })
    expect(parseDispatchBody({ workspaceId: '  ', prompt: 'x' })).toMatchObject({ ok: false })
  })

  it('rejects a missing or blank prompt', () => {
    expect(parseDispatchBody({ workspaceId: 'ws-1' })).toMatchObject({ ok: false, error: expect.stringContaining('prompt') })
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: '   ' })).toMatchObject({ ok: false })
  })

  it('rejects an oversized prompt', () => {
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x'.repeat(900_001) })).toMatchObject({ ok: false, error: expect.stringContaining('900000') })
  })

  it('rejects an unknown permission preset', () => {
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', permission: 'root' })).toMatchObject({ ok: false, error: expect.stringContaining('permission') })
  })

  it('rejects a blank title or mode', () => {
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', title: ' ' })).toMatchObject({ ok: false })
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', mode: '' })).toMatchObject({ ok: false })
  })

  it('carries an optional taskRef through and trims it', () => {
    const parsed = parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', taskRef: ' content/tasks/todo-series.md#L144 ' })
    expect(parsed).toEqual({ ok: true, value: { workspaceId: 'ws-1', prompt: 'x', taskRef: 'content/tasks/todo-series.md#L144' } })
  })

  it('rejects a blank or oversized taskRef', () => {
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', taskRef: ' ' })).toMatchObject({ ok: false, error: expect.stringContaining('taskRef') })
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', taskRef: 'r'.repeat(2001) })).toMatchObject({ ok: false, error: expect.stringContaining('taskRef') })
  })
})

describe('dispatch route', () => {
  const route = makeDispatchRoutes(happyServices())[0]

  it('creates, renames, and prompts, answering the sessionId', async () => {
    const calls: string[] = []
    const services = happyServices({
      sessions: {
        async create(request) { calls.push(`create:${JSON.stringify(request)}`); return { sessionId: 'session-abc' } },
        async rename(request) { calls.push(`rename:${request.title}`); return {} },
        async prompt(request) { calls.push(`prompt:${request.mode}:${request.content[0]?.text}`); return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'do it', title: 'Dispatch test' }))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, sessionId: 'session-abc' })
    expect(calls).toEqual(['create:{"workspaceId":"ws-1"}', 'rename:Dispatch test', 'prompt:queue:do it'])
  })

  it('passes the agent preset through create', async () => {
    let seen: Record<string, unknown> | undefined
    const services = happyServices({
      sessions: {
        async create(request) { seen = request as unknown as Record<string, unknown>; return { sessionId: 's' } },
        async rename() { return {} },
        async prompt() { return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x', mode: 'ptc' }))
    expect(seen).toEqual({ workspaceId: 'ws-1', agentPreset: 'ptc' })
  })

  it('pins the permission through the command executor before prompting', async () => {
    const calls: string[] = []
    const services = happyServices({
      agents: { get: () => ({ id: 'agent' }) },
      commands: {
        async execute(_agent, line) { calls.push(line); return { result: { kind: 'success' } } },
      },
      sessions: {
        async create() { return { sessionId: 'session-abc' } },
        async rename() { return {} },
        async prompt() { calls.push('prompt'); return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x', permission: 'read-only' }))
    expect(captured.status).toBe(200)
    expect(calls).toEqual(['/permission read-only', 'prompt'])
  })

  it('answers 400 when a permission pin fails, without prompting', async () => {
    let prompted = false
    const services = happyServices({
      agents: { get: () => ({ id: 'agent' }) },
      commands: { async execute() { return { result: { kind: 'error', text: 'no such preset' } } } },
      sessions: {
        async create() { return { sessionId: 'session-abc' } },
        async rename() { return {} },
        async prompt() { prompted = true; return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x', permission: 'read-only' }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('permission pin failed') })
    expect(prompted).toBe(false)
  })

  it('rejects an unknown workspace with 404 before creating anything', async () => {
    let created = false
    const services = happyServices({
      sessions: {
        async create() { created = true; return { sessionId: 's' } },
        async rename() { return {} },
        async prompt() { return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'missing', prompt: 'x' }))
    expect(captured.status).toBe(404)
    expect(created).toBe(false)
  })

  it('rejects an invalid body with 400', async () => {
    const handler = makeDispatchRoutes(happyServices())[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1' }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('prompt') })
  })

  it('rejects invalid JSON with 400', async () => {
    const handler = makeDispatchRoutes(happyServices())[0].handler!
    const req = fakeReq('POST', undefined)
    const stream = Readable.from([Buffer.from('{not json')]) as IncomingMessage
    stream.method = 'POST'
    stream.url = '/api/session-dispatch'
    stream.headers = { host: '127.0.0.1:3080' }
    stream.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']
    const captured = await run(handler, stream)
    expect(captured.status).toBe(400)
    void req
  })

  it('rejects non-POST methods with 405', async () => {
    const handler = makeDispatchRoutes(happyServices())[0].handler!
    const captured = await run(handler, fakeReq('GET', undefined))
    expect(captured.status).toBe(405)
  })

  it('rejects non-loopback callers with 403', async () => {
    const handler = makeDispatchRoutes(happyServices())[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x' }, { loopback: false }))
    expect(captured.status).toBe(403)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('loopback') })
  })

  it('surfaces a session-controller rejection with its mapped status', async () => {
    const services = happyServices({
      sessions: {
        async create() { const error = new Error('workspace "ws-1" not found') as Error & { code: string }; error.code = 'workspace/not-found'; throw error },
        async rename() { return {} },
        async prompt() { return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x' }))
    expect(captured.status).toBe(404)
    expect(captured.body).toMatchObject({ ok: false })
  })
})

describe('health route', () => {
  it('answers 200 for loopback GET and 403 otherwise', async () => {
    const handler = makeHealthRoute().handler!
    const ok = await run(handler, fakeReq('GET', undefined, { url: '/api/session-dispatch/health' }))
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ ok: true, service: 'dsh-session-dispatch' })
    const denied = await run(handler, fakeReq('GET', undefined, { url: '/api/session-dispatch/health', loopback: false }))
    expect(denied.status).toBe(403)
  })

  it('rejects non-GET methods with 405', async () => {
    const handler = makeHealthRoute().handler!
    const captured = await run(handler, fakeReq('POST', undefined, { url: '/api/session-dispatch/health' }))
    expect(captured.status).toBe(405)
  })
})

/** In-memory binding store double: records every record() call for assertions. */
function fakeBindings(overrides: Partial<DispatchBindingStore> = {}): DispatchBindingStore & { recorded: DispatchBinding[] } {
  const recorded: DispatchBinding[] = []
  return {
    recorded,
    async findAlive() { return undefined },
    async record(binding) { recorded.push(binding) },
    async list() { return recorded.map((binding) => ({ ...binding, alive: true })) },
    ...overrides,
  }
}

describe('dispatch route taskRef bindings', () => {
  it('records a binding with taskRef, sessionId, workspaceId, title, and createdAt', async () => {
    const bindings = fakeBindings()
    const services = happyServices({ bindings })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', {
      workspaceId: 'ws-1',
      prompt: 'do it',
      title: 'Batch item',
      taskRef: 'content/tasks/todo-series.md#L144',
    }))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, sessionId: 'session-abc' })
    expect(bindings.recorded).toHaveLength(1)
    const binding = bindings.recorded[0]!
    expect(binding.taskRef).toBe('content/tasks/todo-series.md#L144')
    expect(binding.sessionId).toBe('session-abc')
    expect(binding.workspaceId).toBe('ws-1')
    expect(binding.title).toBe('Batch item')
    expect(Number.isFinite(Date.parse(binding.createdAt))).toBe(true)
  })

  it('answers 409 with the existing sessionId when the taskRef still has a live session', async () => {
    const existing: DispatchBinding = {
      taskRef: 'board.md#item-1',
      sessionId: 'session-live',
      workspaceId: 'ws-1',
      createdAt: '2026-10-19T00:00:00.000Z',
    }
    let created = false
    const bindings = fakeBindings({ async findAlive() { return existing } })
    const services = happyServices({
      bindings,
      sessions: {
        async create() { created = true; return { sessionId: 's' } },
        async rename() { return {} },
        async prompt() { return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x', taskRef: 'board.md#item-1' }))
    expect(captured.status).toBe(409)
    expect(captured.body).toMatchObject({ ok: false, taskRef: 'board.md#item-1', sessionId: 'session-live' })
    expect(created).toBe(false)
    expect(bindings.recorded).toHaveLength(0)
  })

  it('re-dispatches when the previous binding is dead (findAlive answers undefined)', async () => {
    const bindings = fakeBindings()
    const services = happyServices({ bindings })
    const handler = makeDispatchRoutes(services)[0].handler!
    const first = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x', taskRef: 'board.md#item-1' }))
    expect(first.status).toBe(200)
    const second = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x', taskRef: 'board.md#item-1' }))
    expect(second.status).toBe(200)
    expect(bindings.recorded).toHaveLength(2)
  })

  it('dispatches without taskRef exactly as before, recording nothing', async () => {
    const bindings = fakeBindings()
    const services = happyServices({ bindings })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'do it', title: 'Dispatch test' }))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, sessionId: 'session-abc' })
    expect(bindings.recorded).toHaveLength(0)
  })

  it('fails the 409 gate open when the binding store throws, still dispatching', async () => {
    const bindings = fakeBindings({
      async findAlive() { throw new Error('store on fire') },
    })
    const services = happyServices({ bindings })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x', taskRef: 'board.md#item-1' }))
    expect(captured.status).toBe(200)
  })

  it('still dispatches a taskRef when no binding store is composed', async () => {
    const services = happyServices()
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x', taskRef: 'board.md#item-1' }))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, sessionId: 'session-abc' })
  })

  it('reports a binding write failure without failing the dispatch', async () => {
    const bindings = fakeBindings({
      async record() { throw new Error('disk full') },
    })
    const services = happyServices({ bindings })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'x', taskRef: 'board.md#item-1' }))
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({ ok: true, sessionId: 'session-abc', bindingRecorded: false })
  })
})

describe('bindings route', () => {
  it('serves the ledger with live aliveness, loopback-fenced and GET-only', async () => {
    const bindings = fakeBindings({
      async list() {
        return [
          { taskRef: 'a#1', sessionId: 'session-alive', workspaceId: 'ws-1', createdAt: '2026-10-19T01:00:00.000Z', alive: true },
          { taskRef: 'a#2', sessionId: 'session-dead', workspaceId: 'ws-1', createdAt: '2026-10-19T02:00:00.000Z', alive: false },
        ]
      },
    })
    const handler = makeBindingsRoute(bindings).handler!
    const captured = await run(handler, fakeReq('GET', undefined, { url: '/api/session-dispatch/bindings' }))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({
      ok: true,
      bindings: [
        { taskRef: 'a#1', sessionId: 'session-alive', workspaceId: 'ws-1', createdAt: '2026-10-19T01:00:00.000Z', alive: true },
        { taskRef: 'a#2', sessionId: 'session-dead', workspaceId: 'ws-1', createdAt: '2026-10-19T02:00:00.000Z', alive: false },
      ],
    })
    const denied = await run(handler, fakeReq('GET', undefined, { url: '/api/session-dispatch/bindings', loopback: false }))
    expect(denied.status).toBe(403)
    const wrongMethod = await run(handler, fakeReq('POST', undefined, { url: '/api/session-dispatch/bindings' }))
    expect(wrongMethod.status).toBe(405)
  })

  it('answers 500 when the store list fails', async () => {
    const bindings = fakeBindings({ async list() { throw new Error('corrupt ledger') } })
    const handler = makeBindingsRoute(bindings).handler!
    const captured = await run(handler, fakeReq('GET', undefined, { url: '/api/session-dispatch/bindings' }))
    expect(captured.status).toBe(500)
    expect(captured.body).toMatchObject({ ok: false })
  })

  it('is registered by makeDispatchRoutes only when a store is composed', () => {
    expect(makeDispatchRoutes(happyServices())).toHaveLength(2)
    expect(makeDispatchRoutes(happyServices({ bindings: fakeBindings() }))).toHaveLength(3)
  })
})
