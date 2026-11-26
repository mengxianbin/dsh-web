/**
 * §6.3 唤醒对账 frozen gate (freeze-reclaim-design-1127 Phase 1): a
 * frozen/locked session is never auto-woken. The machine gate defers with
 * `why: 'frozen'` (defer ≠ kill) and releaseDue parks the decision in 60s
 * re-check cycles until the session unfreezes; the reader is the sync,
 * fail-open view of `task-fsm-state.json` the shell injects.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFrozenSetReader } from '../src/fsm-frozen.ts'
import { ReviveV2Machine, type V2Record } from '../src/v2-machine.ts'
import type { TranscriptFirstGate } from '../src/v2-transcript.ts'

/** Fixed epoch so every arithmetic in the expectations is exact. */
const T0 = 1_760_000_000_000
const MIN = 60_000
/** The parked re-check cadence (FSM_RECHECK_MS in v2-machine). */
const RECHECK = 60_000

const GATE: TranscriptFirstGate = { ok: true, detail: 'archived transcript readable: session-s frames=2 events=9' }

function machine(frozen: () => ReadonlySet<string>): { m: ReviveV2Machine; clock: { value: number } } {
  const clock = { value: T0 }
  const m = new ReviveV2Machine({
    gate: GATE,
    resolveBaseURL: (route) => `https://api.example.com/${route.provider}`,
    now: () => clock.value,
    frozenSet: frozen,
  })
  return { m, clock }
}

function kinds(records: readonly V2Record[]): string[] {
  return records.map((record) => record.kind)
}

/** Green-path preamble: a named route whose probe result is cached green. */
function greenPath(m: ReviveV2Machine): void {
  m.setRoute({ provider: 'p', model: 'm' })
  m.onProbeResult('p', { ok: true })
}

describe('frozen gate — onReviveDecision defers with why=frozen and no attempt', () => {
  it('parks an otherwise-openable decision while the session is frozen', () => {
    const frozen = new Set(['session-s'])
    const { m } = machine(() => frozen)
    greenPath(m)
    const records = m.onReviveDecision({ sessionId: 'session-s', at: T0, plannedAt: T0 })
    expect(records).toEqual([{ kind: 'v2-gate', at: T0, sessionId: 'session-s', verdict: 'defer', why: 'frozen' }])
    expect(kinds(records)).not.toContain('v2-attempt')
  })

  it('releaseDue never opens an attempt while frozen — it parks in re-check cycles', () => {
    const frozen = new Set(['session-s'])
    const { m, clock } = machine(() => frozen)
    greenPath(m)
    m.onReviveDecision({ sessionId: 'session-s', at: T0, plannedAt: T0 })
    // Due immediately (plannedAt passed): the release pushes the re-check out.
    clock.value = T0
    const first = m.releaseDue(clock.value)
    expect(first).toEqual([{ kind: 'v2-gate', at: T0, sessionId: 'session-s', verdict: 'defer', why: 'frozen' }])
    // Next cycle at T0+60s: still frozen, still parked, still no attempt.
    clock.value = T0 + RECHECK
    const second = m.releaseDue(clock.value)
    expect(second).toEqual([
      { kind: 'v2-gate', at: T0 + RECHECK, sessionId: 'session-s', verdict: 'defer', why: 'frozen' },
    ])
    // Ten minutes of cycles later: never one attempt.
    clock.value = T0 + 10 * MIN
    expect(kinds(m.releaseDue(clock.value))).not.toContain('v2-attempt')
  })

  it('releases the parked decision on the first due wake after unfreezing', () => {
    const frozen = new Set(['session-s'])
    const { m, clock } = machine(() => frozen)
    greenPath(m)
    m.onReviveDecision({ sessionId: 'session-s', at: T0, plannedAt: T0 })
    clock.value = T0
    expect(kinds(m.releaseDue(clock.value))).toEqual(['v2-gate'])
    // E4 wake / human unfreeze: the authority stops naming the session.
    frozen.delete('session-s')
    clock.value = T0 + RECHECK
    const released = m.releaseDue(clock.value)
    expect(kinds(released)).toContain('v2-attempt')
  })

  it('an active session (empty frozen set) passes the gate untouched', () => {
    const { m } = machine(() => new Set<string>())
    greenPath(m)
    const records = m.onReviveDecision({ sessionId: 'session-s', at: T0, plannedAt: T0 })
    expect(kinds(records)).toContain('v2-attempt')
  })
})

/** Scratch state-file fixture: writes the payload, hands back its path. */
function fixture(state: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-frozen-'))
  const path = join(dir, 'task-fsm-state.json')
  writeFileSync(path, typeof state === 'string' ? state : JSON.stringify(state), 'utf8')
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('frozen reader — sync fail-open view of task-fsm-state.json', () => {
  it('collects frozen and locked sessions, skipping session-less and active rows', () => {
    const { path, cleanup } = fixture({
      tasks: {
        a: { session: { id: 'session-frozen', mode: 'frozen' } },
        b: { session: { id: 'session-locked', mode: 'locked' } },
        c: { session: { id: '', mode: 'frozen' } },
        d: { session: { id: 'session-active', mode: 'active' } },
      },
    })
    try {
      expect(makeFrozenSetReader({ path })()).toEqual(new Set(['session-frozen', 'session-locked']))
    } finally {
      cleanup()
    }
  })

  it('fails open to the empty set when the authority is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fsm-frozen-'))
    try {
      expect(makeFrozenSetReader({ path: join(dir, 'absent.json') })()).toEqual(new Set())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails open to the empty set when the authority is corrupt', () => {
    const { path, cleanup } = fixture('{not json')
    try {
      expect(makeFrozenSetReader({ path })()).toEqual(new Set())
    } finally {
      cleanup()
    }
  })

  it('serves one file read per TTL window (gate bursts share the snapshot)', () => {
    const { path, cleanup } = fixture({
      tasks: { a: { session: { id: 'session-frozen', mode: 'frozen' } } },
    })
    try {
      const clock = { value: 0 }
      const read = makeFrozenSetReader({ path, now: () => clock.value })
      expect(read()).toEqual(new Set(['session-frozen']))
      // Within the TTL the file change is invisible (cached snapshot).
      writeFileSync(path, JSON.stringify({ tasks: {} }), 'utf8')
      clock.value = 999
      expect(read()).toEqual(new Set(['session-frozen']))
      // Past the TTL the next gate call re-reads.
      clock.value = 1_000
      expect(read()).toEqual(new Set())
    } finally {
      cleanup()
    }
  })
})
