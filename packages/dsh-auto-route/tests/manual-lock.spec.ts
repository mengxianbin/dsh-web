import { describe, expect, it } from 'vitest'
import { ManualLockTracker } from '../src/manual-lock.ts'

const GO = 'opencode-go/mimo-v2.6-flash' // live target at baseline (restoreTo)
const MIMO = 'mimo/mimo-v2.6-flash' // live target when triggered (switchTo)
const OTHER = 'deepseek-official/deepseek-v4-flash' // any off-axis side

describe('ManualLockTracker (A case, 2026-10-27 人工锁定优先)', () => {
  it("books the controller's own pending write as auto and never locks it", () => {
    const tracker = new ManualLockTracker()
    tracker.expect('s1', MIMO)
    expect(tracker.observe('s1', MIMO, 10, MIMO)).toBe('auto')
    expect(tracker.isLocked('s1')).toBe(false)

    // Event-echo path: observe consumed the expectation, confirm is a no-op.
    const echoed = new ManualLockTracker()
    echoed.expect('s2', MIMO)
    expect(echoed.observe('s2', MIMO, 10, MIMO)).toBe('auto')
    echoed.confirm('s2', MIMO)
    expect(echoed.isLocked('s2')).toBe(false)

    // No event observed (test rig / subscription gap): confirm books it.
    const silent = new ManualLockTracker()
    silent.expect('s3', MIMO)
    silent.confirm('s3', MIMO)
    silent.expect('s3', MIMO)
    expect(silent.observe('s3', MIMO, 20, GO)).toBe('auto') // ledger matches its own write
    expect(silent.isLocked('s3')).toBe(false)
  })

  it('locks a first human touch that diverges from both ledger and live target', () => {
    const tracker = new ManualLockTracker()
    // no ledger at all: a divergent first selection is still a human touch
    expect(tracker.observe('s1', OTHER, 10, GO)).toBe('manual-lock')
    expect(tracker.isLocked('s1')).toBe(true)
    expect(tracker.snapshot()).toEqual([{ sessionId: 's1', value: OTHER, lockedAt: 10 }])
    // another divergent touch refreshes the lock (value + time)
    expect(tracker.observe('s1', 'deepseek-official/deepseek-v4-flash-pro', 20, GO)).toBe('manual-relock')
    expect(tracker.snapshot()).toEqual([{ sessionId: 's1', value: 'deepseek-official/deepseek-v4-flash-pro', lockedAt: 20 }])
  })

  it('does not lock when the touch equals the live policy target', () => {
    const tracker = new ManualLockTracker()
    expect(tracker.observe('s1', GO, 10, GO)).toBe('aligned')
    expect(tracker.isLocked('s1')).toBe(false)
  })

  it('unlocks when a later touch realigns with the live target', () => {
    const tracker = new ManualLockTracker()
    tracker.observe('s1', OTHER, 10, GO)
    expect(tracker.observe('s1', GO, 20, GO)).toBe('aligned-unlock')
    expect(tracker.isLocked('s1')).toBe(false)
    expect(tracker.snapshot()).toEqual([])
  })

  it('unlocks when a later touch realigns with the ledger', () => {
    const tracker = new ManualLockTracker()
    tracker.expect('s1', MIMO)
    tracker.confirm('s1', MIMO) // controller owns mimo (triggered side)
    tracker.observe('s1', OTHER, 10, MIMO) // human diverges → lock
    expect(tracker.isLocked('s1')).toBe(true)
    // policy target has since flipped to go, but returning to the ledger value realigns
    expect(tracker.observe('s1', MIMO, 20, GO)).toBe('aligned-unlock')
    expect(tracker.isLocked('s1')).toBe(false)
  })

  it('a raced write inside the expectation window is judged by value', () => {
    const tracker = new ManualLockTracker()
    tracker.expect('s1', MIMO)
    // a divergent value lands before the controller's own event: judged human
    expect(tracker.observe('s1', OTHER, 10, GO)).toBe('manual-lock')
    // the controller's later confirm must NOT erase the lock
    tracker.confirm('s1', MIMO)
    expect(tracker.isLocked('s1')).toBe(true)
    expect(tracker.snapshot()[0]?.value).toBe(OTHER)
    // realigning with the confirmed ledger unlocks
    expect(tracker.observe('s1', MIMO, 30, GO)).toBe('aligned-unlock')
    // ...while touching the live target also unlocks (target rule wins first)
    const t2 = new ManualLockTracker()
    t2.expect('s1', MIMO)
    t2.observe('s1', OTHER, 10, GO)
    expect(t2.observe('s1', GO, 30, GO)).toBe('aligned-unlock')
  })

  it('abort drops the expectation so a later divergent event locks', () => {
    const tracker = new ManualLockTracker()
    tracker.expect('s1', MIMO)
    tracker.abort('s1') // the write failed — no event should have arrived
    expect(tracker.observe('s1', OTHER, 10, GO)).toBe('manual-lock')
    expect(tracker.isLocked('s1')).toBe(true)
  })

  it('is an in-memory structure: a fresh tracker starts with nothing locked', () => {
    const tracker = new ManualLockTracker()
    expect(tracker.snapshot()).toEqual([])
    expect(tracker.isLocked('s1')).toBe(false)
  })
})
