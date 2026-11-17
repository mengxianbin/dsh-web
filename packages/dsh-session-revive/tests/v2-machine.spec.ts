import { describe, expect, it } from 'vitest'
import { PROBE_MIN_INTERVAL_MS, PROBE_RED_ALARM_MS } from '../src/v2-probe.ts'
import {
  RELAY_DEPTH_LIMIT,
  V2_COOLDOWN_MS,
  ZERO_COST_STRIKE_LIMIT,
  ReviveV2Machine,
  type V2Record,
} from '../src/v2-machine.ts'
import type { TranscriptFirstGate } from '../src/v2-transcript.ts'

/** Fixed epoch so every arithmetic in the expectations is exact. */
const T0 = 1_760_000_000_000
const MIN = 60_000

/** Machine harness: a controlled clock and the injected ports. */
function machine(
  options: { gateOk?: boolean; resolve?: (route: { provider: string; model?: string }) => string | undefined } = {},
): { m: ReviveV2Machine; clock: { value: number } } {
  const clock = { value: T0 }
  const gate: TranscriptFirstGate =
    options.gateOk === false
      ? { ok: false, detail: 'archived transcript unreadable (session-x): bad-frames:1' }
      : { ok: true, detail: 'archived transcript readable: session-x frames=2 events=9' }
  const m = new ReviveV2Machine({
    gate,
    resolveBaseURL: options.resolve ?? ((route) => `https://api.example.com/${route.provider}`),
    now: () => clock.value,
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

describe('fail-closed first gate (construction verdict, precedes every attempt)', () => {
  it('halts every entry point while the gate is red and creates no state', () => {
    const { m } = machine({ gateOk: false })
    m.setRoute({ provider: 'p' })
    m.onProbeResult('p', { ok: true })
    expect(kinds(m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 }))).toEqual(['v2-halt'])
    expect(kinds(m.onDeath({ sessionId: 'S', at: T0 }))).toEqual(['v2-halt'])
    expect(m.releaseDue(T0)).toEqual([])
    expect(m.routesNeedingProbe(T0)).toEqual([])
    expect(Object.keys(m.stateSnapshot().sessions)).toEqual([])
  })
})

describe('transfer table row 1: probe red parks the revive decision', () => {
  it('parks with zero attempts, re-probes on the 60-120s cadence, and opens on green', () => {
    const { m, clock } = machine()
    m.setRoute({ provider: 'p' })
    m.onProbeResult('p', { ok: false, error: 'ECONNREFUSED' })
    const parked = m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 })
    expect(kinds(parked)).toEqual(['v2-gate'])
    expect(parked[0]).toMatchObject({ verdict: 'defer', why: 'probe-red' })
    expect(m.stateSnapshot().sessions['S']).toMatchObject({ probe: 'parked' })
    expect(m.stateSnapshot().sessions['S'].probeRedSince).not.toBeNull()
    // No attempt while red: release stays silent however long we wait.
    clock.value = T0 + 10 * MIN
    expect(m.releaseDue(clock.value)).toEqual([])
    // Re-probe cadence: silent before the 60s floor, live at/after it.
    expect(m.routesNeedingProbe(T0)).toEqual([])
    expect(m.routesNeedingProbe(T0 + PROBE_MIN_INTERVAL_MS)).toMatchObject([
      { provider: 'p', baseURL: 'https://api.example.com/p', immediate: false },
    ])
    // Green flips the parked decision open (its deadline long passed).
    const released = m.onProbeResult('p', { ok: true })
    expect(kinds(released)).toContain('v2-attempt')
    expect(m.stateSnapshot().sessions['S']).toMatchObject({ probe: 'green', probeRedSince: null })
  })

  it('probes immediately when a parked route has no cached result yet', () => {
    const { m } = machine()
    m.setRoute({ provider: 'p' })
    const parked = m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 })
    expect(parked[0]).toMatchObject({ verdict: 'defer', why: 'probe-pending' })
    expect(m.routesNeedingProbe(T0)).toMatchObject([
      { provider: 'p', baseURL: 'https://api.example.com/p', immediate: true },
    ])
    expect(m.releaseDue(T0)).toEqual([])
    expect(m.nextWakeAt()).toBe(T0)
  })

  it('fails closed when the route has no resolvable base URL (attribution target)', () => {
    const { m } = machine({ resolve: () => undefined })
    m.setRoute({ provider: 'p' })
    m.onProbeResult('p', { ok: false, error: 'down' })
    expect(m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 })[0]).toMatchObject({ why: 'probe-red' })
    expect(m.routesNeedingProbe(T0 + PROBE_MIN_INTERVAL_MS)).toMatchObject([
      { provider: 'p', baseURL: undefined },
    ])
  })

  it('raises probeRedAlarmed once a red run outlives N, and only once', () => {
    const { m, clock } = machine()
    m.setRoute({ provider: 'p' })
    m.onProbeResult('p', { ok: false, error: 'down' })
    expect(m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 })[0]).toMatchObject({ why: 'probe-red' })
    clock.value = T0 + PROBE_RED_ALARM_MS
    expect(kinds(m.onProbeResult('p', { ok: false, error: 'down' }))).not.toContain('v2-alarm')
    clock.value = T0 + PROBE_RED_ALARM_MS + 1
    expect(kinds(m.onProbeResult('p', { ok: false, error: 'down' }))).toContain('v2-alarm')
    clock.value = T0 + PROBE_RED_ALARM_MS + 2_000
    expect(kinds(m.onProbeResult('p', { ok: false, error: 'down' }))).not.toContain('v2-alarm')
    expect(m.stateSnapshot().sessions['S'].probeRedAlarmed).toBe(true)
  })
})

describe('transfer table row 2: 0-token failures strike and three strikes stop', () => {
  it('cools down per strike and stops with the false-green attribution on the third', () => {
    const { m, clock } = machine()
    greenPath(m)
    let open = m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    for (let strike = 1; strike <= ZERO_COST_STRIKE_LIMIT; strike += 1) {
      expect(kinds(open)).toContain('v2-attempt')
      clock.value += 1_000
      const died = m.onDeath({ sessionId: 'S', at: clock.value })
      expect(died[0]).toMatchObject({ kind: 'v2-failure', form: 'zero-token', zeroCostStrikes: strike })
      if (strike < ZERO_COST_STRIKE_LIMIT) {
        const deferred = m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
        expect(deferred[0]).toMatchObject({
          kind: 'v2-gate',
          why: 'cooldown',
          fireAt: clock.value + V2_COOLDOWN_MS,
        })
        expect(m.releaseDue(clock.value)).toEqual([])
        clock.value += V2_COOLDOWN_MS
        open = m.releaseDue(clock.value)
        expect(open[0]).toMatchObject({ kind: 'v2-attempt', channel: 'zero-cost' })
      } else {
        expect(died[1]).toMatchObject({
          kind: 'v2-stop',
          stopped: 'zero-cost-3strike',
          attribution: 'probe-false-green-or-classification-anomaly',
        })
      }
    }
    // Stopped: nothing ever opens again, on any channel.
    expect(m.onReviveDecision({ sessionId: 'S', at: clock.value + 10 * MIN, plannedAt: clock.value })[0]).toMatchObject({
      why: 'stopped',
    })
    expect(m.releaseDue(clock.value + 10 * MIN)).toEqual([])
    expect(m.stateSnapshot().sessions['S'].stopped).toBe('zero-cost-3strike')
  })
})

describe('transfer table row 3: spend without progress archives and relays', () => {
  it('emits the structured archive-relay intent and denies attempts while relaying', () => {
    const { m, clock } = machine()
    greenPath(m)
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    // Spend lands (input billed) but no output block and no tool result: no progress.
    m.onAssistant('S', { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0 })
    clock.value += 1_000
    const died = m.onDeath({ sessionId: 'S', at: clock.value })
    expect(died[0]).toMatchObject({ kind: 'v2-failure', form: 'spend-no-progress', tokens: 500 })
    expect(died[1]).toMatchObject({
      kind: 'v2-archive-relay',
      reason: {
        code: 'revive-failed-spend-no-progress',
        tokens: 500,
        form: 'spend-no-progress',
        from: expect.any(Number),
        to: clock.value,
      },
    })
    expect(m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })[0]).toMatchObject({
      why: 'relay-chain',
    })
    const chain = m.onChainResult({ sessionId: 'S', ok: true, relaySessionId: 'session-relay-1' })
    expect(chain[0]).toMatchObject({ kind: 'v2-chain', ok: true, relaySessionId: 'session-relay-1' })
    expect(m.stateSnapshot().sessions['S']).toMatchObject({
      relaySessionId: 'session-relay-1',
      relayDepth: RELAY_DEPTH_LIMIT,
    })
  })

  it('stops a relay generation that repeats the failure (relay-recidive), keeping the scene', () => {
    const { m, clock } = machine()
    greenPath(m)
    // The source session's chain stamps the successor with depth 1.
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    m.onAssistant('S', { inputTokens: 700 })
    clock.value += 1_000
    m.onDeath({ sessionId: 'S', at: clock.value })
    m.onChainResult({ sessionId: 'S', ok: true, relaySessionId: 'session-relay-1' })
    // The relay session runs and fails the same way.
    expect(m.onReviveDecision({ sessionId: 'session-relay-1', at: clock.value, plannedAt: clock.value })[0]).toMatchObject({
      kind: 'v2-attempt',
    })
    m.onAssistant('session-relay-1', { inputTokens: 300 })
    clock.value += 1_000
    const died = m.onDeath({ sessionId: 'session-relay-1', at: clock.value })
    expect(died[0]).toMatchObject({ kind: 'v2-failure', form: 'spend-no-progress' })
    expect(died[1]).toMatchObject({ kind: 'v2-stop', stopped: 'relay-recidive' })
    expect(m.stateSnapshot().sessions['session-relay-1']).toMatchObject({
      relayDepth: RELAY_DEPTH_LIMIT,
      stopped: 'relay-recidive',
    })
  })
})

describe('transfer table row 4: spend with progress grants one retry, then stops', () => {
  it('cools down, releases the granted retry on the progress channel, and stops in place on re-failure', () => {
    const { m, clock } = machine()
    greenPath(m)
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    m.onAssistant('S', { inputTokens: 100, outputTokens: 50 })
    clock.value += 1_000
    const died = m.onDeath({ sessionId: 'S', at: clock.value })
    expect(died).toHaveLength(1)
    expect(died[0]).toMatchObject({ kind: 'v2-failure', form: 'spend-progress', tokens: 150 })
    const deferred = m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    expect(deferred[0]).toMatchObject({
      kind: 'v2-gate',
      why: 'cooldown',
      fireAt: clock.value + V2_COOLDOWN_MS,
    })
    clock.value += V2_COOLDOWN_MS
    const retry = m.releaseDue(clock.value)
    expect(retry[0]).toMatchObject({ kind: 'v2-attempt', channel: 'progress-retry' })
    // The granted retry spends and fails again: stop in place, never relay.
    m.onAssistant('S', { inputTokens: 100, outputTokens: 50 })
    clock.value += 1_000
    const diedAgain = m.onDeath({ sessionId: 'S', at: clock.value })
    expect(diedAgain[0]).toMatchObject({ kind: 'v2-failure', form: 'spend-progress' })
    expect(diedAgain[1]).toMatchObject({ kind: 'v2-stop', stopped: 'progress-retry-failed' })
    expect(m.stateSnapshot().sessions['S'].stopped).toBe('progress-retry-failed')
  })

  it('triage discipline: a granted retry that dies 0-token rejoins the zero-cost channel', () => {
    const { m, clock } = machine()
    greenPath(m)
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    m.onAssistant('S', { inputTokens: 100, outputTokens: 50 })
    clock.value += 1_000
    m.onDeath({ sessionId: 'S', at: clock.value }) // spend-progress -> retry granted
    // The ruled account re-decides after the death: the gate parks it on cooldown.
    expect(m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })[0]).toMatchObject({
      why: 'cooldown',
      fireAt: clock.value + V2_COOLDOWN_MS,
    })
    clock.value += V2_COOLDOWN_MS
    expect(m.releaseDue(clock.value)[0]).toMatchObject({ channel: 'progress-retry' })
    // The retry spends NOTHING: the actual form wins over the granted channel.
    clock.value += 1_000
    const died = m.onDeath({ sessionId: 'S', at: clock.value })
    expect(died).toHaveLength(1)
    expect(died[0]).toMatchObject({ kind: 'v2-failure', form: 'zero-token', zeroCostStrikes: 1 })
    const row = m.stateSnapshot().sessions['S']
    expect(row.stopped).toBeNull()
    expect(row.zeroCostStrikes).toBe(1)
    expect(m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })[0]).toMatchObject({
      why: 'cooldown',
    })
  })
})

describe('transfer table row 5: a completed turn clears every counter', () => {
  it('clears a dirty account and opens the next decision fresh', () => {
    const { m, clock } = machine()
    greenPath(m)
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    clock.value += 1_000
    m.onDeath({ sessionId: 'S', at: clock.value }) // zero-token strike 1
    expect(m.stateSnapshot().sessions['S'].zeroCostStrikes).toBe(1)
    const cleared = m.onSuccessTurn('S', clock.value)
    expect(kinds(cleared)).toEqual(['v2-clear'])
    expect(m.stateSnapshot().sessions['S']).toMatchObject({
      zeroCostStrikes: 0,
      relayDepth: 0,
      progressRetry: 0,
      stopped: null,
      lastFailureAt: null,
      lastFailureForm: null,
      lastFailureTokens: 0,
      episodeSpentTokens: 0,
      relaySessionId: null,
      probeRedSince: null,
      probeRedAlarmed: false,
      lastSuccessAt: clock.value,
    })
    expect(m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })[0]).toMatchObject({
      kind: 'v2-attempt',
      channel: 'fresh',
    })
  })

  it('success never creates state for a session that has none', () => {
    const { m } = machine()
    expect(m.onSuccessTurn('unknown-session', T0)).toEqual([])
    expect(Object.keys(m.stateSnapshot().sessions)).toEqual([])
  })
})

describe('progress boolean (two-level, section three)', () => {
  it('counts tool activity as the L1/L2 halves when the output block is absent', () => {
    const { m, clock } = machine()
    greenPath(m)
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    m.onAssistant('S', { inputTokens: 100, outputTokens: 0 })
    m.onActivity('S', 'tool-call')
    m.onActivity('S', 'tool-ok')
    clock.value += 1_000
    const died = m.onDeath({ sessionId: 'S', at: clock.value })
    expect(died[0]).toMatchObject({ kind: 'v2-failure', form: 'spend-progress' })
  })

  it('never counts a refusal output as progress', () => {
    const { m, clock } = machine()
    greenPath(m)
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    m.onAssistant('S', { inputTokens: 10, outputTokens: 10, refusal: true })
    clock.value += 1_000
    const died = m.onDeath({ sessionId: 'S', at: clock.value })
    expect(died[0]).toMatchObject({ kind: 'v2-failure', form: 'spend-no-progress' })
  })
})

describe('gate disciplines around attempts', () => {
  it('denies a second decision while an attempt is in flight, and recovers after a withheld send', () => {
    const { m, clock } = machine()
    greenPath(m)
    expect(m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })[0]).toMatchObject({
      kind: 'v2-attempt',
    })
    expect(m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })[0]).toMatchObject({
      why: 'attempt-in-flight',
    })
    m.onAttemptWithheld('S')
    expect(m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })[0]).toMatchObject({
      kind: 'v2-attempt',
    })
  })

  it('parks fail-closed while no route is known', () => {
    const { m } = machine()
    expect(m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 })[0]).toMatchObject({
      verdict: 'defer',
      why: 'route-unknown',
    })
  })

  it('holds a staggered decision until its planned time even on a green path', () => {
    const { m, clock } = machine()
    greenPath(m)
    const deferred = m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 + 5 * MIN })
    expect(deferred[0]).toMatchObject({ why: 'cooldown', fireAt: T0 + 5 * MIN })
    expect(m.nextWakeAt()).toBe(T0 + 5 * MIN)
    expect(m.releaseDue(T0 + 5 * MIN - 1)).toEqual([])
    expect(kinds(m.releaseDue(T0 + 5 * MIN))).toContain('v2-attempt')
  })

  it('drops the in-flight attempt on disposal but keeps the account', () => {
    const { m, clock } = machine()
    greenPath(m)
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    m.onDisposed('S')
    // No stuck attempt-in-flight: the next decision opens again.
    expect(m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })[0]).toMatchObject({
      kind: 'v2-attempt',
    })
  })

  it('clears an in-flight attempt on success too (no denial after a completed turn)', () => {
    const { m, clock } = machine()
    greenPath(m)
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    m.onSuccessTurn('S', clock.value)
    expect(m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })[0]).toMatchObject({
      kind: 'v2-attempt',
      channel: 'fresh',
    })
  })
})

describe('section-seven export shape', () => {
  it('carries { at, sessions } and exactly the bilateral per-session field set', () => {
    const { m, clock } = machine()
    greenPath(m)
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value })
    m.onAssistant('S', { inputTokens: 42 })
    clock.value += 1_000
    m.onDeath({ sessionId: 'S', at: clock.value })
    const doc = m.stateSnapshot()
    expect(Object.keys(doc).sort()).toEqual(['at', 'sessions'])
    expect(Object.keys(doc.sessions['S']).sort()).toEqual(
      [
        'episodeSpentTokens',
        'lastFailureAt',
        'lastFailureForm',
        'lastFailureTokens',
        'lastSuccessAt',
        'probe',
        'probeRedAlarmed',
        'probeRedSince',
        'progressRetry',
        'relayDepth',
        'relaySessionId',
        'stopped',
        'zeroCostStrikes',
      ].sort(),
    )
  })
})
