/**
 * revive-askcard-skip-1127 ask-card gate: a session whose tail still holds an
 * unsettled ask card is never nudged — `onReviveDecision` and `releaseDue`
 * both defer with their own reason, `releaseDue` parks in re-check cycles, and
 * the decision opens on the first cycle after the card settles. The reader is
 * the sync, fail-closed view of the user-questions projection cache the shell
 * injects: an unreadable projection is not "no card", so it parks too.
 *
 * test-standards-allow: gate fixtures over a synthetic projection cache — role-titled BDD names are fiction for a state machine's wake gate, the
 * same rationale the gate's own header gives the scripts/ lane.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STAGGER_MIN_MS } from '../src/config.ts'
import { makeAskPendingReader } from '../src/ask-pending.ts'
import { RevivalPolicy, type DecisionRecord, type PolicyRecord } from '../src/policy.ts'
import { ReviveV2Machine, type V2Record } from '../src/v2-machine.ts'
import type { TranscriptFirstGate } from '../src/v2-transcript.ts'

/** Fixed epoch so every arithmetic in the expectations is exact. */
const T0 = 1_760_000_000_000
const MIN = 60_000
/** The parked re-check cadence (FSM_RECHECK_MS in v2-machine). */
const RECHECK = 60_000
const SESSION = 'session-s'

const GATE: TranscriptFirstGate = { ok: true, detail: 'archived transcript readable: session-s frames=2 events=9' }

/** One unsettled card exactly as the projection folds it (`open` state). */
const ACTIVE_CARD = [
  {
    callId: 'call_1',
    questions: [
      { id: 'q1', question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: 'first' }] },
    ],
    state: 'open',
  },
]

/** One projection-cache file exactly as the harness writes it. */
function projectionFile(active: unknown): unknown {
  return {
    version: 7,
    record: {
      identity: { createdAt: T0, cwd: 'D:/tech' },
      rows: {
        userQuestions: {
          ver: 2,
          seq: 4,
          val: { inheritedEventCount: 0, timed: true, questions: { active, settled: [] } },
        },
      },
    },
  }
}

/** Scratch cache directory: the single seam every fixture writes through. */
function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ask-pending-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Write one session's cache file (a string payload lands verbatim, for corruption cases). */
function writeCache(dir: string, sessionId: string, payload: unknown): void {
  writeFileSync(join(dir, `${sessionId}.json`), typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
}

/** Green-path preamble: a named route whose probe result is cached green. */
function greenPath(m: ReviveV2Machine): void {
  m.setRoute({ provider: 'p', model: 'm' })
  m.onProbeResult('p', { ok: true })
}

/**
 * A machine wired to the reader under test, on one injected clock so the
 * reader's TTL and the machine's re-check cycles move together.
 * @param dir - the projection-cache directory the reader reads.
 * @returns the machine and the shared clock.
 */
function harness(dir: string): { m: ReviveV2Machine; clock: { value: number } } {
  const clock = { value: T0 }
  const m = new ReviveV2Machine({
    gate: GATE,
    resolveBaseURL: (route) => `https://api.example.com/${route.provider}`,
    now: () => clock.value,
    askPending: makeAskPendingReader({ dir, now: () => clock.value }),
  })
  greenPath(m)
  return { m, clock }
}

function kinds(records: readonly V2Record[]): string[] {
  return records.map((record) => record.kind)
}

/** The one revive decision a policy batch carries. */
function reviveDecision(records: PolicyRecord[]): DecisionRecord {
  const list = records.filter((record): record is DecisionRecord => record.kind === 'decision' && record.action === 'revive')
  expect(list).toHaveLength(1)
  return list[0]
}

describe('ask-card gate — onReviveDecision defers an unsettled card and opens no attempt', () => {
  it('defers a pending-card session with why=ask-pending while every other gate is green', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, SESSION, projectionFile(ACTIVE_CARD))
      const { m } = harness(dir)
      const records = m.onReviveDecision({ sessionId: SESSION, at: T0, plannedAt: T0 })
      expect(records).toEqual([{ kind: 'v2-gate', at: T0, sessionId: SESSION, verdict: 'defer', why: 'ask-pending' }])
      expect(kinds(records)).not.toContain('v2-attempt')
    } finally {
      cleanup()
    }
  })

  it('parks fail-closed with why=ask-unknown when the projection cannot be read at all', () => {
    const { dir, cleanup } = scratch()
    try {
      const { m } = harness(dir)
      const records = m.onReviveDecision({ sessionId: SESSION, at: T0, plannedAt: T0 })
      expect(records).toEqual([{ kind: 'v2-gate', at: T0, sessionId: SESSION, verdict: 'defer', why: 'ask-unknown' }])
      expect(kinds(records)).not.toContain('v2-attempt')
    } finally {
      cleanup()
    }
  })

  it('opens the attempt for a session whose card already settled', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, SESSION, projectionFile([]))
      const { m } = harness(dir)
      const records = m.onReviveDecision({ sessionId: SESSION, at: T0, plannedAt: T0 })
      expect(kinds(records)).toContain('v2-attempt')
    } finally {
      cleanup()
    }
  })

  it('keeps the legacy path untouched when no projection authority is injected', () => {
    const clock = { value: T0 }
    const m = new ReviveV2Machine({
      gate: GATE,
      resolveBaseURL: (route) => `https://api.example.com/${route.provider}`,
      now: () => clock.value,
    })
    greenPath(m)
    const records = m.onReviveDecision({ sessionId: SESSION, at: T0, plannedAt: T0 })
    expect(kinds(records)).toContain('v2-attempt')
  })
})

describe('ask-card gate — releaseDue parks in re-check cycles and releases on settlement', () => {
  it('never opens an attempt while the card is open, then opens on the first cycle after it settles', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, SESSION, projectionFile(ACTIVE_CARD))
      const { m, clock } = harness(dir)
      m.onReviveDecision({ sessionId: SESSION, at: T0, plannedAt: T0 })

      // Given a decision already parked by the gate, when the wake timer fires
      // on its deadline, then the release pushes the re-check out instead of
      // opening an attempt.
      clock.value = T0
      expect(m.releaseDue(clock.value)).toEqual([
        { kind: 'v2-gate', at: T0, sessionId: SESSION, verdict: 'defer', why: 'ask-pending' },
      ])
      clock.value = T0 + RECHECK
      expect(m.releaseDue(clock.value)).toEqual([
        { kind: 'v2-gate', at: T0 + RECHECK, sessionId: SESSION, verdict: 'defer', why: 'ask-pending' },
      ])
      // Ten minutes of cycles later: still never one attempt.
      clock.value = T0 + 10 * MIN
      expect(kinds(m.releaseDue(clock.value))).not.toContain('v2-attempt')

      // The card settles (answered or explicitly skipped): active empties.
      writeCache(dir, SESSION, projectionFile([]))
      clock.value = T0 + 10 * MIN + RECHECK
      expect(kinds(m.releaseDue(clock.value))).toContain('v2-attempt')
    } finally {
      cleanup()
    }
  })

  it('parks fail-closed across cycles while the projection stays unreadable', () => {
    const { dir, cleanup } = scratch()
    try {
      const { m, clock } = harness(dir)
      m.onReviveDecision({ sessionId: SESSION, at: T0, plannedAt: T0 })
      clock.value = T0 + RECHECK
      const records = m.releaseDue(clock.value)
      expect(records).toEqual([
        { kind: 'v2-gate', at: T0 + RECHECK, sessionId: SESSION, verdict: 'defer', why: 'ask-unknown' },
      ])
      expect(kinds(records)).not.toContain('v2-attempt')
    } finally {
      cleanup()
    }
  })
})

describe('ask-card gate — every wake route shares the one predicate', () => {
  it('defers the event-driven detect decision for a pending-card session', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, SESSION, projectionFile(ACTIVE_CARD))
      const { m } = harness(dir)
      const policy = new RevivalPolicy({ staggerMs: STAGGER_MIN_MS })
      const decision = reviveDecision(policy.onError({ sessionId: SESSION, code: 'TRANSPORT', at: T0 }))
      const records = m.onReviveDecision({
        sessionId: decision.sessionId,
        at: T0,
        plannedAt: decision.plannedAt ?? T0,
        ...(decision.code === undefined ? {} : { code: decision.code }),
      })
      expect(records).toEqual([{ kind: 'v2-gate', at: T0, sessionId: SESSION, verdict: 'defer', why: 'ask-pending' }])
      expect(kinds(records)).not.toContain('v2-attempt')
    } finally {
      cleanup()
    }
  })

  it('defers the boot-sweep decision for a pending-card session', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, SESSION, projectionFile(ACTIVE_CARD))
      const { m } = harness(dir)
      const policy = new RevivalPolicy({ staggerMs: STAGGER_MIN_MS })
      const decision = reviveDecision(policy.onBootSweep({ sessionId: SESSION, at: T0 }))
      const records = m.onReviveDecision({
        sessionId: decision.sessionId,
        at: T0,
        plannedAt: decision.plannedAt ?? T0,
        ...(decision.code === undefined ? {} : { code: decision.code }),
      })
      expect(records).toEqual([{ kind: 'v2-gate', at: T0, sessionId: SESSION, verdict: 'defer', why: 'ask-pending' }])
      expect(kinds(records)).not.toContain('v2-attempt')
    } finally {
      cleanup()
    }
  })

  it('lets the same two decisions through untouched once the card has settled', () => {
    const { dir, cleanup } = scratch()
    try {
      // Two sessions, one per route: an attempt left in flight by the first
      // route would deny the second one on attempt-in-flight.
      const swept = 'session-swept'
      writeCache(dir, SESSION, projectionFile([]))
      writeCache(dir, swept, projectionFile([]))
      const { m } = harness(dir)
      const policy = new RevivalPolicy({ staggerMs: STAGGER_MIN_MS })

      const errorDecision = reviveDecision(policy.onError({ sessionId: SESSION, code: 'TRANSPORT', at: T0 }))
      const errorRecords = m.onReviveDecision({
        sessionId: errorDecision.sessionId,
        at: T0,
        plannedAt: errorDecision.plannedAt ?? T0,
      })
      expect(kinds(errorRecords)).toContain('v2-attempt')

      // The sweep rides the global stagger slot, so it fires one slot after
      // the error decision's — read it at that time or the release defers on
      // cooldown before the card predicate is ever reached.
      const sweepDecision = reviveDecision(policy.onBootSweep({ sessionId: swept, at: T0 + MIN }))
      const sweepRecords = m.onReviveDecision({
        sessionId: sweepDecision.sessionId,
        at: T0 + MIN,
        plannedAt: sweepDecision.plannedAt ?? T0 + MIN,
        ...(sweepDecision.code === undefined ? {} : { code: sweepDecision.code }),
      })
      expect(kinds(sweepRecords)).toContain('v2-attempt')
    } finally {
      cleanup()
    }
  })
})

describe('ask-pending reader — sync fail-closed view of the projection cache', () => {
  it('reads pending for an active card in either open or continued state', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, SESSION, projectionFile(ACTIVE_CARD))
      writeCache(dir, 'session-cont', projectionFile([{ callId: 'call_2', questions: [], state: 'continued' }]))
      const read = makeAskPendingReader({ dir })
      expect(read(SESSION)).toBe('pending')
      expect(read('session-cont')).toBe('pending')
    } finally {
      cleanup()
    }
  })

  it('reads clear when the projection proves the active list is empty', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, SESSION, projectionFile([]))
      expect(makeAskPendingReader({ dir })(SESSION)).toBe('clear')
    } finally {
      cleanup()
    }
  })

  it('fails closed when the session has no cache file', () => {
    const { dir, cleanup } = scratch()
    try {
      expect(makeAskPendingReader({ dir })(SESSION)).toBe('unknown')
    } finally {
      cleanup()
    }
  })

  it('fails closed when the cache file is corrupt', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, SESSION, '{not json')
      expect(makeAskPendingReader({ dir })(SESSION)).toBe('unknown')
    } finally {
      cleanup()
    }
  })

  it('fails closed when the file parses but carries no user-questions row', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, SESSION, { version: 7, record: { rows: { title: { ver: 1, seq: 1, val: 't' } } } })
      expect(makeAskPendingReader({ dir })(SESSION)).toBe('unknown')
    } finally {
      cleanup()
    }
  })

  it('fails closed for a session id with no cache file to resolve', () => {
    const { dir, cleanup } = scratch()
    try {
      expect(makeAskPendingReader({ dir })('')).toBe('unknown')
    } finally {
      cleanup()
    }
  })

  it('reads the cache under either id spelling, canonical first', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', projectionFile(ACTIVE_CARD))
      writeCache(dir, 'session-11111111-2222-3333-4444-555555555555', projectionFile([]))
      const read = makeAskPendingReader({ dir })
      expect(read('session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe('pending')
      expect(read('11111111-2222-3333-4444-555555555555')).toBe('clear')
    } finally {
      cleanup()
    }
  })

  it('serves one file read per TTL window (gate bursts share the snapshot)', () => {
    const { dir, cleanup } = scratch()
    try {
      writeCache(dir, SESSION, projectionFile(ACTIVE_CARD))
      const clock = { value: 0 }
      const read = makeAskPendingReader({ dir, now: () => clock.value })
      expect(read(SESSION)).toBe('pending')
      // Within the TTL the settlement is invisible (cached snapshot).
      writeCache(dir, SESSION, projectionFile([]))
      clock.value = 999
      expect(read(SESSION)).toBe('pending')
      // Past the TTL the next gate call re-reads.
      clock.value = 1_000
      expect(read(SESSION)).toBe('clear')
    } finally {
      cleanup()
    }
  })
})
