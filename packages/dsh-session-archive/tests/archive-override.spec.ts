// @vitest-environment node
/**
 * `POST /archive-override` (contract C4) — the native channel's ledger
 * write-back: force ends in `source: "override"` with a normalized reason and
 * a seal judgement, note pins `seal: "stale"`, neither resets an existing
 * `archivedAt` (C3 idempotency), and either order of backfill and write-back
 * leaves exactly one entry (C5). Inventory rows surface reason/seal (C3).
 * @module tests/archive-override.spec
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { makeArchiveRoutes } from '../src/host/routes.ts'
import { ArchiveService } from '../src/host/janitor.ts'
import { deserializeLedger, writeJsonAtomic } from '../src/host/ledger.ts'
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

async function post(url: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url + path, { method: 'POST', body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => undefined) }
}

async function get(url: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url + path)
  return { status: response.status, body: await response.json().catch(() => undefined) }
}

const SAVE_DONE = '## \u2705 执行完成\nSAVE_STATUS=DONE'
const SAVE_TAIL = '## \u2705 执行完成\n保存状态：执行中，稍后继续'

/** Feed sessions + one true-red transcript; `archivedSessionIds` mirrors the native channel having archived them. */
function overrideHost(archived: string[] = []): FakeHost {
  const ids = ['session-native', 'session-red']
  const host = createFakeHost({
    feedItems: ids.map((sessionId) => ({ sessionId, updatedAt: 1 })),
    persistedIds: ids,
    archivedSessionIds: archived,
  })
  writeTranscript(host, 'session-native', [assistantMsg(SAVE_DONE)])
  writeTranscript(host, 'session-red', [userMsg('保存'), assistantMsg(SAVE_TAIL)])
  return host
}

async function settledService(host: FakeHost): Promise<ArchiveService> {
  const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
  await service.start()
  return service
}

/** Seed the on-disk ledger BEFORE the service starts (it loads once). */
async function seedLedger(host: FakeHost, entries: Record<string, { archivedAt: number; source: string; reason?: string; seal?: string }>): Promise<void> {
  await writeJsonAtomic(join(host.home, 'dsh-session-archive', 'archive-ledger.json'), { version: 1, entries })
}

describe('POST /archive-override — mode force (contract C4)', () => {
  it('records override with the stated reason and the seal the caller passes', async () => {
    const host = overrideHost()
    const service = await settledService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive-override', {
      ids: ['session-red'],
      mode: 'force',
      reason: '  真红弹窗确认：板行[x] 收口证据  ',
      seal: 'UNSEALED:sentinel-pending',
    })
    expect(response.status).toBe(200)
    expect(response.body.results).toEqual([
      { id: 'session-red', status: 'ok', archivedAt: expect.any(Number), source: 'override', reason: '真红弹窗确认：板行[x] 收口证据', seal: 'UNSEALED:sentinel-pending' },
    ])
    expect(response.body.results[0].archivedAt).toBeGreaterThan(0)
  })

  it('normalizes a blank or missing reason to override:no-reason at the write layer', async () => {
    const host = overrideHost()
    const service = await settledService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    await post(url, '/api/dsh-session-archive/archive-override', { ids: ['session-native'], mode: 'force', reason: '   ' })
    expect(service.ledgerSnapshot().entries['session-native']?.reason).toBe('override:no-reason')
    await post(url, '/api/dsh-session-archive/archive-override', { ids: ['session-red'], mode: 'force' })
    expect(service.ledgerSnapshot().entries['session-red']?.reason).toBe('override:no-reason')
  })

  it('computes the seal judgement itself when the caller passes no seal (stale stays "stale")', async () => {
    const host = createFakeHost({
      feedItems: [{ sessionId: 'session-s', updatedAt: 1 }, { sessionId: 'session-red', updatedAt: 1 }],
      persistedIds: ['session-s', 'session-red'],
    })
    writeTranscript(host, 'session-s', [assistantMsg(SAVE_DONE), userMsg('续聊'), assistantMsg('继续')])
    writeTranscript(host, 'session-red', [userMsg('保存'), assistantMsg(SAVE_TAIL)])
    const service = await settledService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    await post(url, '/api/dsh-session-archive/archive-override', { ids: ['session-s'], mode: 'force', reason: '真实理由' })
    expect(service.ledgerSnapshot().entries['session-s']?.seal).toBe('stale')
    await post(url, '/api/dsh-session-archive/archive-override', { ids: ['session-red'], mode: 'force', reason: '真实理由' })
    expect(service.ledgerSnapshot().entries['session-red']?.seal).toBe('UNSEALED:save-tail-no-sentinel')
  })

  it('never resets an existing archivedAt and is idempotent on repeat (C3 幂等)', async () => {
    const host = overrideHost()
    await seedLedger(host, { 'session-red': { archivedAt: 1111, source: 'observed' } })
    const service = await settledService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const body = { ids: ['session-red'], mode: 'force', reason: '升级为带原因的强归', seal: 'UNSEALED:save-tail-no-sentinel' }
    const first = await post(url, '/api/dsh-session-archive/archive-override', body)
    expect(first.body.results[0].archivedAt).toBe(1111)
    expect(first.body.results[0].source).toBe('override')
    const second = await post(url, '/api/dsh-session-archive/archive-override', body)
    expect(second.body.results[0].archivedAt).toBe(1111)
    // The upgraded entry survives a reload through the widened whitelist (C3).
    const onDisk = deserializeLedger(readFileSync(join(host.home, 'dsh-session-archive', 'archive-ledger.json'), 'utf8'))
    expect(onDisk.entries['session-red']).toEqual({ archivedAt: 1111, source: 'override', reason: '升级为带原因的强归', seal: 'UNSEALED:save-tail-no-sentinel' })
  })

  it('refuses an unknown mode and an empty id list with 400', async () => {
    const host = overrideHost()
    const service = await settledService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    expect((await post(url, '/api/dsh-session-archive/archive-override', { ids: ['session-red'], mode: 'yolo' })).status).toBe(400)
    expect((await post(url, '/api/dsh-session-archive/archive-override', { ids: [], mode: 'force' })).status).toBe(400)
  })
})

describe('POST /archive-override — mode note (contract C4, stale pass-through)', () => {
  it('writes observed + seal:"stale" when no entry exists yet', async () => {
    const host = overrideHost()
    const service = await settledService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    const response = await post(url, '/api/dsh-session-archive/archive-override', { ids: ['session-native'], mode: 'note' })
    expect(response.status).toBe(200)
    expect(service.ledgerSnapshot().entries['session-native']).toEqual({
      archivedAt: expect.any(Number),
      source: 'observed',
      seal: 'stale',
    })
  })

  it('upgrades an existing entry without touching its source, reason, or archivedAt', async () => {
    const host = overrideHost()
    await seedLedger(host, { 'session-native': { archivedAt: 2222, source: 'manual' } })
    const service = await settledService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    await post(url, '/api/dsh-session-archive/archive-override', { ids: ['session-native'], mode: 'note' })
    expect(service.ledgerSnapshot().entries['session-native']).toEqual({ archivedAt: 2222, source: 'manual', seal: 'stale' })
  })
})

describe('coexistence with the host stamp — exactly one entry either way (C5)', () => {
  it('write-back first: the row then carries an archive time and no second entry appears', async () => {
    // The native channel archived the session; the stale note is written back first.
    const host = overrideHost(['session-native'])
    const service = await settledService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    await post(url, '/api/dsh-session-archive/archive-override', { ids: ['session-native'], mode: 'note' })
    const written = service.ledgerSnapshot().entries['session-native']
    expect(written).toEqual(expect.objectContaining({ source: 'observed', seal: 'stale' }))

    // The next inventory pass sees a row that already carries an archive time
    // (host stamp first, this entry as fallback) — nothing left to record.
    const inventory = await service.inventory()
    const row = inventory.rows.find((entry) => entry.id === 'session-native')
    expect(row?.archivedAt).toBe(written?.archivedAt)
    expect(Object.keys(service.ledgerSnapshot().entries).filter((id) => id === 'session-native')).toHaveLength(1)
    expect(service.ledgerSnapshot().entries['session-native']).toEqual(written)
  })

  it('a historical observed entry first: the note upgrades the same single entry, preserving time and source', async () => {
    const host = overrideHost(['session-native'])
    await seedLedger(host, { 'session-native': { archivedAt: 3333, source: 'observed' } })
    const service = await settledService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    await post(url, '/api/dsh-session-archive/archive-override', { ids: ['session-native'], mode: 'note' })
    const entries = service.ledgerSnapshot().entries
    expect(entries['session-native']).toEqual({ archivedAt: 3333, source: 'observed', seal: 'stale' })
    expect(Object.keys(entries).filter((id) => id === 'session-native')).toHaveLength(1)
  })
})

describe('inventory exposure (contract C3)', () => {
  it('surfaces reason, seal, and the override source on the archived row', async () => {
    const host = overrideHost(['session-red'])
    const service = await settledService(host)
    const { server, url } = await startServer(makeArchiveRoutes(service))
    servers.push(server)
    await post(url, '/api/dsh-session-archive/archive-override', {
      ids: ['session-red'],
      mode: 'force',
      reason: '弹窗输入：30 天内补收口',
      seal: 'UNSEALED:save-tail-no-sentinel',
    })
    const inventory = await get(url, '/api/dsh-session-archive/inventory')
    expect(inventory.status).toBe(200)
    const row = inventory.body.rows.find((entry: { id: string }) => entry.id === 'session-red')
    expect(row).toEqual(expect.objectContaining({
      archived: true,
      archivedAtSource: 'override',
      reason: '弹窗输入：30 天内补收口',
      seal: 'UNSEALED:save-tail-no-sentinel',
    }))
    expect(row.archivedAt).toBeGreaterThan(0)
  })
})
