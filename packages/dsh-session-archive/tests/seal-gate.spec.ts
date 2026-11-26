// @vitest-environment node
/**
 * The archive gate over HTTP (contract C2) and the shared `seal-check`
 * endpoint (contract C1), on the four-tuple structured recomputation
 * (lamp-wiring-1126, §8.4): four-dimension green passes untouched, a red
 * dimension and an unreadable one are refused per id with their grouping
 * (no batch contagion), `force` needs a real reason or the whole request is
 * a 400 — and none of it ever reads a transcript (the fixtures carry no
 * transcript at all: the old text read would answer UNKNOWN here).
 *
 * The stale/sentinel tiers of the transcript layer are gone with the text
 * source; their receipt/remedy behaviour lives in archive-verdict.spec.
 * @module tests/seal-gate.spec
 */

import { afterAll, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { makeArchiveRoutes } from '../src/host/routes.ts'
import { ArchiveService } from '../src/host/janitor.ts'
import { createFakeHost, fakeContext, fixtureSources, type FakeHost } from './fixtures.ts'

function startServer(routes: WebRoute[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = routes.find((candidate) => candidate.kind === 'exact' && candidate.path === url.pathname)
      if (route === undefined) {
        res.writeHead(404).end()
        return
      }
      void route.handler(req, res)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })
}

const servers: Server[] = []
afterAll(() => {
  for (const server of servers) server.close()
})

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url + path, { method: 'POST', body: JSON.stringify(body), headers })
  return { status: response.status, body: await response.json().catch(() => undefined) }
}

const GREEN_REF = 'content/tech/ai/dsh/tasks.md#gate-green'
const RED_REF = 'content/tech/ai/dsh/tasks.md#gate-red'

const SRC_BINDINGS = 'GET /api/session-dispatch/bindings'
const SRC_FSM = 'GET /api/task-fsm/state'
const SRC_SAVE = 'scripts/git/save-status.py (repos= cell)'
const SRC_DEBT = 'scripts/dsh/debt-scan.py --json'

const GREEN_READINGS = {
  contract: { state: 'pass', source: SRC_BINDINGS, note: 'alive-binding' },
  e8: { state: 'pass', source: SRC_FSM, note: 'e8-done' },
  pushed: { state: 'pass', source: SRC_SAVE, note: 'reached-push-lines' },
  debt: { state: 'pass', source: SRC_DEBT, note: 'no-debt-markers' },
}

/**
 * One host per seal shape: green (all four dims pass), red (task not E8-done),
 * unknown (bindings unreadable). Deliberately transcript-free — the verdict
 * must come from the structured sources alone.
 */
function gateHost(): FakeHost {
  const ids = ['session-green', 'session-red', 'session-unknown']
  return createFakeHost({
    feedItems: ids.map((sessionId) => ({ sessionId, updatedAt: 1 })),
    persistedIds: ids,
  })
}

function gateSources(): ReturnType<typeof fixtureSources> {
  return fixtureSources({
    bindings: {
      'session-green': { taskRef: GREEN_REF, workspaceId: 'ws-fixture' },
      'session-red': { taskRef: RED_REF, workspaceId: 'ws-fixture' },
      'session-unknown': null,
    },
    fsm: {
      [GREEN_REF]: { state: 'done', history: [{ event: 'E8' }] },
      [RED_REF]: { state: 'active', history: [] },
    },
  })
}

function gateService(host: FakeHost): ArchiveService {
  return new ArchiveService(fakeContext(host) as never, { dshHome: host.home, verdictSources: gateSources() })
}

describe('POST /seal-check (contract C1) — four-tuple rows', () => {
  it('serves the shared grouping with per-dimension readings on every row', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/seal-check', {
      ids: ['session-green', 'session-red', 'session-unknown'],
    })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([
      { id: 'session-green', verdict: 'DONE', detail: '4t-pass', readings: GREEN_READINGS },
      {
        id: 'session-red',
        verdict: 'UNSEALED',
        detail: '4t-red-e8',
        readings: {
          contract: { state: 'pass', source: SRC_BINDINGS, note: 'alive-binding' },
          e8: { state: 'fail', source: SRC_FSM, note: 'task-not-done' },
          pushed: { state: 'pass', source: SRC_SAVE, note: 'reached-push-lines' },
          debt: { state: 'pass', source: SRC_DEBT, note: 'no-debt-markers' },
        },
      },
      {
        id: 'session-unknown',
        verdict: 'UNKNOWN',
        detail: '4t-unreadable-contract',
        readings: {
          contract: { state: 'unreadable', source: SRC_BINDINGS, note: 'bindings-unreadable' },
          e8: { state: 'unreadable', source: SRC_FSM, note: 'no-taskref' },
          pushed: { state: 'unreadable', source: SRC_SAVE, note: 'no-taskref' },
          debt: { state: 'unreadable', source: SRC_DEBT, note: 'no-root' },
        },
      },
    ])
  })

  it('answers an unresolvable id with the fail-closed session-not-found row', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/seal-check', { ids: ['session-ghost'] })
    expect(response.status).toBe(200)
    expect(response.body.results[0]).toEqual({
      id: 'session-ghost',
      verdict: 'UNKNOWN',
      detail: 'session-not-found',
      readings: {
        contract: { state: 'unreadable', source: 'session lookup', note: 'session-not-found:session-ghost' },
        e8: { state: 'unreadable', source: SRC_FSM, note: 'not-computed' },
        pushed: { state: 'unreadable', source: SRC_SAVE, note: 'not-computed' },
        debt: { state: 'unreadable', source: SRC_DEBT, note: 'not-computed' },
      },
    })
  })

  it('accepts GET ?ids= as the preflight scanner shape and refuses empty id lists', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const ok = await fetch(`${url}/api/dsh-session-archive/seal-check?ids=session-green,session-red`)
    expect(ok.status).toBe(200)
    expect((await ok.json()).results).toHaveLength(2)
    const empty = await post(url, '/api/dsh-session-archive/seal-check', { ids: [] })
    expect(empty.status).toBe(400)
  })

  it('carries the same loopback fence as every other route', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const crossSite = await fetch(`${url}/api/dsh-session-archive/seal-check`, {
      method: 'POST',
      body: JSON.stringify({ ids: ['session-green'] }),
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.status).toBe(403)
    const overrideCross = await fetch(`${url}/api/dsh-session-archive/archive-override`, {
      method: 'POST',
      body: JSON.stringify({ ids: ['session-green'], mode: 'note' }),
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(overrideCross.status).toBe(403)
  })
})

describe('POST /archive — gate path 1: four-tuple green passes', () => {
  it('archives a DONE session: source manual, no seal field — without any transcript to read', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive', { ids: ['session-green'], actor: 'manual' })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([{ id: 'session-green', status: 'ok' }])
    expect(host.registry.archivedSessionIds).toEqual(['session-green'])
    expect(service.ledgerSnapshot().entries['session-green']).toEqual(expect.objectContaining({ source: 'manual' }))
    expect(service.ledgerSnapshot().entries['session-green']?.seal).toBeUndefined()
  })
})

describe('POST /archive — gate path 2: red and UNKNOWN refused per id', () => {
  it('skips each non-green id with seal-required + its grouping while green still archives (批内不连坐)', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive', {
      ids: ['session-green', 'session-red', 'session-unknown'],
      actor: 'manual',
    })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([
      { id: 'session-green', status: 'ok' },
      { id: 'session-red', status: 'skipped', reason: 'seal-required', seal: { verdict: 'UNSEALED', detail: '4t-red-e8', remedy: expect.stringContaining('验收未过') } },
      { id: 'session-unknown', status: 'skipped', reason: 'seal-required', seal: { verdict: 'UNKNOWN', detail: '4t-unreadable-contract' } },
    ])
    // Green archived; the refused ids wrote nothing.
    expect(host.registry.archivedSessionIds).toEqual(['session-green'])
    expect(service.ledgerSnapshot().entries['session-red']).toBeUndefined()
    expect(service.ledgerSnapshot().entries['session-unknown']).toBeUndefined()
  })
})

describe('POST /archive — gate path 3: force with a real reason', () => {
  it('force + non-empty reason passes a red id and records override with the judgement it overrode', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive', {
      ids: ['session-red'],
      actor: 'manual',
      force: true,
      reason: '板行[x] git 收口证据，任务书授权强归',
    })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([{ id: 'session-red', status: 'ok' }])
    expect(service.ledgerSnapshot().entries['session-red']).toEqual({
      archivedAt: expect.any(Number),
      source: 'override',
      reason: '板行[x] git 收口证据，任务书授权强归',
      seal: 'UNSEALED:4t-red-e8',
      actor: 'manual',
    })
  })

  it('a forced batch records every entry as override with its per-id judgement (全批 override)', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive', {
      ids: ['session-green', 'session-red', 'session-unknown'],
      actor: 'manual',
      force: true,
      reason: 'taskbot:taskRef=板行#anchor 板行[x] 受命收口',
    })
    expect(response.status).toBe(200)
    expect(response.body.results.map((row: { status: string }) => row.status)).toEqual(['ok', 'ok', 'ok'])
    const entries = service.ledgerSnapshot().entries
    expect(entries['session-green']).toEqual(expect.objectContaining({ source: 'override', reason: 'taskbot:taskRef=板行#anchor 板行[x] 受命收口', seal: 'DONE:4t-pass' }))
    expect(entries['session-red']).toEqual(expect.objectContaining({ source: 'override', seal: 'UNSEALED:4t-red-e8' }))
    expect(entries['session-unknown']).toEqual(expect.objectContaining({ source: 'override', seal: 'UNKNOWN:4t-unreadable-contract' }))
  })

  it('force without a reason refuses the whole request with 400 and archives nothing', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const missing = await post(url, '/api/dsh-session-archive/archive', { ids: ['session-red'], force: true })
    expect(missing.status).toBe(400)
    const blank = await post(url, '/api/dsh-session-archive/archive', { ids: ['session-red'], force: true, reason: '   ' })
    expect(blank.status).toBe(400)
    expect(host.registry.archivedSessionIds).toEqual([])
    expect(service.ledgerSnapshot().entries['session-red']).toBeUndefined()
  })

  it('a non-boolean force reads as "no force": the gate still refuses the red id', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive', { ids: ['session-red'], actor: 'manual', force: 'yes', reason: 'not-boolean' })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([
      { id: 'session-red', status: 'skipped', reason: 'seal-required', seal: { verdict: 'UNSEALED', detail: '4t-red-e8', remedy: expect.stringContaining('验收未过') } },
    ])
    expect(host.registry.archivedSessionIds).toEqual([])
  })
})

describe('seal-check recheck wiring (archive-seal-falsered-1116 段2)', () => {
  it('passes the click-time recheck flag through POST body and GET query alike', async () => {
    // Given a real service (the flag rides the wire for compatibility; the
    // four-tuple has no memo stamp to re-probe, so it is ignored downstream)
    const host = gateHost()
    const service = gateService(host)
    const spy = vi.spyOn(service, 'sealCheck')
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)

    // When the click gate asks with recheck
    await post(url, '/api/dsh-session-archive/seal-check', { ids: ['session-green'], recheck: true })
    // Then the flag reaches the shared implementation (点击门重探)
    expect(spy).toHaveBeenLastCalledWith(['session-green'], { recheck: true })

    // A plain ask (the lamp pull's shape) keeps the memo window
    await post(url, '/api/dsh-session-archive/seal-check', { ids: ['session-green'] })
    expect(spy).toHaveBeenLastCalledWith(['session-green'], { recheck: false })

    // GET carries the same flag (diagnostic curl form)
    const ok = await fetch(`${url}/api/dsh-session-archive/seal-check?ids=session-green&recheck=1`)
    expect(ok.status).toBe(200)
    expect(spy).toHaveBeenLastCalledWith(['session-green'], { recheck: true })
  })
})

/** A gate service whose ctx carries the C′ activity seam plus stop-dispatch spies. */
function cGateService(host: FakeHost, activity: readonly { kind: string }[] | Error): {
  service: ArchiveService
  waterfall: ReturnType<typeof vi.fn>
  parallel: ReturnType<typeof vi.fn>
} {
  const waterfall = vi.fn(async () => {
    if (activity instanceof Error) throw activity
    return activity
  })
  const parallel = vi.fn(async () => {})
  const ctx = fakeContext(host) as Record<string, unknown>
  ctx.waterfall = waterfall
  ctx.parallel = parallel
  ctx.logger = { warn: () => {} }
  return { service: new ArchiveService(ctx as never, { dshHome: host.home, verdictSources: gateSources() }), waterfall, parallel }
}

describe("C′ 归档即停轮 at the archive gate (加固A/B, 2026-11-19 裁定)", () => {
  it('a fresh-green four-tuple DONE archive with turn-only activity orders the stop with the write', async () => {
    // Given the all-green session and a turn-only activity waterfall
    const host = gateHost()
    const archiveSpy = vi.spyOn(host.registry, 'archiveSession')
    const { service, waterfall, parallel } = cGateService(host, [{ kind: 'turn' }])
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    // When the operator archives it through the gate
    const response = await post(url, '/api/dsh-session-archive/archive', { ids: ['session-green'], actor: 'manual' })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([{ id: 'session-green', status: 'ok' }])
    // Then 加固B saw the fresh green (DONE → stopTurn) and 加固A confirmed
    // the turn family alone — the registry archives with stopActivity and
    // issues the stop itself, so no second dispatch fires.
    expect(waterfall).toHaveBeenCalledWith('workspace/session-activity', { sessionId: 'session-green' }, expect.any(Function))
    expect(archiveSpy).toHaveBeenCalledWith('session-green', { stopActivity: true })
    expect(parallel).not.toHaveBeenCalled()
    expect(host.registry.archivedSessionIds).toEqual(['session-green'])
  })

  it('a forced archive never orders a stop (the human stop channel stays the native dialog)', async () => {
    // Given the true-red session forced with a real reason
    const host = gateHost()
    const archiveSpy = vi.spyOn(host.registry, 'archiveSession')
    const { service, waterfall, parallel } = cGateService(host, [{ kind: 'turn' }])
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive', {
      ids: ['session-red'],
      actor: 'manual',
      force: true,
      reason: '板行[x] git 收口证据，任务书授权强归',
    })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([{ id: 'session-red', status: 'ok' }])
    // Then force overrides the judgement but not 加固B: stopTurn stays false.
    expect(waterfall).not.toHaveBeenCalled()
    expect(archiveSpy).toHaveBeenCalledWith('session-red')
    expect(parallel).toHaveBeenCalledWith('workspace/session-stop', { sessionId: 'session-red' })
  })

  it('a running job beside the turn degrades the stop-turn archive to the plain path (加固A)', async () => {
    // Given the green session whose activity lists a job next to the turn
    const host = gateHost()
    const archiveSpy = vi.spyOn(host.registry, 'archiveSession')
    const { service, waterfall, parallel } = cGateService(host, [{ kind: 'turn' }, { kind: 'job' }])
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    // When the operator archives it through the gate
    const response = await post(url, '/api/dsh-session-archive/archive', { ids: ['session-green'], actor: 'manual' })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([{ id: 'session-green', status: 'ok' }])
    // Then the query ran, the job family refused the stop, and the plain
    // path archived exactly as before the ruling.
    expect(waterfall).toHaveBeenCalled()
    expect(archiveSpy).toHaveBeenCalledWith('session-green')
    expect(parallel).toHaveBeenCalledWith('workspace/session-stop', { sessionId: 'session-green' })
  })

  it('a failed activity query degrades the stop-turn archive to the plain path (加固A fail-closed)', async () => {
    // Given the green session over a throwing waterfall
    const host = gateHost()
    const archiveSpy = vi.spyOn(host.registry, 'archiveSession')
    const { service, waterfall, parallel } = cGateService(host, new Error('waterfall exploded'))
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    // When the operator archives it through the gate
    const response = await post(url, '/api/dsh-session-archive/archive', { ids: ['session-green'], actor: 'manual' })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([{ id: 'session-green', status: 'ok' }])
    // Then a failed query answers false — toward today's behaviour, never
    // toward a wider stop — and the plain path archives.
    expect(waterfall).toHaveBeenCalled()
    expect(archiveSpy).toHaveBeenCalledWith('session-green')
    expect(parallel).toHaveBeenCalledWith('workspace/session-stop', { sessionId: 'session-green' })
  })
})
