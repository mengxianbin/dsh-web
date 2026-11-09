import { describe, expect, it } from 'vitest'
import {
  BREAKER_WINDOW_MS,
  CONTEXT_LIMIT_TOKENS,
  QUOTA_WINDOW_MS,
  STAGGER_MIN_MS,
  WAVE_COOLDOWN_MS,
  WALL_CODES,
} from '../src/config.ts'
import {
  BOOT_SWEEP_CODE,
  ROUTE_SWITCH_CODE,
  RevivalPolicy,
  type DecisionRecord,
  type PolicyRecord,
} from '../src/policy.ts'

/** Fixed epoch so every arithmetic in the expectations is exact. */
const T0 = 1_760_000_000_000
const MIN = 60_000

function policy(staggerMs: number = STAGGER_MIN_MS): RevivalPolicy {
  return new RevivalPolicy({ staggerMs })
}

function decisions(records: PolicyRecord[]): DecisionRecord[] {
  return records.filter((record): record is DecisionRecord => record.kind === 'decision')
}

function lastDecision(records: PolicyRecord[]): DecisionRecord {
  const list = decisions(records)
  expect(list.length).toBeGreaterThan(0)
  return list[list.length - 1]
}

describe('rolling revival quota (4h x 4, per chain)', () => {
  it('four revives inside the window exhaust the can, the window slides, and chains stay independent', () => {
    const p = policy()
    // Same-cause errors 16 min apart never form a wave, so each runs the full quota path.
    const stamps = [0, 16, 32, 48, 64].map((min) => T0 + min * MIN)
    expect(lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: stamps[0] }))).toMatchObject({
      action: 'revive',
      reason: 'ok',
      chainId: 'A',
      quotaUsed: 1,
      quotaLimit: 4,
      plannedAt: stamps[0],
    })
    for (const [index, at] of stamps.slice(1, 4).entries()) {
      expect(lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at }))).toMatchObject({
        action: 'revive',
        quotaUsed: index + 2,
      })
    }
    expect(lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: stamps[4] }))).toMatchObject({
      action: 'skip',
      reason: 'quota-exhausted',
      quotaUsed: 4,
      quotaLimit: 4,
    })
    // The oldest stamp leaves the 4h window: one slot frees up again.
    const slide = lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: T0 + QUOTA_WINDOW_MS + 1 }))
    expect(slide).toMatchObject({ action: 'revive', quotaUsed: 4 })
    // 分罐不分池: B's can is untouched by A's exhaustion (B errors after the
    // slide, alone in the wave window once the last error aged out).
    expect(
      lastDecision(p.onError({ sessionId: 'B', code: 'TRANSPORT', at: T0 + QUOTA_WINDOW_MS + 17 * MIN })),
    ).toMatchObject({
      action: 'revive',
      chainId: 'B',
      quotaUsed: 1,
    })
  })
})

describe('wall-class codes (zero consumption + suspension)', () => {
  it('records a zero-consumption suspension until resetsAt and releases after it', () => {
    const p = policy()
    const wall = lastDecision(p.onError({ sessionId: 'A', code: 'QUOTA', at: T0, providerRetryAfterMs: 60_000 }))
    expect(wall).toMatchObject({
      action: 'skip',
      reason: 'wall-class',
      quotaUsed: 0,
      resetsAt: T0 + 60_000,
    })
    const duringHold = lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: T0 + 30_000 }))
    expect(duringHold).toMatchObject({
      action: 'skip',
      reason: 'wall-suspended',
      quotaUsed: 0,
      resetsAt: T0 + 60_000,
    })
    // Past resetsAt the wave window has aged the held-out error away, so the flow revives.
    const after = lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: T0 + 16 * MIN }))
    expect(after).toMatchObject({ action: 'revive', quotaUsed: 1 })
  })

  it('treats an absent provider retry-after as an unknown reset and lets a success clear it', () => {
    const p = policy()
    expect(lastDecision(p.onError({ sessionId: 'B', code: 'AUTH', at: T0 }))).toMatchObject({
      action: 'skip',
      reason: 'wall-class',
      resetsAt: null,
      quotaUsed: 0,
    })
    expect(lastDecision(p.onError({ sessionId: 'B', code: 'TRANSPORT', at: T0 + 30_000 }))).toMatchObject({
      reason: 'wall-suspended',
      resetsAt: null,
    })
    // A stated reset never shortens an unknown hold (monotonic suspension).
    lastDecision(p.onError({ sessionId: 'B', code: 'QUOTA', at: T0 + 40_000, providerRetryAfterMs: 5_000 }))
    expect(p.snapshot(T0 + 50_000).suspended).toBe(1)
    expect(p.onSuccess('B', T0 + 60_000)).toEqual([
      { kind: 'state', at: T0 + 60_000, sessionId: 'B', event: 'clear', cleared: ['suspended'] },
    ])
    expect(p.snapshot(T0 + 60_000).suspended).toBe(0)
  })
})

describe('10-minute breaker', () => {
  it('trips with evidence when the session dies again inside the window and stops it for good', () => {
    const p = policy()
    expect(lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: T0 }))).toMatchObject({
      action: 'revive',
      plannedAt: T0,
    })
    const redeath = p.onError({ sessionId: 'A', code: 'TRANSPORT', at: T0 + 9 * MIN })
    expect(redeath.find((r) => r.kind === 'wave')).toMatchObject({ event: 'open', cause: 'TRANSPORT' })
    expect(redeath.find((r) => r.kind === 'breaker')).toMatchObject({
      event: 'trip',
      sessionId: 'A',
      revivedAt: T0,
      diedAt: T0 + 9 * MIN,
      gapMs: 9 * MIN,
      code: 'TRANSPORT',
    })
    // The breaker outranks the wave: the opened wave does not get to hold this session.
    expect(lastDecision(redeath)).toMatchObject({
      action: 'skip',
      reason: 'breaker-trip',
      quotaUsed: 1,
      breaker: { revivedAt: T0, diedAt: T0 + 9 * MIN, gapMs: 9 * MIN },
    })
    expect(
      lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: T0 + 30 * MIN })),
    ).toMatchObject({ action: 'skip', reason: 'breaker-stopped' })
    expect(p.snapshot(T0 + 30 * MIN).tripped).toEqual(['A'])
    expect(p.snapshot(T0 + 30 * MIN).counters.breakerTrips).toBe(1)
  })

  it('does not trip when the re-death lands after the window', () => {
    const p = policy()
    p.onError({ sessionId: 'C', code: 'TRANSPORT', at: T0 })
    // 16 min later: past the breaker window and past the 15 min wave window,
    // so the error runs the plain quota path instead of a hold or a trip.
    const later = lastDecision(p.onError({ sessionId: 'C', code: 'TRANSPORT', at: T0 + BREAKER_WINDOW_MS + 6 * MIN }))
    expect(later).toMatchObject({ action: 'revive', quotaUsed: 2 })
    expect(p.snapshot(later.at).counters.breakerTrips).toBe(0)
  })
})

describe('same-cause wave probe', () => {
  it('holds from the second same-cause error, extends on new errors, and releases a staggered batch after the quiet period', () => {
    const p = policy()
    // First error of the batch: no wave exists yet, so the fast path decides it.
    expect(lastDecision(p.onError({ sessionId: 's1', code: 'TRANSPORT', at: T0 }))).toMatchObject({
      action: 'revive',
      quotaUsed: 1,
    })
    const open = p.onError({ sessionId: 's2', code: 'TRANSPORT', at: T0 + MIN })
    expect(open.find((r) => r.kind === 'wave')).toMatchObject({
      event: 'open',
      cause: 'TRANSPORT',
      count: 2,
      releaseAt: T0 + MIN + WAVE_COOLDOWN_MS,
    })
    expect(lastDecision(open)).toMatchObject({
      action: 'hold',
      reason: 'wave-hold',
      quotaUsed: 0,
      wave: { cause: 'TRANSPORT', count: 2 },
    })
    expect(lastDecision(p.onError({ sessionId: 's3', code: 'TRANSPORT', at: T0 + 2 * MIN }))).toMatchObject({
      action: 'hold',
      quotaUsed: 0,
    })
    // A different cause runs its own probe: TIMEOUT count 1 is not a wave.
    expect(lastDecision(p.onError({ sessionId: 't1', code: 'TIMEOUT', at: T0 + 2 * MIN + 1_000 }))).toMatchObject({
      action: 'revive',
      code: 'TIMEOUT',
    })
    // A new same-cause error extends the cooldown.
    expect(lastDecision(p.onError({ sessionId: 's4', code: 'TRANSPORT', at: T0 + 3 * MIN }))).toMatchObject({
      action: 'hold',
      quotaUsed: 0,
    })
    expect(p.nextWakeAt()).toBe(T0 + 3 * MIN + WAVE_COOLDOWN_MS)
    // The quiet period has not elapsed: nothing releases.
    expect(p.releaseDue(T0 + 3 * MIN + WAVE_COOLDOWN_MS - 1)).toEqual([])
    const released = p.releaseDue(T0 + 3 * MIN + WAVE_COOLDOWN_MS)
    expect(released.find((r) => r.kind === 'wave')).toMatchObject({
      event: 'release',
      cause: 'TRANSPORT',
      held: 3,
    })
    // Full checks re-run at release (the window still counts >= 2, but the
    // quiet period is what released them), each revive consumes its own can,
    // and the global stagger slot spaces the batch.
    const revives = decisions(released)
      .filter((d) => d.action === 'revive')
      .sort((a, b) => a.plannedAt! - b.plannedAt!)
    expect(revives.map((d) => d.sessionId)).toEqual(['s2', 's3', 's4'])
    expect(revives.map((d) => d.plannedAt)).toEqual([
      T0 + 3 * MIN + WAVE_COOLDOWN_MS,
      T0 + 3 * MIN + WAVE_COOLDOWN_MS + 10_000,
      T0 + 3 * MIN + WAVE_COOLDOWN_MS + 20_000,
    ])
    expect(revives.map((d) => d.quotaUsed)).toEqual([1, 1, 1])
    expect(revives.every((d) => d.reason === 'ok')).toBe(true)
    expect(p.nextWakeAt()).toBeNull()
  })

  it('spaces a released batch by the configured stagger', () => {
    const p = policy(30_000)
    p.onError({ sessionId: 'a', code: 'TRANSPORT', at: T0 })
    p.onError({ sessionId: 'b', code: 'TRANSPORT', at: T0 + MIN })
    p.onError({ sessionId: 'c', code: 'TRANSPORT', at: T0 + 2 * MIN })
    const base = T0 + 2 * MIN + WAVE_COOLDOWN_MS
    const revives = decisions(p.releaseDue(base))
      .filter((d) => d.action === 'revive')
      .sort((x, y) => x.plannedAt! - y.plannedAt!)
    expect(revives.map((d) => d.plannedAt)).toEqual([base, base + 30_000])
    expect(revives[1].plannedAt! - revives[0].plannedAt!).toBe(30_000)
  })

  it('drops a session from the pending release once a success proves it alive', () => {
    const p = policy()
    p.onError({ sessionId: 'x', code: 'TRANSPORT', at: T0 })
    p.onError({ sessionId: 'y', code: 'TRANSPORT', at: T0 + MIN })
    expect(p.nextWakeAt()).toBe(T0 + MIN + WAVE_COOLDOWN_MS)
    expect(p.onSuccess('y', T0 + 2 * MIN)).toEqual([
      { kind: 'state', at: T0 + 2 * MIN, sessionId: 'y', event: 'clear', cleared: ['held'] },
    ])
    expect(p.nextWakeAt()).toBeNull()
    expect(p.releaseDue(T0 + MIN + WAVE_COOLDOWN_MS)).toEqual([])
  })

  it('re-runs the quota check at release against the can filled while the session waited', () => {
    const p = policy()
    // R fills its own can before the wave (16 min spacing keeps each alone in the window).
    for (const min of [64, 48, 32, 16]) {
      expect(lastDecision(p.onError({ sessionId: 'R', code: 'TRANSPORT', at: T0 - min * MIN }))).toMatchObject({
        action: 'revive',
        quotaUsed: [1, 2, 3, 4][[64, 48, 32, 16].indexOf(min)],
      })
    }
    // w1 enters the window alone (revives), R joins and is held by the wave.
    expect(lastDecision(p.onError({ sessionId: 'w1', code: 'TRANSPORT', at: T0 }))).toMatchObject({ action: 'revive' })
    expect(lastDecision(p.onError({ sessionId: 'R', code: 'TRANSPORT', at: T0 + MIN }))).toMatchObject({
      action: 'hold',
      reason: 'wave-hold',
      quotaUsed: 4,
    })
    const released = p.releaseDue(T0 + MIN + WAVE_COOLDOWN_MS)
    // The can was filled while R waited: release refuses the revival, zero further consumption.
    expect(lastDecision(released)).toMatchObject({
      action: 'skip',
      reason: 'quota-exhausted',
      chainId: 'R',
      quotaUsed: 4,
    })
  })
})

describe('150k context watermark', () => {
  it('parks at or above the limit with evidence and revives below it', () => {
    const parked = policy()
    parked.recordUsage('big', 160_000)
    expect(lastDecision(parked.onError({ sessionId: 'big', code: 'TRANSPORT', at: T0 }))).toMatchObject({
      action: 'skip',
      reason: 'context-limit',
      contextTokens: 160_000,
      quotaUsed: 0,
    })
    const allowed = policy()
    allowed.recordUsage('ok', 140_000)
    expect(lastDecision(allowed.onError({ sessionId: 'ok', code: 'TRANSPORT', at: T0 }))).toMatchObject({
      action: 'revive',
      contextTokens: 140_000,
    })
  })

  it('folds the latest usage (shrink un-parks) and leaves an unread watermark open', () => {
    const p = policy()
    p.recordUsage('shrunk', 160_000)
    p.recordUsage('shrunk', 149_999)
    expect(lastDecision(p.onError({ sessionId: 'shrunk', code: 'TRANSPORT', at: T0 }))).toMatchObject({
      action: 'revive',
      contextTokens: 149_999,
    })
    // 16 min later the first error has aged out of the wave window, so the
    // second session decides on its own merits (unread watermark: no boundary).
    expect(lastDecision(p.onError({ sessionId: 'fresh', code: 'TRANSPORT', at: T0 + 16 * MIN }))).toMatchObject({
      action: 'revive',
      contextTokens: null,
    })
  })
})

describe('detection and lifecycle edges', () => {
  it('observes wall and other codes without consuming, and other codes never suspend', () => {
    const p = policy()
    const wall = p.onError({ sessionId: 'w', code: 'INVALID_REQUEST', at: T0 })
    expect(wall[0]).toMatchObject({ kind: 'detect', cls: 'wall', code: 'INVALID_REQUEST' })
    expect(lastDecision(wall)).toMatchObject({ action: 'skip', reason: 'wall-class' })
    expect(p.snapshot(T0).suspended).toBe(1)
    // A non-revive, non-wall code is observed and skipped with no suspension.
    const other = p.onError({ sessionId: 'o', code: 'PI_AI_ERROR', at: T0 })
    expect(other[0]).toMatchObject({ kind: 'detect', cls: 'other' })
    expect(lastDecision(other)).toMatchObject({ action: 'skip', reason: 'non-revive-class', quotaUsed: 0 })
    expect(p.snapshot(T0).suspended).toBe(1)
    // The other-class death did not park its session: the next revive-class error runs normally.
    expect(lastDecision(p.onError({ sessionId: 'o', code: 'TRANSPORT', at: T0 + MIN }))).toMatchObject({
      action: 'revive',
      quotaUsed: 1,
    })
  })

  it('forget drops the session can, its holds, and the wake deadline', () => {
    const p = policy()
    p.onError({ sessionId: 'g', code: 'TRANSPORT', at: T0 })
    p.onError({ sessionId: 'h', code: 'TRANSPORT', at: T0 + MIN })
    expect(p.nextWakeAt()).not.toBeNull()
    p.forget('g')
    p.forget('h')
    expect(p.nextWakeAt()).toBeNull()
    const snap = p.snapshot(T0 + MIN)
    expect(snap.quota.find((q) => q.chainId === 'g')).toBeUndefined()
    expect(snap.held).toBe(0)
  })
})

describe('stop causes (design §7: max-tokens / durability-flush)', () => {
  it('detects a stop cause as revive-class and runs it through the same quota chain', () => {
    const p = policy()
    const first = p.onError({ sessionId: 's', code: 'max-tokens', at: T0 })
    expect(first[0]).toMatchObject({ kind: 'detect', cls: 'revive', code: 'max-tokens' })
    expect(lastDecision(first)).toMatchObject({
      action: 'revive',
      reason: 'ok',
      code: 'max-tokens',
      quotaUsed: 1,
      quotaLimit: 4,
    })
    // The stop cause consumes the same can as network deaths: TRANSPORT next.
    expect(lastDecision(p.onError({ sessionId: 's', code: 'TRANSPORT', at: T0 + 16 * MIN }))).toMatchObject({
      action: 'revive',
      quotaUsed: 2,
    })
    expect(p.snapshot(T0).counters.reviveClass).toBe(2)
  })

  it('runs the durability stop cause through detection and the same consecutive-death breaker', () => {
    const p = policy()
    const first = p.onError({ sessionId: 'd', code: 'durability-flush', at: T0 })
    expect(first[0]).toMatchObject({ kind: 'detect', cls: 'revive', code: 'durability-flush' })
    expect(lastDecision(first)).toMatchObject({ action: 'revive', code: 'durability-flush' })
    // Revive -> stop cause again inside 10 min = the consecutive same-cause
    // circuit breaker trips with evidence and parks the session for good.
    const second = p.onError({ sessionId: 'd', code: 'durability-flush', at: T0 + 3 * MIN })
    expect(second.find((r) => r.kind === 'breaker')).toMatchObject({
      event: 'trip',
      code: 'durability-flush',
      gapMs: 3 * MIN,
    })
    expect(lastDecision(second)).toMatchObject({ action: 'skip', reason: 'breaker-trip' })
    expect(p.snapshot(T0 + 3 * MIN).counters.breakerTrips).toBe(1)
    // After the trip the session stays parked on any later stop cause.
    expect(lastDecision(p.onError({ sessionId: 'd', code: 'max-tokens', at: T0 + 30 * MIN }))).toMatchObject({
      action: 'skip',
      reason: 'breaker-stopped',
    })
  })

  it('groups waves by the stop-cause code itself, leaving other causes independent', () => {
    const p = policy()
    expect(lastDecision(p.onError({ sessionId: 'w1', code: 'max-tokens', at: T0 }))).toMatchObject({
      action: 'revive',
    })
    // Second same-code stop cause inside 15 min opens the wave and holds it.
    expect(lastDecision(p.onError({ sessionId: 'w2', code: 'max-tokens', at: T0 + MIN }))).toMatchObject({
      action: 'hold',
      reason: 'wave-hold',
      wave: { cause: 'max-tokens', count: 2 },
    })
    // The wave is keyed by code, so a different cause is not grouped into it.
    expect(lastDecision(p.onError({ sessionId: 'w3', code: 'durability-flush', at: T0 + 2 * MIN }))).toMatchObject({
      action: 'revive',
    })
  })
})

describe('墙随路由走: a model/selection releases a wall suspension (拍板⑩)', () => {
  /** Wall-suspend a session on a known route (the folded header of the failing request). */
  function wall(
    p: RevivalPolicy,
    sessionId: string,
    at: number,
    provider: string,
    opts: { retryAfterMs?: number; withRoute?: boolean } = {},
  ): void {
    p.onError({
      sessionId,
      code: 'QUOTA',
      at,
      ...(opts.retryAfterMs === undefined ? {} : { providerRetryAfterMs: opts.retryAfterMs }),
      ...(opts.withRoute === false ? {} : { route: { provider, model: `${provider}-model` } }),
    })
  }

  it('切走 → 挂起解除且计 1 次额度 (a future resetsAt does not block the release)', () => {
    const p = policy()
    wall(p, 'A', T0, 'deepseek', { retryAfterMs: 60_000 }) // resetsAt = T0+60s, still in the future
    expect(p.snapshot(T0).suspended).toBe(1)
    const records = p.onModelSelection({ sessionId: 'A', provider: 'mimo', model: 'mimo-v2.6-flash', at: T0 + 30_000 })
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'log',
        event: 'wall-route-release',
        detail: expect.objectContaining({
          from: 'deepseek/deepseek-model',
          to: 'mimo/mimo-v2.6-flash',
          resetsAt: T0 + 60_000,
        }),
      }),
    )
    const decision = lastDecision(records)
    expect(decision).toMatchObject({
      action: 'revive',
      reason: 'ok',
      code: ROUTE_SWITCH_CODE,
      quotaUsed: 1,
      quotaLimit: 4,
      plannedAt: T0 + 30_000,
    })
    expect(p.snapshot(T0 + 30_000).suspended).toBe(0)
    expect(p.snapshot(T0 + 30_000).quota).toContainEqual({ chainId: 'A', used: 1 })
  })

  it('未切走 → 维持零消耗 (same provider — even with a different model — keeps the hold)', () => {
    const p = policy()
    wall(p, 'A', T0, 'deepseek', { retryAfterMs: 60_000 })
    const records = p.onModelSelection({
      sessionId: 'A',
      provider: 'deepseek',
      model: 'deepseek-v4-pro', // model changed, provider did not
      at: T0 + 30_000,
    })
    expect(decisions(records)).toEqual([])
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'log', event: 'wall-route-unchanged' }),
    )
    const snap = p.snapshot(T0 + 30_000)
    expect(snap.suspended).toBe(1)
    expect(snap.quota).toEqual([]) // zero consumption
    expect(snap.counters.revived).toBe(0)
    expect(snap.counters.cleared).toBe(0)
  })

  it('非挂起会话的 selection 不触发', () => {
    const p = policy()
    expect(p.onModelSelection({ sessionId: 'fresh', provider: 'mimo', at: T0 })).toEqual([])
    // Suspended, then a successful turn clears the hold: later selections are no-ops.
    wall(p, 'B', T0, 'deepseek')
    expect(p.onSuccess('B', T0 + MIN)).toEqual([
      { kind: 'state', at: T0 + MIN, event: 'clear', sessionId: 'B', cleared: ['suspended'] },
    ])
    expect(p.onModelSelection({ sessionId: 'B', provider: 'mimo', at: T0 + 2 * MIN })).toEqual([])
    expect(p.snapshot(T0 + 2 * MIN).suspended).toBe(0)
    expect(p.snapshot(T0 + 2 * MIN).quota).toEqual([])
  })

  it('fail-closed: a wall without an observed route keeps the hold even on a foreign provider', () => {
    const p = policy()
    wall(p, 'A', T0, 'deepseek', { withRoute: false }) // no folded header at wall time
    const records = p.onModelSelection({ sessionId: 'A', provider: 'mimo', at: T0 + 30_000 })
    expect(decisions(records)).toEqual([])
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'log',
        event: 'wall-route-unchanged',
        detail: expect.objectContaining({ wallRoute: 'unknown' }),
      }),
    )
    expect(p.snapshot(T0 + 30_000).suspended).toBe(1)
    expect(p.snapshot(T0 + 30_000).quota).toEqual([])
  })

  it('第 2 行原样: without a selection event nothing wakes on resetsAt alone', () => {
    const p = policy()
    wall(p, 'A', T0, 'deepseek', { retryAfterMs: 60_000 }) // resetsAt = T0+60s
    expect(p.snapshot(T0 + 5 * MIN).suspended).toBe(1) // expired hold still sits: no timer exists
    expect(p.snapshot(T0 + 5 * MIN).counters.revived).toBe(0)
  })

  it('断路器照旧: a release right after a revival trips the breaker instead of reviving', () => {
    const p = policy()
    expect(lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: T0 }))).toMatchObject({
      action: 'revive',
      quotaUsed: 1,
    })
    wall(p, 'A', T0 + 2 * MIN, 'deepseek') // dies (wall) inside the breaker window
    const records = p.onModelSelection({ sessionId: 'A', provider: 'mimo', at: T0 + 3 * MIN })
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'breaker', event: 'trip', sessionId: 'A', gapMs: 3 * MIN, code: ROUTE_SWITCH_CODE }),
    )
    expect(lastDecision(records)).toMatchObject({ action: 'skip', reason: 'breaker-trip' })
    const snap = p.snapshot(T0 + 3 * MIN)
    expect(snap.tripped).toEqual(['A'])
    expect(snap.suspended).toBe(0) // the hold still releases; the breaker is what stops it
    expect(snap.quota).toContainEqual({ chainId: 'A', used: 1 }) // no second stamp
  })

  it('150k 水位照旧: the release parks at the watermark instead of nudging', () => {
    const p = policy()
    p.recordUsage('A', 200_000)
    wall(p, 'A', T0, 'deepseek', { retryAfterMs: 60_000 })
    const records = p.onModelSelection({ sessionId: 'A', provider: 'mimo', at: T0 + 30_000 })
    expect(lastDecision(records)).toMatchObject({
      action: 'skip',
      reason: 'context-limit',
      contextTokens: 200_000,
    })
    expect(p.snapshot(T0 + 30_000).suspended).toBe(0)
    expect(p.snapshot(T0 + 30_000).quota).toEqual([])
  })

  it('额度罐: releases consume the same 4h x 4 can; the fifth skips quota-exhausted', () => {
    const p = policy()
    for (let index = 0; index < 4; index += 1) {
      const wallAt = T0 + index * 16 * MIN // 16 min spacing: past the breaker, inside the window
      wall(p, 'A', wallAt, 'deepseek', { retryAfterMs: 60_000 })
      const records = p.onModelSelection({ sessionId: 'A', provider: 'mimo', at: wallAt + 30_000 })
      expect(lastDecision(records)).toMatchObject({ action: 'revive', quotaUsed: index + 1 })
    }
    wall(p, 'A', T0 + 64 * MIN, 'deepseek', { retryAfterMs: 60_000 })
    const fifth = p.onModelSelection({ sessionId: 'A', provider: 'mimo', at: T0 + 64 * MIN + 30_000 })
    expect(lastDecision(fifth)).toMatchObject({
      action: 'skip',
      reason: 'quota-exhausted',
      quotaUsed: 4,
      quotaLimit: 4,
    })
    const snap = p.snapshot(T0 + 64 * MIN + 30_000)
    expect(snap.suspended).toBe(0) // the hold still releases; only the revival is capped
    expect(snap.counters.revived).toBe(4)
  })

  it('波挂起不双击: the release drops a pending wave hold so cooldown cannot re-revive', () => {
    const p = policy()
    // First network death revives; the second (11 min later: past the breaker,
    // inside the 15 min wave window) opens the wave and holds A.
    expect(lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: T0 }))).toMatchObject({ action: 'revive' })
    expect(lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: T0 + 11 * MIN }))).toMatchObject({
      action: 'hold',
      reason: 'wave-hold',
    })
    expect(p.snapshot(T0 + 11 * MIN).held).toBe(1)
    // The session then hits a wall on its route; the wave hold stays pending.
    wall(p, 'A', T0 + 12 * MIN, 'deepseek', { retryAfterMs: 60_000 })
    expect(p.snapshot(T0 + 12 * MIN).held).toBe(1)
    // The route switch releases both the suspension and the wave hold, one stamp.
    const records = p.onModelSelection({ sessionId: 'A', provider: 'mimo', at: T0 + 13 * MIN })
    expect(records).toContainEqual(
      expect.objectContaining({ kind: 'state', event: 'clear', cleared: ['suspended', 'held'] }),
    )
    expect(lastDecision(records)).toMatchObject({ action: 'revive', quotaUsed: 2 })
    expect(p.snapshot(T0 + 13 * MIN).held).toBe(0)
    // The wave cooldown later finds nobody held: no double revive, no extra stamp.
    expect(p.releaseDue(T0 + 11 * MIN + WAVE_COOLDOWN_MS + MIN)).toEqual([])
    expect(p.snapshot(T0 + 17 * MIN).quota).toContainEqual({ chainId: 'A', used: 2 })
  })
})

describe('condition lists echoed from the policy (拍板⑨ status 回显生效清单)', () => {
  it('defaults to the ruled lists with no overrides', () => {
    expect(policy().snapshot(T0).conditions).toEqual({
      revive: ['TRANSPORT', 'TIMEOUT', 'content_filter', 'MALFORMED_RESPONSE'],
      wall: [...WALL_CODES],
      overridden: [],
    })
  })

  it('echoes overridden lists exactly as configured and classifies by them', () => {
    const p = new RevivalPolicy({
      staggerMs: STAGGER_MIN_MS,
      conditions: { revive: new Set(['A']), wall: new Set(['B', 'C']) },
      conditionOverrides: ['reviveCodes', 'wallCodes'],
    })
    expect(p.snapshot(T0).conditions).toEqual({
      revive: ['A'],
      wall: ['B', 'C'],
      overridden: ['reviveCodes', 'wallCodes'],
    })
    expect(lastDecision(p.onError({ sessionId: 's1', code: 'A', at: T0 }))).toMatchObject({ action: 'revive' })
    expect(lastDecision(p.onError({ sessionId: 's2', code: 'B', at: T0 + 16 * MIN }))).toMatchObject({
      action: 'skip',
      reason: 'wall-class',
    })
    expect(lastDecision(p.onError({ sessionId: 's3', code: 'QUOTA', at: T0 + 32 * MIN }))).toMatchObject({
      action: 'skip',
      reason: 'non-revive-class',
    })
  })
})

describe('boot sweep (拍板⑪ restart revival, zero quota)', () => {
  it('revives through every gate but the quota can and leaves the account byte-identical', () => {
    const p = policy()
    const before = p.snapshot(T0)
    const records = p.onBootSweep({ sessionId: 'S', at: T0 })
    expect(lastDecision(records)).toMatchObject({
      action: 'revive',
      reason: 'ok',
      code: BOOT_SWEEP_CODE,
      chainId: 'S',
      quotaUsed: 0,
      quotaLimit: 4,
      plannedAt: T0,
      contextTokens: null,
    })
    const after = p.snapshot(T0)
    expect(after.quota).toEqual(before.quota)
    expect(after.counters).toEqual(before.counters)
    expect(after.skipReasons).toEqual(before.skipReasons)
  })

  it('arms the breaker: a death inside 10 minutes of a sweep revival trips and stays stopped', () => {
    const p = policy()
    p.onBootSweep({ sessionId: 'S', at: T0 })
    const records = p.onError({ sessionId: 'S', code: 'TRANSPORT', at: T0 + MIN })
    expect(records.some((record) => record.kind === 'breaker')).toBe(true)
    expect(p.snapshot(T0 + MIN).tripped).toContain('S')
    expect(lastDecision(p.onBootSweep({ sessionId: 'S', at: T0 + 2 * MIN }))).toMatchObject({
      action: 'skip',
      reason: 'breaker-stopped',
      code: BOOT_SWEEP_CODE,
    })
    // The sweep's own trip wrote no account counter (status 零增).
    expect(p.snapshot(T0 + 2 * MIN).counters.breakerTrips).toBe(1)
  })

  it('leaves the whole 4h x 4 can for the error path (restart这一次不算额度)', () => {
    const p = policy()
    p.onBootSweep({ sessionId: 'A', at: T0 })
    expect(p.snapshot(T0).quota).toEqual([])
    // First error lands after the breaker window the sweep revival armed;
    // 16-minute spacing keeps every error alone in the wave window.
    const stamps = [11, 27, 43, 59].map((min) => T0 + min * MIN)
    for (const at of stamps) {
      expect(lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at }))).toMatchObject({ action: 'revive' })
    }
    expect(lastDecision(p.onError({ sessionId: 'A', code: 'TRANSPORT', at: T0 + 75 * MIN }))).toMatchObject({
      action: 'skip',
      reason: 'quota-exhausted',
      quotaUsed: 4,
    })
  })

  it('the 150k watermark parks an oversized orphan with evidence and zero account movement', () => {
    const p = policy()
    p.recordUsage('S', CONTEXT_LIMIT_TOKENS)
    const before = p.snapshot(T0)
    const records = p.onBootSweep({ sessionId: 'S', at: T0 })
    expect(lastDecision(records)).toMatchObject({
      action: 'skip',
      reason: 'context-limit',
      code: BOOT_SWEEP_CODE,
      contextTokens: CONTEXT_LIMIT_TOKENS,
    })
    const after = p.snapshot(T0)
    expect(after.counters).toEqual(before.counters)
    expect(after.quota).toEqual(before.quota)
  })

  it('the global stagger spaces sweep nudges apart without a stamp', () => {
    const p = policy()
    expect(lastDecision(p.onBootSweep({ sessionId: 'A', at: T0 }))).toMatchObject({ plannedAt: T0 })
    expect(lastDecision(p.onBootSweep({ sessionId: 'B', at: T0 }))).toMatchObject({
      plannedAt: T0 + STAGGER_MIN_MS,
    })
    expect(p.snapshot(T0).quota).toEqual([])
  })

  it('an unexpired wall suspension still holds a sweep revival; an expired one falls through', () => {
    const p = policy()
    p.onError({ sessionId: 'W', code: 'QUOTA', at: T0 })
    expect(lastDecision(p.onBootSweep({ sessionId: 'W', at: T0 + MIN }))).toMatchObject({
      action: 'skip',
      reason: 'wall-suspended',
      code: BOOT_SWEEP_CODE,
    })
    const q = policy()
    q.onError({ sessionId: 'W', code: 'QUOTA', providerRetryAfterMs: 30_000, at: T0 })
    expect(lastDecision(q.onBootSweep({ sessionId: 'W', at: T0 + MIN }))).toMatchObject({
      action: 'revive',
      code: BOOT_SWEEP_CODE,
    })
    expect(q.snapshot(T0 + MIN).suspended).toBe(0)
  })
})
