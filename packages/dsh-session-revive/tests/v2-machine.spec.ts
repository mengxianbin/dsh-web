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

  it('clears a boot decision once the sweep seeds the stored route', () => {
    const { m } = machine()
    m.seedRoute('S', { provider: 'p', model: 'm' })
    // Known but unprobed route: the gate parks on the probe, never on
    // route-unknown - the 2026-11-18 boot deadlock this seed closes.
    expect(m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 })[0]).toMatchObject({
      verdict: 'defer',
      why: 'probe-pending',
    })
    expect(m.routesNeedingProbe(T0)).toMatchObject([{ provider: 'p' }])
    // The green result itself releases the deferred decision (the shell sends
    // from the returned attempt record).
    expect(kinds(m.onProbeResult('p', { ok: true }))).toContain('v2-attempt')
    expect(m.releaseDue(T0)).toEqual([])
  })

  it('keeps the first route evidence when a later seed disagrees', () => {
    const { m } = machine()
    m.seedRoute('S', { provider: 'p1' })
    m.seedRoute('S', { provider: 'p2' })
    expect(m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 })[0]).toMatchObject({ why: 'probe-pending' })
    expect(m.routesNeedingProbe(T0)).toMatchObject([{ provider: 'p1' }])
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

describe('pending ledger export + idempotent replay (design §4.2 rule one)', () => {
  it('exports only sessions holding a deferred decision, with the full releaseDue input set', () => {
    const { m, clock } = machine()
    greenPath(m)
    // A session outside revival contributes nothing.
    m.onAssistant('other-session', { inputTokens: 1 })
    expect(m.pendingSnapshot()).toEqual({ at: T0, sessions: {} })
    // A probe-pending defer parks the decision.
    m.setRoute({ provider: 'q' })
    m.onReviveDecision({ sessionId: 'S', at: clock.value, plannedAt: clock.value + 5 * MIN, code: 'TRANSPORT' })
    const doc = m.pendingSnapshot()
    expect(Object.keys(doc).sort()).toEqual(['at', 'sessions'])
    expect(doc.sessions['S']).toEqual({
      plannedAt: clock.value + 5 * MIN,
      code: 'TRANSPORT',
      channel: 'fresh',
      route: { provider: 'q' },
      cooldownUntil: 0,
    })
    // An opened attempt clears the pending: nothing left to export.
    clock.value += 5 * MIN
    m.onProbeResult('q', { ok: true })
    expect(m.pendingSnapshot().sessions).toEqual({})
  })

  it('falls back to the durable route when the session has no evidence of its own', () => {
    const { m } = machine()
    m.setRoute({ provider: 'fallback' })
    // No route on the session yet: the release would use currentRoute, so the
    // ledger must carry it or the replay would park route-unknown forever.
    m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 })
    expect(m.pendingSnapshot().sessions['S'].route).toEqual({ provider: 'fallback' })
    // Route-unknown with no fallback at all: the entry carries no route — the
    // replay parks fail-closed exactly like the original defer did.
    const bare = machine()
    bare.m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 })
    expect(bare.m.pendingSnapshot().sessions['S'].route).toBeUndefined()
  })

  it('replays a persisted ledger into a fresh machine and round-trips byte-identically', () => {
    const { m } = machine()
    m.seedRoute('S', { provider: 'mimo', model: 'mimo-v2-flash' })
    m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 + 60_000, code: 'TIMEOUT' })
    const exported = m.pendingSnapshot()

    const restarted = machine()
    expect(restarted.m.restorePending(exported.sessions)).toBe(1)
    const replayed = restarted.m.pendingSnapshot()
    expect(replayed.sessions).toEqual(exported.sessions)
    // Byte-stable for the seeded writer's change-only comparison.
    expect(JSON.stringify(replayed.sessions)).toBe(JSON.stringify(exported.sessions))
  })

  it('is idempotent: a second replay of the same ledger changes nothing', () => {
    const { m } = machine()
    m.seedRoute('S', { provider: 'p' })
    m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0, code: 'TRANSPORT' })
    const exported = m.pendingSnapshot()
    // The replay targets a FRESH machine (the reload); the second pass over
    // the same ledger is a no-op, byte for byte.
    const restarted = machine()
    expect(restarted.m.restorePending(exported.sessions)).toBe(1)
    const after = JSON.stringify(restarted.m.pendingSnapshot().sessions)
    expect(restarted.m.restorePending(exported.sessions)).toBe(0)
    expect(JSON.stringify(restarted.m.pendingSnapshot().sessions)).toBe(after)
  })

  it('live-wins: a pending decided this boot is never clobbered by the replay', () => {
    const { m } = machine()
    m.seedRoute('S', { provider: 'p' })
    // This boot already deferred a FRESHER decision for S.
    m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 + 10_000, code: 'TIMEOUT' })
    const stale = { S: { plannedAt: T0 - 5_000, code: 'TRANSPORT', channel: 'zero-cost' as const, route: { provider: 'p' }, cooldownUntil: 0 } }
    expect(m.restorePending(stale)).toBe(0)
    expect(m.pendingSnapshot().sessions['S']).toMatchObject({ plannedAt: T0 + 10_000, code: 'TIMEOUT', channel: 'fresh' })
  })

  it('skips a session whose attempt is already in flight (no second queue)', () => {
    const { m } = machine()
    greenPath(m)
    m.onReviveDecision({ sessionId: 'S', at: T0, plannedAt: T0 })
    expect(m.stateSnapshot().sessions['S']).toBeDefined()
    const ledger = { S: { plannedAt: T0, channel: 'fresh' as const, cooldownUntil: 0 } }
    expect(m.restorePending(ledger)).toBe(0)
    expect(m.pendingSnapshot().sessions).toEqual({})
  })

  it('fails closed while the first gate is red: replays nothing and creates no state', () => {
    const { m } = machine({ gateOk: false })
    const ledger = { S: { plannedAt: T0, code: 'TRANSPORT', channel: 'fresh' as const, route: { provider: 'p' }, cooldownUntil: 0 } }
    expect(m.restorePending(ledger)).toBe(0)
    expect(Object.keys(m.stateSnapshot().sessions)).toEqual([])
    expect(m.pendingSnapshot().sessions).toEqual({})
  })

  it('restores the cooldown deadline and the attempt channel evidence', () => {
    const { m, clock } = machine()
    m.seedRoute('S', { provider: 'p' })
    const ledger = {
      S: { plannedAt: T0 - 1, code: 'TRANSPORT', channel: 'progress-retry' as const, route: { provider: 'p' }, cooldownUntil: T0 + 2 * MIN },
    }
    expect(m.restorePending(ledger)).toBe(1)
    // The cooldown is in the future: the release waits for it.
    expect(m.releaseDue(T0)).toEqual([])
    expect(m.nextWakeAt()).toBe(T0 + 2 * MIN)
    // Green path + past deadline: the attempt opens with the persisted channel.
    m.onProbeResult('p', { ok: true })
    clock.value = T0 + 2 * MIN
    const released = m.releaseDue(clock.value)
    expect(kinds(released)).toContain('v2-attempt')
    expect(released[0]).toMatchObject({ channel: 'progress-retry', code: 'TRANSPORT' })
    // The pending was consumed: the ledger now exports nothing.
    expect(m.pendingSnapshot().sessions).toEqual({})
  })

  it('a restored route-unknown defer releases once model/selection names a route', () => {
    const { m } = machine()
    const ledger = { S: { plannedAt: T0, channel: 'fresh' as const, cooldownUntil: 0 } }
    expect(m.restorePending(ledger)).toBe(1)
    // No route yet: the replay parks exactly like the original defer, and the
    // probe loop has nothing to target (route-unknown waits for selection).
    expect(m.releaseDue(T0)).toEqual([])
    expect(m.routesNeedingProbe(T0)).toEqual([])
    // The durable route arrives; the probe cache is already green from an
    // earlier round on that route, so the deferred decision releases inside
    // the probe result (the shell's post-probe releaseDue pass).
    m.setRoute({ provider: 'p', model: 'm' })
    expect(kinds(m.onProbeResult('p', { ok: true }))).toContain('v2-attempt')
    expect(m.pendingSnapshot().sessions).toEqual({})
  })
})
