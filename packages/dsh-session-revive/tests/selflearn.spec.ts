import { describe, expect, it } from 'vitest'
import { STAGGER_MIN_MS } from '../src/config.ts'
import { RevivalPolicy, type DecisionRecord, type PolicyRecord } from '../src/policy.ts'
import {
  SELFLEARN_EVICT_STRIKES,
  SELFLEARN_MIN_N,
  SELFLEARN_MIN_RATE,
  SELFLEARN_WINDOW_DAYS,
} from '../src/selflearn.ts'

/** Fixed epoch so every arithmetic in the expectations is exact. */
const T0 = 1_760_000_000_000
const MIN = 60_000

function policy(): RevivalPolicy {
  return new RevivalPolicy({ staggerMs: STAGGER_MIN_MS })
}

function decisions(records: PolicyRecord[]): DecisionRecord[] {
  return records.filter((record): record is DecisionRecord => record.kind === 'decision')
}

function logs(records: PolicyRecord[]): Array<Extract<PolicyRecord, { kind: 'log' }>> {
  return records.filter((record): record is Extract<PolicyRecord, { kind: 'log' }> => record.kind === 'log')
}

/** One EPIPE failure whose next turn completes — a bare-recovery sample. */
function recoveredSample(p: RevivalPolicy, sessionId: string, at: number): void {
  p.onError({ sessionId, code: 'EPIPE', at })
  p.onSuccess(sessionId, at + 1_000)
}

describe('self-learning admission (拍板⑭ 自动准入)', () => {
  it('admits a fresh code at n≥10 ∧ rate≥55%, writes the ledger line, and the whitelist takes effect', () => {
    const p = policy()
    for (let i = 0; i < SELFLEARN_MIN_N - 1; i++) {
      recoveredSample(p, `s${i}`, T0 + i * MIN)
    }
    // The tenth sample decides on THIS success — capture the records it emits.
    p.onError({ sessionId: 's9', code: 'EPIPE', at: T0 + 9 * MIN })
    const tenth = p.onSuccess('s9', T0 + 9 * MIN + 1_000)
    const snapshot = p.snapshot(T0 + 11 * MIN)
    expect(snapshot.selflearn.thresholds).toEqual({
      minN: SELFLEARN_MIN_N,
      minRate: SELFLEARN_MIN_RATE,
      evictStrikes: SELFLEARN_EVICT_STRIKES,
    })
    expect(snapshot.selflearn.windowDays).toBe(SELFLEARN_WINDOW_DAYS)
    expect(snapshot.selflearn.admitted).toEqual(['EPIPE'])
    expect(snapshot.selflearn.evicted).toEqual([])
    expect(snapshot.selflearn.codes.find((entry) => entry.code === 'EPIPE')).toMatchObject({
      n: SELFLEARN_MIN_N,
      recovered: SELFLEARN_MIN_N,
      rate: 1,
      strikes: 0,
    })
    // 决策台账 (W1-5): the admission itself is one passive log line.
    expect(logs(tenth)).toContainEqual({
      kind: 'log',
      at: T0 + 9 * MIN + 1_000,
      event: 'selflearn-decision',
      detail: { direction: 'admit', code: 'EPIPE', n: SELFLEARN_MIN_N, rate: 1 },
    })
    // The learned entry joins the revive flow: the next EPIPE error revives.
    const after = p.onError({ sessionId: 'z', code: 'EPIPE', at: T0 + 12 * MIN })
    const decision = decisions(after).at(-1)
    expect(decision).toMatchObject({ action: 'revive', reason: 'ok', code: 'EPIPE' })
  })

  it('holds below either threshold: n=9 at 100% never admits, n=10 at 50% never admits', () => {
    // Case 1 — sample floor: nine decided samples, perfect recovery.
    const underN = policy()
    for (let i = 0; i < SELFLEARN_MIN_N - 1; i++) {
      recoveredSample(underN, `a${i}`, T0 + i * MIN)
    }
    expect(underN.snapshot(T0 + 10 * MIN).selflearn.admitted).toEqual([])

    // Case 2 — rate floor: exactly ten decided samples, five of them deaths
    // (50% bare recovery, below 55%).
    const underRate = policy()
    for (let i = 0; i < 5; i++) {
      const sessionId = `b${i}`
      underRate.onError({ sessionId, code: 'EPIPE', at: T0 + i * MIN })
      underRate.onError({ sessionId, code: 'EPIPE', at: T0 + 10 * MIN + i * MIN })
      recoveredSample(underRate, `c${i}`, T0 + 20 * MIN + i * MIN)
    }
    const snapshot = underRate.snapshot(T0 + 30 * MIN)
    expect(snapshot.selflearn.admitted).toEqual([])
    expect(snapshot.selflearn.codes.find((entry) => entry.code === 'EPIPE')).toMatchObject({
      n: 10,
      recovered: 5,
      rate: 0.5,
    })
  })

  it('drops a sample when a model/selection lands between the failure and the outcome (样本剔除)', () => {
    const p = policy()
    for (let i = 0; i < SELFLEARN_MIN_N; i++) {
      const sessionId = `x${i}`
      p.onError({ sessionId, code: 'EPIPE', at: T0 + i * MIN })
      // 换路由治好的不算 continue 的功劳: confounded before the outcome lands.
      p.onModelSelection({ sessionId, provider: 'other', model: 'm', at: T0 + i * MIN + 500 })
      p.onSuccess(sessionId, T0 + i * MIN + 1_000)
    }
    const snapshot = p.snapshot(T0 + 11 * MIN)
    expect(snapshot.selflearn.admitted).toEqual([])
    expect(snapshot.selflearn.codes.find((entry) => entry.code === 'EPIPE')).toMatchObject({
      n: 0,
      recovered: 0,
      excluded: SELFLEARN_MIN_N,
    })
  })

  it('never admits or strikes a config-pinned code (拍板⑨ 配置值仍可覆盖)', () => {
    const p = policy()
    // Twelve same-session TRANSPORT deaths — past every threshold a learned
    // code would face — yet the pinned layer is the human's, untouched.
    for (let i = 0; i < 12; i++) {
      p.onError({ sessionId: 'pinned', code: 'TRANSPORT', at: T0 + i * 16 * MIN })
    }
    const snapshot = p.snapshot(T0 + 200 * MIN)
    expect(snapshot.selflearn.admitted).toEqual([])
    expect(snapshot.selflearn.evicted).toEqual([])
    expect(snapshot.selflearn.codes.find((entry) => entry.code === 'TRANSPORT')).toMatchObject({ strikes: 0 })
  })
})

describe('self-learning eviction (拍板⑭ 自动除名)', () => {
  it('evicts a learned entry after three auto-revived deaths, then parks its errors (连败 3 → 停靠)', () => {
    const p = policy()
    for (let i = 0; i < SELFLEARN_MIN_N; i++) {
      recoveredSample(p, `s${i}`, T0 + i * MIN)
    }
    expect(p.snapshot(T0 + 11 * MIN).selflearn.admitted).toEqual(['EPIPE'])

    // Four EPIPE deaths 16 min apart on one session: each past the wave
    // window and the breaker, so e1..e3 revive (arming the strike) and e4's
    // close lands the third strike.
    const base = T0 + 60 * MIN
    p.onError({ sessionId: 'L', code: 'EPIPE', at: base })
    p.onError({ sessionId: 'L', code: 'EPIPE', at: base + 16 * MIN })
    p.onError({ sessionId: 'L', code: 'EPIPE', at: base + 32 * MIN })
    const fourth = p.onError({ sessionId: 'L', code: 'EPIPE', at: base + 48 * MIN })

    // 除名降级: detect + stop-parked evidence + ledger + alarm, and NOT one
    // decision record — the evicted code never re-enters the decision chain.
    expect(decisions(fourth)).toEqual([])
    expect(fourth).toContainEqual({
      kind: 'detect',
      at: base + 48 * MIN,
      sessionId: 'L',
      code: 'EPIPE',
      cls: 'other',
    })
    expect(fourth).toContainEqual({
      kind: 'log',
      at: base + 48 * MIN,
      event: 'stop-parked',
      sessionId: 'L',
      detail: { cause: 'EPIPE', selflearn: 'evicted' },
    })
    expect(logs(fourth)).toContainEqual({
      kind: 'log',
      at: base + 48 * MIN,
      event: 'selflearn-decision',
      detail: { direction: 'evict', code: 'EPIPE', n: 13, rate: 10 / 13 },
    })
    // 一行报警 (W1-5): the eviction alarm, log only, zero push.
    expect(logs(fourth)).toContainEqual({
      kind: 'log',
      at: base + 48 * MIN,
      event: 'selflearn-alarm',
      detail: { code: 'EPIPE', sessionId: 'L', strikes: SELFLEARN_EVICT_STRIKES, n: 13, rate: 10 / 13 },
    })

    // Sticky for the run: later errors park, and fresh stats never re-admit.
    const fifth = p.onError({ sessionId: 'M', code: 'EPIPE', at: base + 64 * MIN })
    expect(decisions(fifth)).toEqual([])
    expect(logs(fifth).some((record) => record.event === 'stop-parked')).toBe(true)
    recoveredSample(p, 'N', base + 80 * MIN)
    recoveredSample(p, 'O', base + 96 * MIN)
    const snapshot = p.snapshot(base + 100 * MIN)
    expect(snapshot.selflearn.evicted).toEqual(['EPIPE'])
    expect(snapshot.selflearn.admitted).toEqual([])
  })
})
