// @vitest-environment node
/**
 * The archive seal gate over HTTP (contract C2) and the shared `seal-check`
 * endpoint (contract C1): green passes untouched, stale passes with
 * `seal: "stale"` recorded, true red and UNKNOWN are refused per id with
 * their grouping (no batch contagion), `force` needs a real reason or the
 * whole request is a 400.
 * @module tests/seal-gate.spec
 */

import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { makeArchiveRoutes } from '../src/host/routes.ts'
import { ArchiveService } from '../src/host/janitor.ts'
import { assistantMsg, createFakeHost, fakeContext, userMsg, writeTranscript, type FakeHost } from './fixtures.ts'

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

const SAVE_DONE = '## \u2705 执行完成\nSAVE_STATUS=DONE'
const SAVE_TAIL = '## \u2705 执行完成\n保存状态：执行中，稍后继续'
const CLEAN = '普通回复，无任何保存信号。'

interface EndorsedRepo {
  dir: string
  hash: string
}

let repoCache: EndorsedRepo | undefined

/** A real git repo whose single commit sits behind an origin remote-tracking ref (hermetic endorsement fixture). */
function endorsedRepo(): EndorsedRepo {
  if (repoCache !== undefined) return repoCache
  const dir = mkdtempSync(join(tmpdir(), 'seal-gate-endorse-'))
  const run = (args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  run(['init', '-q'])
  run(['config', 'user.email', 'seal@test'])
  run(['config', 'user.name', 'seal'])
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'seed'])
  const hash = run(['rev-parse', 'HEAD']).trim()
  run(['update-ref', 'refs/remotes/origin/main', hash])
  repoCache = { dir, hash }
  return repoCache
}

/** Transcript root event carrying the session cwd — the real transcript shape. */
function sessionRoot(id: string, cwd: string): Record<string, unknown> {
  return { type: 'session', version: 4, id, cwd }
}

/** An endorsed DONE report: 落点头 hash earlier in the message, the endorsement line last. */
function endorsedDone(hash: string): string {
  return `落点头 \`${hash}\` 已推 origin。\n\nSAVE_STATUS=DONE commits=1/1 pushedBranch=1/1 merged=1/1 pushedMain=1/1 auditCleaned=yes dirty=0`
}

/** A fake host with one session per seal shape: green / stale / red / unknown / neutral. */
function gateHost(): FakeHost {
  const ids = ['session-green', 'session-stale', 'session-red', 'session-unknown', 'session-neutral']
  const host = createFakeHost({
    feedItems: ids.map((sessionId) => ({ sessionId, updatedAt: 1 })),
    persistedIds: ids,
  })
  const repo = endorsedRepo()
  writeTranscript(host, 'session-green', [sessionRoot('session-green', repo.dir), assistantMsg(endorsedDone(repo.hash))])
  writeTranscript(host, 'session-stale', [
    userMsg('save'),
    assistantMsg(SAVE_DONE),
    userMsg('再查一个'),
    assistantMsg(CLEAN),
  ])
  writeTranscript(host, 'session-red', [userMsg('保存'), assistantMsg(SAVE_TAIL)])
  writeTranscript(host, 'session-neutral', [userMsg('hi'), assistantMsg(CLEAN)])
  // session-unknown intentionally has no directory at all.
  return host
}

function gateService(host: FakeHost): ArchiveService {
  return new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
}

describe('POST /seal-check (contract C1)', () => {
  it('serves the shared six-value grouping with followUpCount on stale rows', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/seal-check', {
      ids: ['session-green', 'session-stale', 'session-red', 'session-unknown', 'session-neutral'],
    })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([
      { id: 'session-green', verdict: 'DONE', detail: 'sentinel-ok' },
      { id: 'session-stale', verdict: 'UNSEALED', detail: 'sentinel-stale', followUpCount: 2 },
      { id: 'session-red', verdict: 'UNSEALED', detail: 'save-tail-no-sentinel' },
      { id: 'session-unknown', verdict: 'UNKNOWN', detail: 'transcript-not-found' },
      { id: 'session-neutral', verdict: 'NEUTRAL', detail: 'no-save-trace' },
    ])
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

describe('POST /archive — gate path 1: green passes', () => {
  it('archives a DONE session as before: source manual, no seal field', async () => {
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

describe('POST /archive — gate path 2: sentinel-stale passes with accounting', () => {
  it('archives the stale session and records seal:"stale"', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive', { ids: ['session-stale'], actor: 'manual' })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([{ id: 'session-stale', status: 'ok' }])
    expect(service.ledgerSnapshot().entries['session-stale']).toEqual({
      archivedAt: expect.any(Number),
      source: 'manual',
      seal: 'stale',
      actor: 'manual',
    })
  })
})

describe('POST /archive — gate path 3: true red and UNKNOWN refused per id', () => {
  it('skips each unsealed id with seal-required + its grouping while green still archives (批内不连坐)', async () => {
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
      { id: 'session-red', status: 'skipped', reason: 'seal-required', seal: { verdict: 'UNSEALED', detail: 'save-tail-no-sentinel' } },
      { id: 'session-unknown', status: 'skipped', reason: 'seal-required', seal: { verdict: 'UNKNOWN', detail: 'transcript-not-found' } },
    ])
    // Green archived; the refused ids did not.
    expect(host.registry.archivedSessionIds).toEqual(['session-green'])
    expect(service.ledgerSnapshot().entries['session-red']).toBeUndefined()
    expect(service.ledgerSnapshot().entries['session-unknown']).toBeUndefined()
  })

  it('refuses sentinel-pending with its own grouping detail', async () => {
    const host = createFakeHost({ feedItems: [{ sessionId: 'session-pending', updatedAt: 1 }], persistedIds: ['session-pending'] })
    writeTranscript(host, 'session-pending', [assistantMsg('## \u2705 执行完成\nSAVE_STATUS=PENDING(2)')])
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive', { ids: ['session-pending'], actor: 'manual' })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([
      { id: 'session-pending', status: 'skipped', reason: 'seal-required', seal: { verdict: 'UNSEALED', detail: 'sentinel-pending' } },
    ])
    expect(host.registry.archivedSessionIds).toEqual([])
  })
})

describe('POST /archive — gate path 4: force with a real reason', () => {
  it('force + non-empty reason passes a true-red id and records override with the seal it overrode', async () => {
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
      seal: 'UNSEALED:save-tail-no-sentinel',
      actor: 'manual',
    })
  })

  it('a forced batch records every entry as override with its per-id seal (全批 override)', async () => {
    const host = gateHost()
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive', {
      ids: ['session-green', 'session-stale', 'session-red'],
      actor: 'manual',
      force: true,
      reason: 'taskbot:taskRef=板行#anchor 板行[x] 受命收口',
    })
    expect(response.status).toBe(200)
    expect(response.body.results.map((row: { status: string }) => row.status)).toEqual(['ok', 'ok', 'ok'])
    const entries = service.ledgerSnapshot().entries
    expect(entries['session-green']).toEqual(expect.objectContaining({ source: 'override', reason: 'taskbot:taskRef=板行#anchor 板行[x] 受命收口', seal: 'DONE:sentinel-ok' }))
    expect(entries['session-stale']).toEqual(expect.objectContaining({ source: 'override', seal: 'stale' }))
    expect(entries['session-red']).toEqual(expect.objectContaining({ source: 'override', seal: 'UNSEALED:save-tail-no-sentinel' }))
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
      { id: 'session-red', status: 'skipped', reason: 'seal-required', seal: { verdict: 'UNSEALED', detail: 'save-tail-no-sentinel' } },
    ])
    expect(host.registry.archivedSessionIds).toEqual([])
  })
})

describe('endorsement downgrade at the endpoints (seal-noendorse-green-1106)', () => {
  it('operator reads a bare DONE as non-green at seal-check and the archive gate refuses it', async () => {
    // Given a last assistant message asserting DONE with no commits= endorsement
    const host = createFakeHost({ feedItems: [{ sessionId: 'session-bare', updatedAt: 1 }], persistedIds: ['session-bare'] })
    writeTranscript(host, 'session-bare', [assistantMsg('收口完成。\n\nSAVE_STATUS=DONE')])
    const service = gateService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)

    // When the operator reads the seal over HTTP
    const check = await post(url, '/api/dsh-session-archive/seal-check', { ids: ['session-bare'] })
    // Then the row is non-green with the scanner's no-endorsement reading
    expect(check.status).toBe(200)
    expect(check.body.results).toEqual([{ id: 'session-bare', verdict: 'UNSEALED', detail: 'no-endorsement' }])

    // And the archive gate asks for confirmation instead of passing it free
    const archived = await post(url, '/api/dsh-session-archive/archive', { ids: ['session-bare'], actor: 'manual' })
    expect(archived.status).toBe(200)
    expect(archived.body.results).toEqual([
      { id: 'session-bare', status: 'skipped', reason: 'seal-required', seal: { verdict: 'UNSEALED', detail: 'no-endorsement' } },
    ])
    expect(host.registry.archivedSessionIds).toEqual([])
  })
})
