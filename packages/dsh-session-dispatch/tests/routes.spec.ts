import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { DispatchFsmSeam } from '../src/host/fsm-seam.ts'
import {
  makeDispatchRoutes,
  makeHealthRoute,
  makeBindingsRoute,
  makeSessionSendRoute,
  makeSessionStopRoute,
  parseDispatchBody,
  parseSessionSendBody,
  parseSessionStopBody,
  SESSION_SEND_API_PREFIX,
  SESSION_STOP_API_PREFIX,
  type DispatchBinding,
  type DispatchBindingStore,
  type DispatchServices,
  type SessionSendServices,
  type SessionStopServices,
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
      async cancel() { return { accepted: true } },
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
        async cancel() { return { accepted: true } },
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
        async cancel() { return { accepted: true } },
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
        async cancel() { return { accepted: true } },
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
        async cancel() { return { accepted: true } },
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
        async cancel() { return { accepted: true } },
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
        async cancel() { return { accepted: true } },
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

/** A task book carrying a G1 worktree 预案 (planSeam → run, so the gate runs). */
const PLAN_PROMPT = '# 任务书\n\nworktree 预案 = 开 .wt/gate-fixture 后动手\n正文'

const GATE_REF = 'board.md#item-1'

/**
 * FSM seam double for 闸① (fsm-rebind-1126): serves GET state from one
 * optional record and answers create/transition 200 (the gate verdict is the
 * unit under test; the create/E1 flow has its own real-server spec).
 */
function fakeFsm(record?: { state: string; session?: { id: string } }): DispatchFsmSeam {
  return {
    async get() {
      const tasks = record === undefined ? {} : { [GATE_REF]: record }
      return { status: 200, json: { ok: true, file: { version: 1, scopes: {}, tasks } } }
    },
    async post() {
      return { status: 200, json: { ok: true } }
    },
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

  it('operator gets 409 with the existing sessionId when the FSM record holds a live session', async () => {
    // Given an FSM record for the taskRef in active state with a bound session
    const fsm = fakeFsm({ state: 'active', session: { id: 'session-live' } })
    let created = false
    const services = happyServices({
      fsm,
      sessions: {
        async create() { created = true; return { sessionId: 's' } },
        async rename() { return {} },
        async prompt() { return { accepted: true } },
        async cancel() { return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    // When the operator dispatches that taskRef (a plan-bearing task book)
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: PLAN_PROMPT, taskRef: GATE_REF }))
    // Then it answers 409 with the unchanged body shape and mints no session
    expect(captured.status).toBe(409)
    expect(captured.body).toMatchObject({ ok: false, taskRef: GATE_REF, sessionId: 'session-live' })
    expect(String((captured.body as { error: string }).error)).toBe('taskRef already has a live session: session-live')
    expect(created).toBe(false)
  })

  it('operator re-dispatches on absent and terminal FSM records (清态放行)', async () => {
    // Given an FSM seam with no record, then one holding a terminal record
    // When the operator dispatches the taskRef against each
    const services = happyServices({ fsm: fakeFsm() })
    const handler = makeDispatchRoutes(services)[0].handler!
    const absent = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: PLAN_PROMPT, taskRef: GATE_REF }))
    const terminalServices = happyServices({ fsm: fakeFsm({ state: 'done', session: { id: 'session-dead' } }) })
    const terminalHandler = makeDispatchRoutes(terminalServices)[0].handler!
    const terminal = await run(terminalHandler, fakeReq('POST', { workspaceId: 'ws-1', prompt: PLAN_PROMPT, taskRef: GATE_REF }))
    // Then the gate clears both (no live session) and both dispatch
    expect(absent.status).toBe(200)
    expect(absent.body).toEqual({ ok: true, sessionId: 'session-abc' })
    expect(terminal.status).toBe(200)
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

  it('operator is refused 503 when the FSM state read fails (fail-closed, 原快账 fail-open 反转)', async () => {
    // Given an FSM seam whose GET state cannot be answered (fetch failed = status 0)
    const fsm: DispatchFsmSeam = {
      async get() { return { status: 0, json: { error: 'fetch failed' } } },
      async post() { return { status: 200, json: { ok: true } } },
    }
    const services = happyServices({ fsm })
    const handler = makeDispatchRoutes(services)[0].handler!
    // When the operator dispatches the taskRef
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: PLAN_PROMPT, taskRef: GATE_REF }))
    // Then it refuses 503 with the fail-closed wording instead of dispatching
    expect(captured.status).toBe(503)
    expect(String((captured.body as { error: string }).error)).toContain('fail-closed')
    expect(captured.body).toMatchObject({ ok: false, taskRef: GATE_REF })
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

describe('dispatch gate serialization', () => {
  it('operator sees exactly one of two concurrent same-taskRef dispatches pass; the loser answers 409 with the winner sessionId', async () => {
    // Given a stateful FSM seam that turns live only when the winner's E1 lands
    const state: { record?: { state: string; session?: { id: string } } } = {}
    const fsm: DispatchFsmSeam = {
      async get() {
        const tasks = state.record === undefined ? {} : { [GATE_REF]: state.record }
        return { status: 200, json: { ok: true, file: { version: 1, scopes: {}, tasks } } }
      },
      async post(_origin, path, body) {
        if (path === 'create') {
          if (state.record !== undefined) return { status: 409, json: { ok: false, error: 'task already exists' } }
          state.record = { state: 'backlog' }
          return { status: 200, json: { ok: true } }
        }
        if (path === 'transition') {
          const payload = body as { payload?: { sessionId?: string } }
          state.record = { state: 'active', session: { id: payload.payload?.sessionId ?? '' } }
          return { status: 200, json: { ok: true } }
        }
        return { status: 200, json: { ok: true } }
      },
    }
    let created = 0
    const services = happyServices({
      fsm,
      sessions: {
        async create() {
          // Widen the check-then-act window: without in-process serialization
          // both requests clear the gate before either one's E1 lands.
          await new Promise((resolve) => setTimeout(resolve, 10))
          created += 1
          return { sessionId: `session-${created}` }
        },
        async rename() { return {} },
        async prompt() { return { accepted: true } },
        async cancel() { return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const body = { workspaceId: 'ws-1', prompt: PLAN_PROMPT, taskRef: GATE_REF }
    const [first, second] = await Promise.all([
      run(handler, fakeReq('POST', body)),
      run(handler, fakeReq('POST', body)),
    ])
    // Then exactly one passes; the loser's queued FSM read observes the winner's E1 and answers 409
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409])
    const winner = first.status === 200 ? first : second
    const loser = first.status === 200 ? second : first
    const winnerId = (winner.body as { sessionId: string }).sessionId
    expect(winner.body).toMatchObject({ ok: true, sessionId: expect.stringMatching(/^session-/) })
    expect(loser.body).toMatchObject({ ok: false, taskRef: GATE_REF, sessionId: winnerId })
    expect(created).toBe(1)
    expect(state.record?.session?.id).toBe(winnerId)
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

/** Send-services double: captures every prompt request for queue-semantics assertions. */
function fakeSendServices(): SessionSendServices & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = []
  return {
    requests,
    sessions: {
      async prompt(request) {
        requests.push(request as unknown as Record<string, unknown>)
        return { accepted: true }
      },
    },
  }
}

function sendReq(body: unknown, opts: { loopback?: boolean; url?: string } = {}): IncomingMessage {
  return fakeReq('POST', body, { url: SESSION_SEND_API_PREFIX, ...opts })
}

describe('parseSessionSendBody', () => {
  it('accepts a minimal request, trims sessionId, and defaults mode to queue', () => {
    expect(parseSessionSendBody({ sessionId: ' session-1 ', prompt: 'hello' }))
      .toEqual({ ok: true, value: { sessionId: 'session-1', prompt: 'hello', mode: 'queue' } })
  })

  it('rejects a non-object body', () => {
    expect(parseSessionSendBody('nope').ok).toBe(false)
    expect(parseSessionSendBody(null).ok).toBe(false)
    expect(parseSessionSendBody([]).ok).toBe(false)
  })

  it('rejects a missing or blank sessionId', () => {
    expect(parseSessionSendBody({ prompt: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('sessionId') })
    expect(parseSessionSendBody({ sessionId: '  ', prompt: 'x' })).toMatchObject({ ok: false })
  })

  it('rejects a missing or blank prompt', () => {
    expect(parseSessionSendBody({ sessionId: 's' })).toMatchObject({ ok: false, error: expect.stringContaining('prompt') })
    expect(parseSessionSendBody({ sessionId: 's', prompt: '   ' })).toMatchObject({ ok: false })
  })

  it('rejects an oversized prompt', () => {
    expect(parseSessionSendBody({ sessionId: 's', prompt: 'x'.repeat(900_001) }))
      .toMatchObject({ ok: false, error: expect.stringContaining('900000') })
  })

  it('carries an explicit mode through and rejects an unknown one by name', () => {
    expect(parseSessionSendBody({ sessionId: 's', prompt: 'x', mode: 'steer' }))
      .toEqual({ ok: true, value: { sessionId: 's', prompt: 'x', mode: 'steer' } })
    expect(parseSessionSendBody({ sessionId: 's', prompt: 'x', mode: 'queue' }))
      .toEqual({ ok: true, value: { sessionId: 's', prompt: 'x', mode: 'queue' } })
    expect(parseSessionSendBody({ sessionId: 's', prompt: 'x', mode: 'whatever' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('mode') })
    expect(parseSessionSendBody({ sessionId: 's', prompt: 'x', mode: 7 }))
      .toMatchObject({ ok: false, error: expect.stringContaining('mode') })
  })
})

describe('session-send route', () => {
  it('queues the prompt onto the existing session, answering the sessionId', async () => {
    const captures = fakeSendServices()
    const handler = makeSessionSendRoute(captures).handler!
    const captured = await run(handler, sendReq({ sessionId: 'session-1', prompt: 'look at this' }))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, sessionId: 'session-1' })
    expect(captures.requests).toHaveLength(1)
    const request = captures.requests[0]!
    expect(request.requestId).toMatch(/^session-send-/)
    expect(request.sessionId).toBe('session-1')
    expect(request.mode).toBe('queue')
    expect(request.content).toEqual([{ type: 'text', text: 'look at this' }])
  })

  it('defaults to queue when the wire carries no mode field (pre-mode callers unchanged)', async () => {
    const captures = fakeSendServices()
    const handler = makeSessionSendRoute(captures).handler!
    const captured = await run(handler, sendReq({ sessionId: 's', prompt: 'x' }))
    expect(captured.status).toBe(200)
    expect(captures.requests.map(request => request.mode)).toEqual(['queue'])
  })

  it('passes an explicit steer mode through to the prompt call', async () => {
    const captures = fakeSendServices()
    const handler = makeSessionSendRoute(captures).handler!
    const captured = await run(handler, sendReq({ sessionId: 's', prompt: 'x', mode: 'steer' }))
    expect(captured.status).toBe(200)
    expect(captures.requests.map(request => request.mode)).toEqual(['steer'])
  })

  it('rejects an unknown mode with 400 before touching the session service', async () => {
    const captures = fakeSendServices()
    const handler = makeSessionSendRoute(captures).handler!
    const captured = await run(handler, sendReq({ sessionId: 's', prompt: 'x', mode: 'yolo' }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('mode') })
    expect(captures.requests).toHaveLength(0)
  })

  it('never creates a session: the services surface exposes no create path', async () => {
    const captures = fakeSendServices()
    const handler = makeSessionSendRoute(captures).handler!
    await run(handler, sendReq({ sessionId: 'session-1', prompt: 'x' }))
    expect(Object.keys(captures.sessions)).toEqual(['prompt'])
  })

  it('rejects a non-object body with 400', async () => {
    const handler = makeSessionSendRoute(fakeSendServices()).handler!
    const captured = await run(handler, sendReq('nope'))
    expect(captured.status).toBe(400)
  })

  it('rejects a missing sessionId with 400 before touching the session service', async () => {
    const captures = fakeSendServices()
    const handler = makeSessionSendRoute(captures).handler!
    const captured = await run(handler, sendReq({ prompt: 'x' }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('sessionId') })
    expect(captures.requests).toHaveLength(0)
  })

  it('rejects a blank prompt with 400', async () => {
    const handler = makeSessionSendRoute(fakeSendServices()).handler!
    const captured = await run(handler, sendReq({ sessionId: 's', prompt: '  ' }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('prompt') })
  })

  it('rejects an oversized prompt with 400', async () => {
    const handler = makeSessionSendRoute(fakeSendServices()).handler!
    const captured = await run(handler, sendReq({ sessionId: 's', prompt: 'x'.repeat(900_001) }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('900000') })
  })

  it('rejects invalid JSON with 400', async () => {
    const handler = makeSessionSendRoute(fakeSendServices()).handler!
    const stream = Readable.from([Buffer.from('{not json')]) as IncomingMessage
    stream.method = 'POST'
    stream.url = SESSION_SEND_API_PREFIX
    stream.headers = { host: '127.0.0.1:3080' }
    stream.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']
    const captured = await run(handler, stream)
    expect(captured.status).toBe(400)
  })

  it('rejects non-POST methods with 405', async () => {
    const handler = makeSessionSendRoute(fakeSendServices()).handler!
    const stream = fakeReq('GET', undefined, { url: SESSION_SEND_API_PREFIX })
    const captured = await run(handler, stream)
    expect(captured.status).toBe(405)
  })

  it('rejects non-loopback callers with 403', async () => {
    const handler = makeSessionSendRoute(fakeSendServices()).handler!
    const captured = await run(handler, sendReq({ sessionId: 's', prompt: 'x' }, { loopback: false }))
    expect(captured.status).toBe(403)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('loopback') })
  })

  it('maps a session/not-found rejection to 400 with the Host error text', async () => {
    const services: SessionSendServices = {
      sessions: {
        async prompt() {
          const error = new Error('session "gone" is not available') as Error & { code: string }
          error.code = 'session/not-found'
          throw error
        },
      },
    }
    const handler = makeSessionSendRoute(services).handler!
    const captured = await run(handler, sendReq({ sessionId: 'gone', prompt: 'x' }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('session "gone" is not available') })
  })

  it('maps an unmapped Host rejection to 500', async () => {
    const services: SessionSendServices = {
      sessions: {
        async prompt() {
          const error = new Error('disk exploded') as Error & { code: string }
          error.code = 'gateway/internal'
          throw error
        },
      },
    }
    const handler = makeSessionSendRoute(services).handler!
    const captured = await run(handler, sendReq({ sessionId: 's', prompt: 'x' }))
    expect(captured.status).toBe(500)
  })
})

function stopReq(body: unknown, opts: { loopback?: boolean; url?: string } = {}): IncomingMessage {
  return fakeReq('POST', body, { url: SESSION_STOP_API_PREFIX, ...opts })
}

/** Stop-services double: records every cancel request for actor-isolation assertions. */
function fakeStopServices(): SessionStopServices & { requests: { sessionId: string }[] } {
  const requests: { sessionId: string }[] = []
  return {
    requests,
    sessions: {
      cancel(request) {
        requests.push(request)
        return { accepted: true }
      },
    },
  }
}

describe('parseSessionStopBody', () => {
  it('accepts a minimal request and trims sessionId', () => {
    expect(parseSessionStopBody({ sessionId: ' session-1 ' }))
      .toEqual({ ok: true, value: { sessionId: 'session-1' } })
  })

  it('carries an optional actor through', () => {
    expect(parseSessionStopBody({ sessionId: 's', actor: 'successor' }))
      .toEqual({ ok: true, value: { sessionId: 's', actor: 'successor' } })
  })

  it('rejects a non-object body', () => {
    expect(parseSessionStopBody('nope').ok).toBe(false)
    expect(parseSessionStopBody(null).ok).toBe(false)
    expect(parseSessionStopBody([]).ok).toBe(false)
  })

  it('rejects a missing or blank sessionId', () => {
    expect(parseSessionStopBody({})).toMatchObject({ ok: false, error: expect.stringContaining('sessionId') })
    expect(parseSessionStopBody({ sessionId: '  ' })).toMatchObject({ ok: false })
  })

  it('rejects a non-string actor', () => {
    expect(parseSessionStopBody({ sessionId: 's', actor: 42 })).toMatchObject({ ok: false, error: expect.stringContaining('actor') })
  })
})

describe('session-stop route', () => {
  it('cancels the active turn and answers accepted, without letting actor steer', async () => {
    const captures = fakeStopServices()
    const handler = makeSessionStopRoute(captures).handler!
    const captured = await run(handler, stopReq({ sessionId: 'session-1', actor: 'successor' }))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, accepted: true })
    // The cancel call carries the target only: actor never reaches it.
    expect(captures.requests).toEqual([{ sessionId: 'session-1' }])
  })

  it('logs one structured audit line with actor and target', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const handler = makeSessionStopRoute(fakeStopServices()).handler!
      const captured = await run(handler, stopReq({ sessionId: 'session-1', actor: 'successor' }))
      expect(captured.status).toBe(200)
      expect(spy).toHaveBeenCalledWith('[session-stop] actor=successor target=session-1')
    } finally {
      spy.mockRestore()
    }
  })

  it('logs a dash placeholder when the actor is absent', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const handler = makeSessionStopRoute(fakeStopServices()).handler!
      await run(handler, stopReq({ sessionId: 'session-1' }))
      expect(spy).toHaveBeenCalledWith('[session-stop] actor=- target=session-1')
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects a missing sessionId with 400 before touching cancel', async () => {
    const captures = fakeStopServices()
    const handler = makeSessionStopRoute(captures).handler!
    const captured = await run(handler, stopReq({ actor: 'x' }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('sessionId') })
    expect(captures.requests).toHaveLength(0)
  })

  it('rejects a non-string actor with 400 before touching cancel', async () => {
    const captures = fakeStopServices()
    const handler = makeSessionStopRoute(captures).handler!
    const captured = await run(handler, stopReq({ sessionId: 's', actor: 42 }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('actor') })
    expect(captures.requests).toHaveLength(0)
  })

  it('rejects invalid JSON with 400', async () => {
    const handler = makeSessionStopRoute(fakeStopServices()).handler!
    const stream = Readable.from([Buffer.from('{not json')]) as IncomingMessage
    stream.method = 'POST'
    stream.url = SESSION_STOP_API_PREFIX
    stream.headers = { host: '127.0.0.1:3080' }
    stream.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']
    const captured = await run(handler, stream)
    expect(captured.status).toBe(400)
  })

  it('rejects non-POST methods with 405', async () => {
    const handler = makeSessionStopRoute(fakeStopServices()).handler!
    const captured = await run(handler, fakeReq('GET', undefined, { url: SESSION_STOP_API_PREFIX }))
    expect(captured.status).toBe(405)
  })

  it('rejects non-loopback callers with 403', async () => {
    const captures = fakeStopServices()
    const handler = makeSessionStopRoute(captures).handler!
    const captured = await run(handler, stopReq({ sessionId: 's' }, { loopback: false }))
    expect(captured.status).toBe(403)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('loopback') })
    expect(captures.requests).toHaveLength(0)
  })

  it('passes a session/not-found rejection through as 4xx with the Host error text', async () => {
    const services: SessionStopServices = {
      sessions: {
        cancel() {
          const error = new Error('session "gone" not found (not attached)') as Error & { code: string }
          error.code = 'session/not-found'
          throw error
        },
      },
    }
    const handler = makeSessionStopRoute(services).handler!
    const captured = await run(handler, stopReq({ sessionId: 'gone' }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('session "gone" not found (not attached)') })
  })

  it('passes the subagent ownership refusal through as 4xx', async () => {
    const services: SessionStopServices = {
      sessions: {
        cancel() {
          const error = new Error('session "child" is owned by subagent routing') as Error & { code: string }
          error.code = 'session/agent-busy'
          throw error
        },
      },
    }
    const handler = makeSessionStopRoute(services).handler!
    const captured = await run(handler, stopReq({ sessionId: 'child' }))
    expect(captured.status).toBe(400)
    expect(captured.body).toMatchObject({ ok: false, error: expect.stringContaining('owned by subagent routing') })
  })

  it('maps an unmapped Host rejection to 500', async () => {
    const services: SessionStopServices = {
      sessions: {
        cancel() {
          const error = new Error('disk exploded') as Error & { code: string }
          error.code = 'gateway/internal'
          throw error
        },
      },
    }
    const handler = makeSessionStopRoute(services).handler!
    const captured = await run(handler, stopReq({ sessionId: 's' }))
    expect(captured.status).toBe(500)
  })
})

describe('dispatch sessionClass (attention ledger)', () => {
  it('accepts the three classes plus the legacy bot alias, rejects anything else', () => {
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', sessionClass: 'human' }))
      .toEqual({ ok: true, value: { workspaceId: 'ws-1', prompt: 'x', sessionClass: 'human' } })
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', sessionClass: 'bot-boss' }))
      .toEqual({ ok: true, value: { workspaceId: 'ws-1', prompt: 'x', sessionClass: 'bot-boss' } })
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', sessionClass: 'bot-worker' }))
      .toEqual({ ok: true, value: { workspaceId: 'ws-1', prompt: 'x', sessionClass: 'bot-worker' } })
    // Legacy wire `bot` (pre-triclass callers) normalizes to bot-worker.
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', sessionClass: 'bot' }))
      .toEqual({ ok: true, value: { workspaceId: 'ws-1', prompt: 'x', sessionClass: 'bot-worker' } })
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', sessionClass: 'ai' }))
      .toMatchObject({ ok: false, error: 'sessionClass must be one of human | bot-boss | bot-worker' })
    expect(parseDispatchBody({ workspaceId: 'ws-1', prompt: 'x', sessionClass: 1 }))
      .toMatchObject({ ok: false, error: 'sessionClass must be one of human | bot-boss | bot-worker' })
  })

  it('declares the wire default human when the field is absent', async () => {
    const declared: [string, string][] = []
    const services = happyServices({
      attention: {
        async declare(sessionId, sessionClass) { declared.push([sessionId, sessionClass]) },
        async classes() { return {} },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'do it' }))
    expect(captured.status).toBe(200)
    expect(declared).toEqual([['session-abc', 'human']])
    // Success shape stays clean: no attention fields when nothing failed.
    expect(captured.body).toEqual({ ok: true, sessionId: 'session-abc' })
  })

  it('declares a legacy bot dispatch as bot-worker, before the prompt is queued', async () => {
    const order: string[] = []
    const services = happyServices({
      attention: {
        async declare(_sessionId, sessionClass) { order.push(`declare:${sessionClass}`) },
        async classes() { return {} },
      },
      sessions: {
        async create() { order.push('create'); return { sessionId: 'session-abc' } },
        async rename() { return {} },
        async prompt() { order.push('prompt'); return { accepted: true } },
        async cancel() { return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'do it', sessionClass: 'bot' }))
    expect(captured.status).toBe(200)
    expect(order).toEqual(['create', 'declare:bot-worker', 'prompt'])
  })

  it('declares a bot-boss dispatch as bot-boss, before the prompt is queued', async () => {
    const order: string[] = []
    const services = happyServices({
      attention: {
        async declare(_sessionId, sessionClass) { order.push(`declare:${sessionClass}`) },
        async classes() { return {} },
      },
      sessions: {
        async create() { order.push('create'); return { sessionId: 'session-abc' } },
        async rename() { return {} },
        async prompt() { order.push('prompt'); return { accepted: true } },
        async cancel() { return { accepted: true } },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'do it', sessionClass: 'bot-boss' }))
    expect(captured.status).toBe(200)
    expect(order).toEqual(['create', 'declare:bot-boss', 'prompt'])
  })

  it('reports a ledger failure as attentionRecorded:false without failing the dispatch', async () => {
    const services = happyServices({
      attention: {
        async declare() { throw new Error('ledger disk full') },
        async classes() { return {} },
      },
    })
    const handler = makeDispatchRoutes(services)[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'do it' }))
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({
      ok: true,
      sessionId: 'session-abc',
      attentionRecorded: false,
      attentionError: expect.stringContaining('ledger disk full'),
    })
  })

  it('touches no attention service when the profile mounts none', async () => {
    const handler = makeDispatchRoutes(happyServices())[0].handler!
    const captured = await run(handler, fakeReq('POST', { workspaceId: 'ws-1', prompt: 'do it' }))
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, sessionId: 'session-abc' })
  })
})
