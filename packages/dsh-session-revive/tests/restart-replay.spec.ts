/**
 * Acceptance fixture (revive-restart-gap-1126, design §4.2 rules one + two).
 *
 * 正态 — an error-closed session whose revive decision was deferred by the
 * v2 gate (pending) must survive a simulated plugin reload: the ledger
 * replays idempotently, the boot sweep re-admits the closed-error row
 * through the zero-quota channel, and EXACTLY ONE attempt re-releases the
 * session with the detect → decision → attempt chain intact (the 2026-11-26
 * incident shape: defer → UI restart → pending evaporated → manual continue).
 *
 * 反态 — a closed NON-error turn is never swept: the screen says closed, so
 * the row is never even read (no IO, no decide).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { refineFailureCode } from '../src/config.ts'
import { RevivePendingWriter, REVIVE_PENDING_FILE, readPendingEntries } from '../src/pending-state.ts'
import { RevivalPolicy, type LogRecord, type PolicyRecord } from '../src/policy.ts'
import { runBootSweep, type BootSweepDeps, type SweepRow } from '../src/sweep.ts'
import { ReviveV2Machine, type V2Record } from '../src/v2-machine.ts'
import type { TranscriptFirstGate } from '../src/v2-transcript.ts'

/** Fixed epoch so every arithmetic in the expectations is exact. */
const T0 = 1_760_000_000_000
const GATE: TranscriptFirstGate = { ok: true, detail: 'archived transcript readable: S frames=2 events=9' }

const homes: string[] = []

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revive-restart-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Machine harness with a controlled clock (same shape as v2-machine.spec). */
function machine(): { m: ReviveV2Machine; clock: { value: number } } {
  const clock = { value: T0 }
  const m = new ReviveV2Machine({
    gate: GATE,
    resolveBaseURL: (route) => `https://api.example.com/${route.provider}`,
    now: () => clock.value,
  })
  return { m, clock }
}

function ev(type: string, data: Record<string, unknown> = {}): SessionEvent {
  return { seq: 1, time: 0, type, data } as unknown as SessionEvent
}

function row(sessionId: string, extra: Partial<SweepRow> = {}): SweepRow {
  return { sessionId, running: false, agentAvailable: false, ...extra }
}

/** Rule two's screen: checkpoint-proven closed with an `error` outcome projection. */
const TB_CLOSED_ERROR = {
  values: { turnBoundary: { openTurnStartSeq: null }, lastTurnOutcome: { kind: 'error', at: T0 } },
}
/** 反态's screen: checkpoint-proven closed with a `completed` outcome projection. */
const TB_CLOSED_COMPLETED = {
  values: { turnBoundary: { openTurnStartSeq: null }, lastTurnOutcome: { kind: 'completed', at: T0 } },
}

function isDecisionRevive(record: PolicyRecord): boolean {
  return record.kind === 'decision' && record.action === 'revive'
}

describe('正态: an error-closed + pending-deferred session survives a reload', () => {
  it('replays the ledger, re-admits the closed-error row, and re-releases EXACTLY ONE attempt (detect→decision→attempt)', async () => {
    const path = join(makeHome(), REVIVE_PENDING_FILE)

    // ── process 1: the death and the v2-gated deferred decision ──
    const policy1 = new RevivalPolicy({ staggerMs: 10_000 })
    const first = machine()
    const pre: PolicyRecord[] = policy1.onError({ sessionId: 'S', code: 'TRANSPORT', at: T0 })
    const decision = pre.find(
      (record): record is Extract<PolicyRecord, { kind: 'decision' }> => isDecisionRevive(record),
    )
    expect(decision, 'the ruled account must have decided revive').toBeDefined()
    // The folded request header is the route evidence the machine seeds.
    first.m.seedRoute('S', { provider: 'p', model: 'm' })
    const preGate: V2Record[] = first.m.onReviveDecision({
      sessionId: 'S',
      at: T0,
      plannedAt: decision?.plannedAt ?? T0,
      ...(decision?.code === undefined ? {} : { code: decision.code }),
    })
    // The incident's shape: deferred on the unprobed route — and this defer is
    // exactly what used to evaporate on restart.
    expect(preGate[0]).toMatchObject({ kind: 'v2-gate', verdict: 'defer', why: 'probe-pending' })

    // ── persist: the one decision-flip write (what applyV2 does) ──
    const writer1 = new RevivePendingWriter({ path })
    expect(writer1.sync(first.m.pendingSnapshot())).toBe(true)

    // ── simulated plugin reload: fresh policy + machine (in-memory gone) ──
    const read = readPendingEntries(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const restarted = machine()
    expect(restarted.m.restorePending(read.entries)).toBe(1)
    // Byte-identical round trip — the seeded writer replays at zero writes.
    expect(JSON.stringify(restarted.m.pendingSnapshot().sessions)).toBe(
      JSON.stringify(first.m.pendingSnapshot().sessions),
    )

    // ── activation boot sweep: rule two also admits this closed-error row ──
    const policy2 = new RevivalPolicy({ staggerMs: 10_000 })
    const post: PolicyRecord[] = []
    const postV2: V2Record[] = []
    const logs: LogRecord[] = []
    const applyRecords = (records: PolicyRecord[]): void => {
      post.push(...records)
      for (const record of records) {
        if (isDecisionRevive(record) && record.kind === 'decision') {
          postV2.push(
            ...restarted.m.onReviveDecision({
              sessionId: record.sessionId,
              at: T0,
              plannedAt: record.plannedAt ?? T0,
              ...(record.code === undefined ? {} : { code: record.code }),
            }),
          )
        }
      }
    }
    const deps: BootSweepDeps = {
      listRows: async () => [row('S', { projections: TB_CLOSED_ERROR })],
      readEvents: async () => [
        ev('turn/start'),
        ev('turn/end', { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed' } } }),
        ev('request/header', { header: { config: { provider: 'p', model: 'm' } } }),
      ],
      isAttached: () => false,
      seedRoute: (sessionId, route) => restarted.m.seedRoute(sessionId, route),
      // The shell binds the policy's ONE effective classification (refine first).
      reviveClass: (code, message) => policy2.revivable(refineFailureCode(code, message)),
      decide: (sessionId, at, contextTokens) => {
        if (contextTokens !== undefined) policy2.recordUsage(sessionId, contextTokens)
        return policy2.onBootSweep({ sessionId, at })
      },
      apply: applyRecords,
      log: (record) => logs.push(record),
      now: () => T0,
      signal: new AbortController().signal,
      retryMs: 1,
    }
    await runBootSweep(deps)
    // The sweep re-admitted the closed-error row through the zero-quota channel.
    expect(logs.find((record) => record.event === 'boot-sweep')?.detail).toMatchObject({
      rows: 1,
      candidates: 1,
      reads: 1,
      revived: 1,
      confirmedClosed: 0,
    })
    expect(post.some(isDecisionRevive)).toBe(true)

    // ── probe green: the deferred decision releases — EXACTLY ONE attempt ──
    postV2.push(...restarted.m.onProbeResult('p', { ok: true }))
    const attempts = [...preGate, ...postV2].filter((record) => record.kind === 'v2-attempt')
    expect(attempts).toHaveLength(1)
    // The chain survives the reload: detect → decision → attempt, all present.
    expect(pre.some((record) => record.kind === 'detect')).toBe(true)
    expect(pre.some(isDecisionRevive)).toBe(true)
    expect(attempts[0]).toMatchObject({ sessionId: 'S' })
    // The release consumed the pending: the ledger row drops change-only.
    expect(restarted.m.pendingSnapshot().sessions).toEqual({})
    const writer2 = new RevivePendingWriter({ path, seed: read.entries })
    expect(writer2.sync(restarted.m.pendingSnapshot())).toBe(true)
  })
})

describe('反态: a closed non-error turn is never swept', () => {
  it('is never read and never decided — the screen alone holds it closed', async () => {
    const reads: string[] = []
    const decided: string[] = []
    const logs: LogRecord[] = []
    const deps: BootSweepDeps = {
      listRows: async () => [row('done', { projections: TB_CLOSED_COMPLETED })],
      readEvents: async (sessionId) => {
        reads.push(sessionId)
        return []
      },
      isAttached: () => false,
      // Even a permissive classifier never sees it: the screen already said closed.
      reviveClass: () => true,
      decide: (sessionId) => {
        decided.push(sessionId)
        return []
      },
      apply: () => {},
      log: (record) => logs.push(record),
      now: () => T0,
      signal: new AbortController().signal,
      retryMs: 1,
    }
    await runBootSweep(deps)
    expect(reads).toEqual([])
    expect(decided).toEqual([])
    expect(logs.find((record) => record.event === 'boot-sweep')?.detail).toMatchObject({
      rows: 1,
      live: 0,
      closed: 1,
      candidates: 0,
      reads: 0,
      revived: 0,
      confirmedClosed: 0,
    })
    expect(logs.filter((record) => record.event === 'boot-sweep-failed')).toHaveLength(0)
  })
})
