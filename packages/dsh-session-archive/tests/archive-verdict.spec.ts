// @vitest-environment node
/**
 * The archive-readiness four-tuple (lamp-wiring-1126, §8.4):
 * - fold semantics per dimension (pass / fail / unreadable, fail precedence),
 * - the machine readings behind each dimension (save-status `repos=` cell,
 *   debt-scan count/error shapes, FSM done+E8, alive binding),
 * - fail-closed at the REST gate: ANY dimension unreadable ⇒ the id refuses
 *   with `seal-required` + the UNKNOWN grouping and NOTHING is written,
 * - two-leg consistency (seal-lamp-consistency-1114): the C1 pull route and
 *   the turn/end Host push leg compute the same structured result from the
 *   same sources — with no transcript on disk, which proves the swap off the
 *   text read for real.
 * @module tests/archive-verdict.spec
 */

import { existsSync, readFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { computeFourTuple, foldFourTuple, fourTupleRefOf, type FourTuple, type VerdictSources } from '../src/host/archive-verdict.ts'
import { makeArchiveRoutes } from '../src/host/routes.ts'
import { ArchiveService } from '../src/host/janitor.ts'
import { sessionSealProjection } from '../src/host/seal-projection.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { FIXTURE_ROOT, FIXTURE_SAVE_GREEN, createFakeHost, fakeContext, fixtureSources, modelHostAppend, type FakeHost } from './fixtures.ts'

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

async function post(url: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return { status: response.status, body: await response.json().catch(() => undefined) }
}

const SID = 'session-tuple'
const REF = 'content/tech/ai/dsh/tasks.md#tuple-task'

function bindingsFor(sessionId: string, ref: string = REF): VerdictSources {
  return fixtureSources({ bindings: { [sessionId]: { taskRef: ref, workspaceId: 'ws-1' } } })
}

async function verdict(sources: VerdictSources, id = SID): Promise<Awaited<ReturnType<typeof computeFourTuple>>> {
  return computeFourTuple(id, sources)
}

const pass = (state: 'pass' | 'fail' | 'unreadable', note = 'x') => ({ state, source: 'test', note })

describe('foldFourTuple — fail precedence, then unreadable, then green', () => {
  it('operator folds four passes to DONE 4t-pass', () => {
    const readings: FourTuple = { contract: pass('pass'), e8: pass('pass'), pushed: pass('pass'), debt: pass('pass') }
    expect(foldFourTuple(readings)).toEqual({ verdict: 'DONE', detail: '4t-pass' })
  })

  it('operator folds the FIRST red dimension by fold order and beats an unreadable one', () => {
    // e8 red beside an unreadable pushed dim: the AND is already false, so a
    // definitive red answers (the receipt names the actionable dim).
    const readings: FourTuple = { contract: pass('pass'), e8: pass('fail'), pushed: pass('unreadable'), debt: pass('pass') }
    expect(foldFourTuple(readings)).toEqual({ verdict: 'UNSEALED', detail: '4t-red-e8' })
    // contract red outranks everything after it.
    const contractFirst: FourTuple = { contract: pass('fail'), e8: pass('unreadable'), pushed: pass('pass'), debt: pass('pass') }
    expect(foldFourTuple(contractFirst)).toEqual({ verdict: 'UNSEALED', detail: '4t-red-contract' })
  })

  it('operator folds any unreadable (no red) to UNKNOWN, naming the first one', () => {
    const readings: FourTuple = { contract: pass('pass'), e8: pass('pass'), pushed: pass('unreadable'), debt: pass('unreadable') }
    expect(foldFourTuple(readings)).toEqual({ verdict: 'UNKNOWN', detail: '4t-unreadable-pushed' })
  })
})

describe('computeFourTuple — the four machine readings', () => {
  it('operator reads an alive binding + FSM done&E8 + reached push lines + zero debt as DONE', async () => {
    const result = await verdict(bindingsFor(SID))
    expect(result.verdict).toBe('DONE')
    expect(result.detail).toBe('4t-pass')
    expect(result.readings).toEqual({
      contract: { state: 'pass', source: 'GET /api/session-dispatch/bindings', note: 'alive-binding' },
      e8: { state: 'pass', source: 'GET /api/task-fsm/state', note: 'e8-done' },
      pushed: { state: 'pass', source: 'scripts/git/save-status.py (repos= cell)', note: 'reached-push-lines' },
      debt: { state: 'pass', source: 'scripts/dsh/debt-scan.py --json', note: 'no-debt-markers' },
    })
  })

  it('operator reads no alive binding as a red contract dim', async () => {
    const result = await verdict(fixtureSources({ bindings: { [SID]: undefined } }))
    expect(result).toEqual(expect.objectContaining({ verdict: 'UNSEALED', detail: '4t-red-contract' }))
    expect(result.readings.contract.note).toBe('no-alive-binding')
    // No taskRef ⇒ the other dims honestly report no-taskref, never a pass.
    expect(result.readings.e8.state).toBe('unreadable')
    expect(result.readings.pushed.state).toBe('unreadable')
    expect(result.readings.debt.state).toBe('unreadable')
  })

  it('operator reads an unreadable bindings source as UNKNOWN (查不清即拦)', async () => {
    const result = await verdict(fixtureSources({ bindings: { [SID]: null } }))
    expect(result).toEqual(expect.objectContaining({ verdict: 'UNKNOWN', detail: '4t-unreadable-contract' }))
    expect(result.readings.contract.note).toBe('bindings-unreadable')
  })

  it('operator folds FSM state and history into the E8 dim', async () => {
    const base = { bindings: { [SID]: { taskRef: REF, workspaceId: 'ws-1' } } }
    const missing = await verdict(fixtureSources({ ...base, fsm: {} }))
    expect(missing).toEqual(expect.objectContaining({ verdict: 'UNSEALED', detail: '4t-red-e8' }))
    expect(missing.readings.e8.note).toBe('task-missing')

    const active = await verdict(fixtureSources({ ...base, fsm: { [REF]: { state: 'active', history: [] } } }))
    expect(active).toEqual(expect.objectContaining({ verdict: 'UNSEALED', detail: '4t-red-e8' }))
    expect(active.readings.e8.note).toBe('task-not-done')

    const noE8 = await verdict(fixtureSources({ ...base, fsm: { [REF]: { state: 'done', history: [{ event: 'E7' }] } } }))
    expect(noE8).toEqual(expect.objectContaining({ verdict: 'UNSEALED', detail: '4t-red-e8' }))
    expect(noE8.readings.e8.note).toBe('no-e8-event')

    const unreadable = await verdict(fixtureSources({ ...base, fsm: null }))
    expect(unreadable).toEqual(expect.objectContaining({ verdict: 'UNKNOWN', detail: '4t-unreadable-e8' }))
  })

  it('operator reads the save-status repos= cell into the pushed dim', async () => {
    const base = { bindings: { [SID]: { taskRef: REF, workspaceId: 'ws-1' } } }
    const green = await verdict(fixtureSources({ ...base, save: FIXTURE_SAVE_GREEN }))
    expect(green.readings.pushed).toEqual(expect.objectContaining({ state: 'pass', note: 'reached-push-lines' }))

    const partial = await verdict(fixtureSources({ ...base, save: 'SAVE_STATUS=PENDING 未达入仓线; repo=/x commits=1/1 repos=1/2 hashes=abc' }))
    expect(partial).toEqual(expect.objectContaining({ verdict: 'UNSEALED', detail: '4t-red-pushed' }))
    expect(partial.readings.pushed.note).toBe('not-reached-1of2')

    const vacuous = await verdict(fixtureSources({ ...base, save: 'SAVE_STATUS=DONE repo=/x repos=0/0 hashes=' }))
    expect(vacuous.readings.pushed).toEqual(expect.objectContaining({ state: 'pass', note: 'no-changed-repos' }))

    const registryDown = await verdict(fixtureSources({ ...base, save: 'SAVE_STATUS=PENDING not-a-git-repo; repo=/x repos=n/a hashes=' }))
    expect(registryDown).toEqual(expect.objectContaining({ verdict: 'UNKNOWN', detail: '4t-unreadable-pushed' }))
    expect(registryDown.readings.pushed.note).toBe('registry-unavailable')

    const unparseable = await verdict(fixtureSources({ ...base, save: 'garbage with no cell' }))
    expect(unparseable).toEqual(expect.objectContaining({ verdict: 'UNKNOWN', detail: '4t-unreadable-pushed' }))
    expect(unparseable.readings.pushed.note).toBe('save-status-unparseable')

    const spawnFailed = await verdict(fixtureSources({ ...base, save: null }))
    expect(spawnFailed).toEqual(expect.objectContaining({ verdict: 'UNKNOWN', detail: '4t-unreadable-pushed' }))
    expect(spawnFailed.readings.pushed.note).toBe('save-status-unreadable')
  })

  it('operator maps the debt-scan count and fail-open error shapes into the debt dim', async () => {
    const base = { bindings: { [SID]: { taskRef: REF, workspaceId: 'ws-1' } } }
    const clean = await verdict(fixtureSources({ ...base, debt: { count: 0 } }))
    expect(clean.readings.debt).toEqual(expect.objectContaining({ state: 'pass', note: 'no-debt-markers' }))

    const dirty = await verdict(fixtureSources({ ...base, debt: { count: 3 } }))
    expect(dirty).toEqual(expect.objectContaining({ verdict: 'UNSEALED', detail: '4t-red-debt' }))
    expect(dirty.readings.debt.note).toBe('debt-markers-3')

    // debt-scan's documented fail-open "empty diff" is a legitimate pass.
    const emptyDiff = await verdict(fixtureSources({ ...base, debt: { error: 'diff 为空（无可扫 md 改动）' } }))
    expect(emptyDiff.readings.debt).toEqual(expect.objectContaining({ state: 'pass', note: 'no-diff-to-scan' }))

    // Any other script error could not be read: fail-closed, never a pass.
    const gitDown = await verdict(fixtureSources({ ...base, debt: { error: 'git 错误: not a repository' } }))
    expect(gitDown).toEqual(expect.objectContaining({ verdict: 'UNKNOWN', detail: '4t-unreadable-debt' }))

    const spawnFailed = await verdict(fixtureSources({ ...base, debt: null }))
    expect(spawnFailed).toEqual(expect.objectContaining({ verdict: 'UNKNOWN', detail: '4t-unreadable-debt' }))
    expect(spawnFailed.readings.debt.note).toBe('debt-scan-unreadable')
  })

  it('operator reads an unresolvable workspace root as unreadable for both script legs', async () => {
    const result = await verdict(fixtureSources({ bindings: { [SID]: { taskRef: REF, workspaceId: 'ws-1' } }, root: null }))
    expect(result).toEqual(expect.objectContaining({ verdict: 'UNKNOWN', detail: '4t-unreadable-pushed' }))
    expect(result.readings.pushed.note).toBe('no-root')
    expect(result.readings.debt.note).toBe('no-root')
  })

  it('operator folds a running session by its binding alone (activity legs stay external)', async () => {
    // The four-tuple does not read `running`: 回合约态's activity half lives
    // on the retained legs (auto skip, C′ waterfall, harness activity拒, the
    // lamp's client short-circuit). A running row with an alive binding and
    // three green dims still reads DONE here — the channel short-circuits.
    const result = await verdict(bindingsFor(SID))
    expect(result.verdict).toBe('DONE')
  })
})

describe('POST /seal-check + POST /archive — fail-closed, any dim unreadable', () => {
  const dims: Array<{ dim: 'contract' | 'e8' | 'pushed' | 'debt'; detail: string; spec: Parameters<typeof fixtureSources>[0] }> = [
    { dim: 'contract', detail: '4t-unreadable-contract', spec: { bindings: { [SID]: null } } },
    { dim: 'e8', detail: '4t-unreadable-e8', spec: { bindings: { [SID]: { taskRef: REF, workspaceId: 'ws-1' } }, fsm: null } },
    { dim: 'pushed', detail: '4t-unreadable-pushed', spec: { bindings: { [SID]: { taskRef: REF, workspaceId: 'ws-1' } }, save: null } },
    { dim: 'debt', detail: '4t-unreadable-debt', spec: { bindings: { [SID]: { taskRef: REF, workspaceId: 'ws-1' } }, debt: null } },
  ]

  for (const entry of dims) {
    it(`operator refuses a ${entry.dim} read failure with zero writes (${entry.detail})`, async () => {
      // Given a service whose ${entry.dim} source cannot be read, everything else green
      const host = createFakeHost({ feedItems: [{ sessionId: SID, updatedAt: 1 }], persistedIds: [SID] })
      const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home, verdictSources: fixtureSources(entry.spec) })
      await service.start()
      const { server, url } = await startServer(makeArchiveRoutes(service))
      servers.push(server)
      const ledgerPath = join(host.home, 'dsh-session-archive', 'archive-ledger.json')
      const journalPath = join(host.home, 'dsh-session-archive', 'archive-events.jsonl')

      // When the operator asks the lamp and then tries to archive
      const lamp = await post(url, '/api/dsh-session-archive/seal-check', { ids: [SID] })
      const archived = await post(url, '/api/dsh-session-archive/archive', { ids: [SID], actor: 'manual' })

      // Then both channels fail closed on the same grouping…
      expect(lamp.status).toBe(200)
      expect(lamp.body.results[0]).toEqual(expect.objectContaining({ id: SID, verdict: 'UNKNOWN', detail: entry.detail }))
      expect(lamp.body.results[0].readings[entry.dim].state).toBe('unreadable')
      expect(archived.status).toBe(200)
      expect(archived.body.results).toEqual([
        { id: SID, status: 'skipped', reason: 'seal-required', seal: { verdict: 'UNKNOWN', detail: entry.detail } },
      ])

      // …and NOTHING is written: no per-id ledger entry (in memory or on
      // disk), no archive, no journal event.
      expect(service.ledgerSnapshot().entries[SID]).toBeUndefined()
      expect(Object.keys(service.ledgerSnapshot().entries)).toHaveLength(0)
      const ledgerAfter = existsSync(ledgerPath)
        ? JSON.parse(readFileSync(ledgerPath, 'utf8')) as { entries: Record<string, unknown> }
        : { entries: {} }
      expect(Object.keys(ledgerAfter.entries)).toHaveLength(0)
      expect(host.registry.archivedSessionIds).toEqual([])
      expect(existsSync(journalPath)).toBe(false)
      await service.stop()
    })
  }

  it('operator receives an actionable per-dim remedy on red and none on unknown', async () => {
    const host = createFakeHost({ feedItems: [{ sessionId: SID, updatedAt: 1 }], persistedIds: [SID] })
    const red = new ArchiveService(fakeContext(host) as never, {
      dshHome: host.home,
      verdictSources: fixtureSources({ bindings: { [SID]: { taskRef: REF, workspaceId: 'ws-1' } }, fsm: { [REF]: { state: 'active', history: [] } } }),
    })
    const { server, url } = await startServer(makeArchiveRoutes(red))
    servers.push(server)
    const refused = await post(url, '/api/dsh-session-archive/archive', { ids: [SID], actor: 'manual' })
    expect(refused.body.results[0].seal).toEqual({
      verdict: 'UNSEALED',
      detail: '4t-red-e8',
      remedy: expect.stringContaining('验收未过'),
    })
    // UNKNOWN carries only the grouping: an unreadable source is not fixed by an action.
    expect(fourTupleRefOf({ verdict: 'UNKNOWN', detail: '4t-unreadable-e8' })).toEqual({ verdict: 'UNKNOWN', detail: '4t-unreadable-e8' })
  })

  it('operator force-passes a red id and the ledger records the tuple judgement it overrode', async () => {
    const host = createFakeHost({ feedItems: [{ sessionId: SID, updatedAt: 1 }], persistedIds: [SID] })
    const service = new ArchiveService(fakeContext(host) as never, {
      dshHome: host.home,
      verdictSources: fixtureSources({ bindings: { [SID]: { taskRef: REF, workspaceId: 'ws-1' } }, fsm: {} }),
    })
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive', { ids: [SID], actor: 'manual', force: true, reason: '板行[x] 受命强归' })
    expect(response.body.results).toEqual([{ id: SID, status: 'ok' }])
    expect(service.ledgerSnapshot().entries[SID]).toEqual(expect.objectContaining({ source: 'override', seal: 'UNSEALED:4t-red-e8' }))
  })
})

/** A real cordis context carrying both the archive faces and the projection fold. */
function legHarness(host: FakeHost, sources: VerdictSources): { ctx: Context; service: ArchiveService; session: Session; stateOf: () => unknown } {
  const ctx = new Context()
  const session = Session.create(SessionId(SID))
  // The push leg's record write dispatches through the Host's public `append`
  // and verifies the ignorable stamp (seal-write-crosscopy-1127); model that
  // contract on the rc.3 test copy, whose own append has no LogIntent slot.
  modelHostAppend(session)
  let registered: typeof sessionSealProjection | undefined
  const stateOf = (): unknown => {
    if (registered === undefined) return undefined
    let state = registered.init(session.header, session.seq)
    for (const event of session.snapshotEvents()) state = registered.apply(state, event)
    return state
  }
  ctx.provide('sessionProjections', {
    register: (definition: typeof sessionSealProjection) => {
      registered = definition
      return () => { registered = undefined }
    },
    stateOf: (target: Session, key: string) => (key === 'seal' ? stateOf() : undefined),
    onChanged: () => () => undefined,
  } as never)
  ctx.provide('sessions', { get: (id: string) => (id === String(session.id) ? session : undefined) } as never)
  ctx.provide('workspaceRegistry', host.registry as never)
  ctx.provide('sessionController', {
    async list() { return { items: host.feedItems } },
    async inspect() { return { meta: {}, events: [] } },
  } as never)
  const service = new ArchiveService(ctx as never, { dshHome: host.home, verdictSources: sources })
  return { ctx, service, session, stateOf }
}

describe('two-leg consistency — C1 pull route and turn/end Host push leg', () => {
  it('operator sees the same structured result from both legs — with no transcript on disk', async () => {
    // Given a session with NO transcript at all (the old text read would
    // answer UNKNOWN transcript-not-found) and all four dims green
    const host = createFakeHost({ feedItems: [{ sessionId: SID, updatedAt: 1 }], persistedIds: [SID] })
    const { ctx, service, session, stateOf } = legHarness(host, bindingsFor(SID))
    await service.start()
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)

    // When the C1 pull leg answers over its route…
    const c1 = await post(url, '/api/dsh-session-archive/seal-check', { ids: [SID] })
    expect(c1.status).toBe(200)
    const row = c1.body.results[0]

    // …and the Host push leg answers from a real turn/end
    const event = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    ctx.emit('session/event', session, event as SessionEvent)
    await vi.waitFor(() => { expect(stateOf()).not.toBeNull() })
    const pushed = stateOf() as { verdict: string; detail: string }

    // Then both legs carry the SAME structured result — the four-tuple, not a
    // transcript read (no transcript exists to read).
    expect(row).toEqual(expect.objectContaining({ id: SID, verdict: 'DONE', detail: '4t-pass' }))
    expect(pushed.verdict).toBe(row.verdict)
    expect(pushed.detail).toBe(row.detail)
    expect(pushed.verdict).toBe('DONE')

    await service.stop()
    await ctx.fiber.dispose()
  })

  it('operator sees both legs agree on UNKNOWN when a source is unreadable', async () => {
    const host = createFakeHost({ feedItems: [{ sessionId: SID, updatedAt: 1 }], persistedIds: [SID] })
    const { ctx, service, session, stateOf } = legHarness(host, fixtureSources({ bindings: { [SID]: null } }))
    await service.start()
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)

    const c1 = await post(url, '/api/dsh-session-archive/seal-check', { ids: [SID] })
    const event = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } as never })
    ctx.emit('session/event', session, event as SessionEvent)
    await vi.waitFor(() => { expect(stateOf()).not.toBeNull() })
    const pushed = stateOf() as { verdict: string; detail: string }

    expect(c1.body.results[0]).toEqual(expect.objectContaining({ verdict: 'UNKNOWN', detail: '4t-unreadable-contract' }))
    expect(pushed).toEqual({ verdict: 'UNKNOWN', detail: '4t-unreadable-contract' })

    await service.stop()
    await ctx.fiber.dispose()
  })
})

describe('per-request source dedup — one fetch/scan per request, never across', () => {
  it('operator pays one FSM fetch and one debt scan for a three-id seal-check', async () => {
    const host = createFakeHost({
      feedItems: ['a', 'b', 'c'].map((n) => ({ sessionId: `session-${n}`, updatedAt: 1 })),
      persistedIds: ['session-a', 'session-b', 'session-c'],
    })
    const inner = fixtureSources({
      bindings: {
        'session-a': { taskRef: REF, workspaceId: 'ws-1' },
        'session-b': { taskRef: REF, workspaceId: 'ws-1' },
        'session-c': { taskRef: REF, workspaceId: 'ws-1' },
      },
    })
    const fsmSpy = vi.fn(() => inner.fsmTasks())
    const debtSpy = vi.fn(() => inner.debtScan(FIXTURE_ROOT))
    const bindingSpy = vi.fn((id: string) => inner.binding(id))
    const service = new ArchiveService(fakeContext(host) as never, {
      dshHome: host.home,
      verdictSources: { ...inner, binding: bindingSpy, fsmTasks: fsmSpy, debtScan: debtSpy },
    })

    const rows = await service.sealCheck(['session-a', 'session-b', 'session-c'])
    expect(rows.map((row) => row.verdict)).toEqual(['DONE', 'DONE', 'DONE'])
    // Bindings key per session (the taskRef differs per session by design);
    // the shared legs dedup to one call across the whole request.
    expect(bindingSpy).toHaveBeenCalledTimes(3)
    expect(fsmSpy).toHaveBeenCalledTimes(1)
    expect(debtSpy).toHaveBeenCalledTimes(1)
    // And the next request recomputes: no cross-request cache exists.
    await service.sealCheck(['session-a'])
    expect(fsmSpy).toHaveBeenCalledTimes(2)
  })
})
