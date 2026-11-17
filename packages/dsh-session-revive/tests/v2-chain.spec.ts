import { describe, expect, it } from 'vitest'
import {
  RELAY_ACTOR,
  buildArchiveReason,
  buildRelaySeed,
  runArchiveRelayChain,
  type ChainPorts,
  type SpawnTarget,
} from '../src/v2-chain.ts'
import type { V2ArchiveReason } from '../src/v2-machine.ts'

const REASON: V2ArchiveReason = {
  code: 'revive-failed-spend-no-progress',
  tokens: 4_321,
  from: Date.UTC(2026, 10, 16, 8, 0, 0),
  to: Date.UTC(2026, 10, 16, 8, 12, 30),
  form: 'spend-no-progress',
}

/** Ports double: records every call in order, each step scripted by the test. */
interface ChainFake {
  ports: ChainPorts
  calls: string[]
  archives: string[]
  spawns: Array<{ seed: string; target: SpawnTarget }>
  updates: string[]
}

function fakePorts(
  script: {
    verify?: { ok: boolean; detail: string }
    resolve?: { ok: boolean; detail: string; target?: SpawnTarget }
    archive?: { ok: boolean; detail: string }
    spawn?: { ok: boolean; relaySessionId?: string; detail: string }
    update?: { ok: boolean; detail: string }
  } = {},
): ChainFake {
  const calls: string[] = []
  const archives: string[] = []
  const spawns: Array<{ seed: string; target: SpawnTarget }> = []
  const updates: string[] = []
  const ports: ChainPorts = {
    async verifyTranscript() {
      calls.push('verify')
      return script.verify ?? { ok: true, detail: 'readable frames=2 events=9' }
    },
    async resolveSpawnTarget() {
      calls.push('resolve')
      const step = script.resolve ?? { ok: true, detail: 'bound', target: { workspaceId: 'ws-1', taskRef: 'content/x.md#anchor' } }
      if (!step.ok || step.target === undefined) return { ok: false, detail: step.detail }
      return { ok: true, target: step.target }
    },
    async archive(_sessionId, reason) {
      calls.push('archive')
      archives.push(reason)
      return script.archive ?? { ok: true, detail: 'archived http 200' }
    },
    async spawnRelay(input) {
      calls.push('spawn')
      spawns.push({ seed: input.seed, target: input.target })
      return script.spawn ?? { ok: true, relaySessionId: 'session-relay-1', detail: 'dispatched http 200' }
    },
    async updateArchiveReason(_sessionId, reason) {
      calls.push('update')
      updates.push(reason)
      return script.update ?? { ok: true, detail: 'reason updated http 200' }
    },
  }
  return { ports, calls, archives, spawns, updates }
}

describe('structured archive reason (section four, never prose)', () => {
  it('formats code, spend, window and pending relay id', () => {
    expect(buildArchiveReason(REASON)).toBe(
      'revive-failed-spend-no-progress; tokens=4321; from=2026-11-16T08:00:00.000Z; to=2026-11-16T08:12:30.000Z; relay=pending',
    )
  })

  it('folds the real relay id into the rewrite', () => {
    expect(buildArchiveReason(REASON, 'session-relay-9')).toContain('relay=session-relay-9')
  })
})

describe('relay seed prompt (section four)', () => {
  it('carries relayDepth=1, the 代劳 save first step, and the no-further-relay discipline', () => {
    const seed = buildRelaySeed({ sourceSessionId: 'session-dead', reason: 'r', taskRef: 'tasks.md#anchor' })
    expect(seed).toContain('relayDepth=1')
    expect(seed).toContain('第一步（代劳 save）')
    expect(seed).toContain('session-dead')
    expect(seed).toContain('任务锚 = tasks.md#anchor')
    expect(seed).toContain('保留现场等人工')
  })

  it('omits the task anchor line when the binding had none', () => {
    const seed = buildRelaySeed({ sourceSessionId: 'session-dead', reason: 'r' })
    expect(seed).not.toContain('任务锚')
  })
})

describe('archive-relay-save chain order (section four, order never reversed)', () => {
  it('runs verify -> resolve -> archive -> spawn -> update in exactly that order', async () => {
    const fake = fakePorts()
    const outcome = await runArchiveRelayChain({ sessionId: 'session-dead', reason: REASON, ports: fake.ports })
    expect(fake.calls).toEqual(['verify', 'resolve', 'archive', 'spawn', 'update'])
    expect(outcome.ok).toBe(true)
    expect(outcome.relaySessionId).toBe('session-relay-1')
    expect(outcome.records).toHaveLength(1)
    expect(outcome.records[0]).toMatchObject({ kind: 'v2-chain', ok: true, relaySessionId: 'session-relay-1' })
    // The archive reason is the structured one; the update carries the relay id.
    expect(fake.archives[0]).toContain('revive-failed-spend-no-progress')
    expect(fake.archives[0]).toContain('relay=pending')
    expect(fake.updates[0]).toContain('relay=session-relay-1')
  })

  it('passes the spawn target and the seeded prompt to the dispatcher', async () => {
    const fake = fakePorts()
    await runArchiveRelayChain({ sessionId: 'session-dead', reason: REASON, ports: fake.ports })
    expect(fake.spawns).toHaveLength(1)
    expect(fake.spawns[0].target).toEqual({ workspaceId: 'ws-1', taskRef: 'content/x.md#anchor' })
    expect(fake.spawns[0].seed).toContain('relayDepth=1')
    expect(fake.spawns[0].seed).toContain('session-dead')
  })

  it('stops BEFORE the archive when the transcript pre-flight refuses (fail-closed)', async () => {
    const fake = fakePorts({ verify: { ok: false, detail: 'transcript-unreadable: bad-frames:1' } })
    const outcome = await runArchiveRelayChain({ sessionId: 'session-dead', reason: REASON, ports: fake.ports })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('verify refused (fail-closed)')
    expect(fake.calls).toEqual(['verify'])
    expect(fake.archives).toEqual([])
    expect(fake.spawns).toEqual([])
  })

  it('stops BEFORE the archive when the spawn target cannot be resolved', async () => {
    const fake = fakePorts({ resolve: { ok: false, detail: 'no dispatch binding for session-dead' } })
    const outcome = await runArchiveRelayChain({ sessionId: 'session-dead', reason: REASON, ports: fake.ports })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('spawn target unresolved')
    expect(fake.calls).toEqual(['verify', 'resolve'])
    expect(fake.archives).toEqual([])
  })

  it('stops before the spawn when the archive refuses', async () => {
    const fake = fakePorts({ archive: { ok: false, detail: 'http 409: already archived' } })
    const outcome = await runArchiveRelayChain({ sessionId: 'session-dead', reason: REASON, ports: fake.ports })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('archive refused')
    expect(fake.calls).toEqual(['verify', 'resolve', 'archive'])
    expect(fake.spawns).toEqual([])
  })

  it('reports loudly when the spawn fails after the archive (archived, no relay)', async () => {
    const fake = fakePorts({ spawn: { ok: false, detail: 'dispatch http 409: taskRef alive' } })
    const outcome = await runArchiveRelayChain({ sessionId: 'session-dead', reason: REASON, ports: fake.ports })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('spawn failed after archive (session archived, no relay)')
    expect(fake.calls).toEqual(['verify', 'resolve', 'archive', 'spawn'])
    expect(fake.updates).toEqual([])
  })

  it('keeps the chain green when only the reason rewrite fails (best-effort step)', async () => {
    const fake = fakePorts({ update: { ok: false, detail: 'override http 500' } })
    const outcome = await runArchiveRelayChain({ sessionId: 'session-dead', reason: REASON, ports: fake.ports })
    expect(outcome.ok).toBe(true)
    expect(outcome.relaySessionId).toBe('session-relay-1')
    expect(outcome.detail).toContain('reason-update=override http 500')
  })

  it('converts a throwing port into a failed outcome instead of an escape', async () => {
    const fake = fakePorts()
    fake.ports.verifyTranscript = async () => {
      fake.calls.push('verify')
      throw new Error('ledger read blew up')
    }
    const outcome = await runArchiveRelayChain({ sessionId: 'session-dead', reason: REASON, ports: fake.ports })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('verify threw')
    expect(fake.calls).toEqual(['verify'])
    expect(fake.archives).toEqual([])
  })
})

describe('loopback actor identity', () => {
  it('names the channel actor the archive identity gate resolves to human class', () => {
    expect(RELAY_ACTOR).toBe('dsh-session-revive')
    // A session-id-shaped actor would be read as a session; this one must not be.
    expect(RELAY_ACTOR.startsWith('session-')).toBe(false)
  })
})
