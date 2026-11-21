import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  BOSS_HEARTBEAT_STALE_MS,
  TaskbotBossGate,
  decideBossGate,
  type BossGateReading,
} from '../src/host/boss-gate.ts'
import { makeDispatchRoutes, type DispatchServices } from '../src/host/routes.ts'

/** Fixed clock for the pure verdict: 2026-11-22 02:00 +08. */
const NOW = Date.parse('2026-11-22T02:00:00+08:00')
const FRESH_ISO = new Date(NOW - 60_000).toISOString()
const STALE_ISO = new Date(NOW - 20 * 60_000).toISOString()

function stateReading(stopFlag: string, heartbeatAt?: string, extra: Record<string, unknown> = {}): BossGateReading {
  return {
    kind: 'state',
    state: {
      ownerSessionId: 'session-boss-1',
      ...(heartbeatAt === undefined ? {} : { heartbeatAt }),
      stopFlag,
      ...extra,
    },
  }
}

describe('decideBossGate (pure verdict)', () => {
  it('rejects bot-worker on the provable wedge: halt AND heartbeat >15min stale', () => {
    const decision = decideBossGate(stateReading('halt', STALE_ISO), 'bot-worker', NOW)
    expect(decision).toEqual({ verdict: 'reject', reason: 'halt-stale', halt: true })
  })

  it('allows bot-worker when halted but the heartbeat is still fresh', () => {
    const decision = decideBossGate(stateReading('halt', FRESH_ISO), 'bot-worker', NOW)
    expect(decision).toEqual({ verdict: 'allow', reason: 'halt-fresh', halt: true })
  })

  it('allows stale-no-halt (crash / sparse-heartbeat state) per the board conjunction', () => {
    const decision = decideBossGate(stateReading('none', STALE_ISO), 'bot-worker', NOW)
    expect(decision).toEqual({ verdict: 'allow', reason: 'stale-no-halt', halt: false })
  })

  it('allows the in-position boss', () => {
    const decision = decideBossGate(stateReading('none', FRESH_ISO), 'bot-worker', NOW)
    expect(decision).toEqual({ verdict: 'allow', reason: 'in-position', halt: false })
  })

  it('never gates human-class dispatches, even on a wedge snapshot', () => {
    const decision = decideBossGate(stateReading('halt', STALE_ISO), undefined, NOW)
    expect(decision.verdict).toBe('allow')
    expect(decision.reason).toBe('class-not-gated')
    expect(decision.halt).toBe(true) // wake must still fire for humans
  })

  it('never gates bot-boss dispatches (分支一 must always open a boss)', () => {
    const decision = decideBossGate(stateReading('halt', STALE_ISO), 'bot-boss', NOW)
    expect(decision.verdict).toBe('allow')
    expect(decision.reason).toBe('class-not-gated')
  })

  it('treats the legacy wire spelling `bot` as bot-worker (defense in depth)', () => {
    const decision = decideBossGate(stateReading('halt', STALE_ISO), 'bot', NOW)
    expect(decision.verdict).toBe('reject')
  })

  it('degrades (allow + trace) when the checkpoint is missing', () => {
    const decision = decideBossGate({ kind: 'missing' }, 'bot-worker', NOW)
    expect(decision).toEqual({ verdict: 'degraded', reason: 'state-missing', halt: false })
  })

  it('degrades (allow + trace) when the checkpoint is unreadable', () => {
    const decision = decideBossGate({ kind: 'unreadable', detail: 'Unexpected token' }, 'bot-worker', NOW)
    expect(decision.verdict).toBe('degraded')
    expect(decision.reason).toContain('state-unreadable')
    expect(decision.halt).toBe(false)
  })

  it('reads the legacy heartbeat field name when heartbeatAt is absent (watchdog dual-name)', () => {
    const reading: BossGateReading = { kind: 'state', state: { ownerSessionId: 'session-boss-1', heartbeat: STALE_ISO, stopFlag: 'halt' } }
    expect(decideBossGate(reading, 'bot-worker', NOW).verdict).toBe('reject')
  })

  it('reads an unparseable heartbeat under a halt as stale (more dead, not less)', () => {
    const decision = decideBossGate(stateReading('halt', 'not-a-date'), 'bot-worker', NOW)
    expect(decision.verdict).toBe('reject')
  })

  it('uses the 15-minute grace exactly: stale only when now-hb > 15min', () => {
    const edge = new Date(NOW - BOSS_HEARTBEAT_STALE_MS).toISOString()
    expect(decideBossGate(stateReading('halt', edge), 'bot-worker', NOW).verdict).toBe('allow')
    const justOver = new Date(NOW - BOSS_HEARTBEAT_STALE_MS - 1).toISOString()
    expect(decideBossGate(stateReading('halt', justOver), 'bot-worker', NOW).verdict).toBe('reject')
  })
})

describe('TaskbotBossGate (file-backed)', () => {
  let dir: string
  let statePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'boss-gate-'))
    statePath = join(dir, 'taskbot-state.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const HaltDoc = JSON.stringify({
    ownerSessionId: 'session-old-boss',
    heartbeatAt: STALE_ISO,
    stopFlag: 'halt',
    preauth: { scope: 'standby' },
    lastAction: ['终局: halt'],
  }, null, 2)

  it('reads a present checkpoint as a state reading', async () => {
    await writeFile(statePath, HaltDoc, 'utf8')
    const gate = new TaskbotBossGate({ statePath })
    const reading = await gate.check()
    expect(reading.kind).toBe('state')
    if (reading.kind === 'state') expect(reading.state.stopFlag).toBe('halt')
  })

  it('reports a missing checkpoint as missing, never throws', async () => {
    const gate = new TaskbotBossGate({ statePath })
    expect(await gate.check()).toEqual({ kind: 'missing' })
    expect(await gate.wakeIfHalted()).toBe(false)
  })

  it('reports corrupt JSON as unreadable, never throws', async () => {
    await writeFile(statePath, '{"stopFlag": "hal', 'utf8')
    const gate = new TaskbotBossGate({ statePath })
    const reading = await gate.check()
    expect(reading.kind).toBe('unreadable')
    expect(await gate.wakeIfHalted()).toBe(false)
  })

  it('reports a non-object checkpoint as unreadable', async () => {
    await writeFile(statePath, '["halt"]', 'utf8')
    const gate = new TaskbotBossGate({ statePath })
    expect((await gate.check()).kind).toBe('unreadable')
  })

  it('clears a leftover halt and preserves every other field', async () => {
    await writeFile(statePath, HaltDoc, 'utf8')
    const gate = new TaskbotBossGate({ statePath })
    expect(await gate.wakeIfHalted()).toBe(true)
    const after = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    expect(after.stopFlag).toBe('none')
    expect(after.ownerSessionId).toBe('session-old-boss')
    expect(after.heartbeatAt).toBe(STALE_ISO)
    expect(after.preauth).toEqual({ scope: 'standby' })
    expect(after.lastAction).toEqual(['终局: halt'])
  })

  it('is idempotent: a second wake finds no halt and reports false', async () => {
    await writeFile(statePath, HaltDoc, 'utf8')
    const gate = new TaskbotBossGate({ statePath })
    expect(await gate.wakeIfHalted()).toBe(true)
    expect(await gate.wakeIfHalted()).toBe(false)
  })

  it('leaves a non-halt checkpoint untouched', async () => {
    const doc = JSON.stringify({ ownerSessionId: 'session-x', heartbeatAt: FRESH_ISO, stopFlag: 'none' }, null, 2)
    await writeFile(statePath, doc, 'utf8')
    const gate = new TaskbotBossGate({ statePath })
    expect(await gate.wakeIfHalted()).toBe(false)
    expect(await readFile(statePath, 'utf8')).toBe(doc)
  })

  it('end-to-end: a wedge snapshot decides reject, the wake then clears it, the re-read allows', async () => {
    await writeFile(statePath, HaltDoc, 'utf8')
    const gate = new TaskbotBossGate({ statePath })
    const before = await gate.check()
    const verdict = decideBossGate(before, 'bot-worker', NOW)
    expect(verdict.verdict).toBe('reject')
    expect(await gate.wakeIfHalted()).toBe(true)
    const after = await gate.check()
    expect(decideBossGate(after, 'bot-worker', NOW).verdict).toBe('allow') // halt cleared → board conjunction no longer holds
  })
})

/** Minimal req/res doubles (same shape as routes.spec.ts). */
function fakeReq(method: string, body: unknown): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from([Buffer.from(payload)]) as IncomingMessage
  stream.method = method
  stream.url = '/api/session-dispatch'
  stream.headers = { host: '127.0.0.1:3080' }
  stream.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']
  return stream
}

interface Captured { status: number; body: Record<string, unknown> }
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: {} }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(payload?: string) { if (payload !== undefined) captured.body = JSON.parse(payload) },
  } as unknown as ServerResponse
  return { res, captured }
}

function servicesWithGate(bossGate: DispatchServices['bossGate']): DispatchServices {
  return {
    sessions: {
      async create() { return { sessionId: 'session-abc' } },
      async rename() { return {} },
      async prompt() { return { accepted: true } },
      async cancel() { return { accepted: true } },
    },
    workspaces: { get: (id: string) => (id === 'ws-1' ? { id: 'ws-1' } : undefined) },
    ...(bossGate === undefined ? {} : { bossGate }),
  }
}

async function runDispatch(services: DispatchServices, body: unknown): Promise<Captured> {
  const handler = makeDispatchRoutes(services)[0].handler!
  const { res, captured } = fakeRes()
  await handler(fakeReq('POST', body), res)
  return captured
}

describe('dispatch route wiring (boss gate + halt wake)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const wedge: BossGateReading = stateReading('halt', STALE_ISO)

  it('refuses bot-worker on a wedge with 428 and still fires the wake', async () => {
    const gate = { check: vi.fn(async () => wedge), wakeIfHalted: vi.fn(async () => true) }
    const captured = await runDispatch(servicesWithGate(gate), { workspaceId: 'ws-1', prompt: 'work', sessionClass: 'bot-worker', taskRef: 'board.md#x' })
    expect(captured.status).toBe(428)
    expect(captured.body.ok).toBe(false)
    expect(captured.body.bossGate).toEqual({ verdict: 'reject', reason: 'halt-stale', haltCleared: true })
    expect(String(captured.body.error)).toContain('sessionClass=bot-boss') // points at 分支一
    expect(gate.check).toHaveBeenCalledTimes(1)
    expect(gate.wakeIfHalted).toHaveBeenCalledTimes(1) // rejected dispatch is itself the wake event
  })

  it('reports haltCleared=false when the wake write fails, still refuses', async () => {
    const gate = { check: vi.fn(async () => wedge), wakeIfHalted: vi.fn(async () => false) }
    const captured = await runDispatch(servicesWithGate(gate), { workspaceId: 'ws-1', prompt: 'work', sessionClass: 'bot-worker' })
    expect(captured.status).toBe(428)
    expect(captured.body.bossGate).toEqual({ verdict: 'reject', reason: 'halt-stale', haltCleared: false })
  })

  it('lets human dispatches through a wedge and still wakes', async () => {
    const gate = { check: vi.fn(async () => wedge), wakeIfHalted: vi.fn(async () => true) }
    const captured = await runDispatch(servicesWithGate(gate), { workspaceId: 'ws-1', prompt: 'hello' })
    expect(captured.status).toBe(200)
    expect(captured.body.bossGate).toEqual({ verdict: 'allow', reason: 'class-not-gated', haltCleared: true })
    expect(gate.wakeIfHalted).toHaveBeenCalledTimes(1)
  })

  it('never gates 分支一: bot-boss dispatch passes a wedge', async () => {
    const gate = { check: vi.fn(async () => wedge), wakeIfHalted: vi.fn(async () => true) }
    const captured = await runDispatch(servicesWithGate(gate), { workspaceId: 'ws-1', prompt: 'open a boss', sessionClass: 'bot-boss' })
    expect(captured.status).toBe(200)
    expect(captured.body.bossGate).toMatchObject({ verdict: 'allow', reason: 'class-not-gated' })
  })

  it('gates the legacy `bot` spelling too (normalized to bot-worker)', async () => {
    const gate = { check: vi.fn(async () => wedge), wakeIfHalted: vi.fn(async () => true) }
    const captured = await runDispatch(servicesWithGate(gate), { workspaceId: 'ws-1', prompt: 'work', sessionClass: 'bot' })
    expect(captured.status).toBe(428)
    expect(captured.body.bossGate).toMatchObject({ verdict: 'reject', reason: 'halt-stale' })
  })

  it('degrades to a traced allow when the checkpoint is unreadable', async () => {
    const gate = { check: vi.fn(async (): Promise<BossGateReading> => ({ kind: 'unreadable', detail: 'boom' })), wakeIfHalted: vi.fn(async () => false) }
    const captured = await runDispatch(servicesWithGate(gate), { workspaceId: 'ws-1', prompt: 'work', sessionClass: 'bot-worker' })
    expect(captured.status).toBe(200)
    expect(captured.body.bossGate).toMatchObject({ verdict: 'degraded' })
    expect(gate.wakeIfHalted).not.toHaveBeenCalled() // no halt in an unreadable reading
  })

  it('does not wake when the snapshot has no halt', async () => {
    // The route reads the real clock, so this heartbeat must be fresh against it.
    const realFresh = { kind: 'state', state: { ownerSessionId: 'session-boss-1', heartbeatAt: new Date(Date.now() - 60_000).toISOString(), stopFlag: 'none' } } satisfies BossGateReading
    const gate = { check: vi.fn(async () => realFresh), wakeIfHalted: vi.fn(async () => true) }
    const captured = await runDispatch(servicesWithGate(gate), { workspaceId: 'ws-1', prompt: 'work', sessionClass: 'bot-worker' })
    expect(captured.status).toBe(200)
    expect(captured.body.bossGate).toEqual({ verdict: 'allow', reason: 'in-position' })
    expect(gate.wakeIfHalted).not.toHaveBeenCalled()
  })

  it('keeps the response byte-identical when no bossGate is composed', async () => {
    const captured = await runDispatch(servicesWithGate(undefined), { workspaceId: 'ws-1', prompt: 'do it', title: 'T' })
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, sessionId: 'session-abc' })
    expect('bossGate' in captured.body).toBe(false)
  })
})
