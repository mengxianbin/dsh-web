/**
 * ACK bookkeeping for delivered steers: one structured `[steer-ack]` line per
 * delivery that reaches the model, pairing the route's delivery timestamp with
 * the first response that read the message. Pins the fail-open contract
 * (never throws into the event stream), the pairing gates (rpcId match, same
 * session, injection before response), and the bounded pending cap.
 */
import { describe, expect, it } from 'vitest'
import { SteerAckTracker, formatSteerAck, type SteerAckEvent, type SteerAckRecord } from '../src/host/steer-ack.ts'

function userMessage(rpcId: string, time: number): SteerAckEvent {
  return { type: 'user/message', time, data: { source: { kind: 'user', rpcId } } }
}

function assistantMessage(time: number): SteerAckEvent {
  return { type: 'assistant/message', time, data: { turn: 1, step: 1 } }
}

function tracker(log: string[], extra: { now?: () => number; maxPending?: number } = {}): SteerAckTracker {
  return new SteerAckTracker({
    log: (line) => { log.push(line) },
    ...extra.now === undefined ? {} : { now: extra.now },
    ...extra.maxPending === undefined ? {} : { maxPending: extra.maxPending },
  })
}

describe('SteerAckTracker', () => {
  it('emits one line pairing delivery with the first response after injection', () => {
    const log: string[] = []
    const subject = tracker(log)
    subject.delivered('s1', 'req-1', 1_000)
    expect(subject.pendingCount).toBe(1)
    subject.observe('s1', userMessage('req-1', 1_500))
    subject.observe('s1', assistantMessage(2_340))
    expect(log).toHaveLength(1)
    expect(log[0]).toBe(
      '[steer-ack] sessionId=s1 requestId=req-1 '
      + 'deliveredAt=1970-01-01T00:00:01.000Z injectedAt=1970-01-01T00:00:01.500Z '
      + 'firstResponseAt=1970-01-01T00:00:02.340Z latencyMs=1340',
    )
    expect(subject.pendingCount).toBe(0)
  })

  it('ignores a response that arrives before the steered message is injected', () => {
    const log: string[] = []
    const subject = tracker(log)
    subject.delivered('s1', 'req-1', 1_000)
    // The current step's response, produced before the boundary claim.
    subject.observe('s1', assistantMessage(1_200))
    expect(log).toHaveLength(0)
    expect(subject.pendingCount).toBe(1)
    // The boundary injection then the next response completes the pair.
    subject.observe('s1', userMessage('req-1', 1_500))
    subject.observe('s1', assistantMessage(2_000))
    expect(log).toHaveLength(1)
    expect(log[0]).toContain('latencyMs=1000')
  })

  it('pairs only on the delivery own requestId in the same session', () => {
    const log: string[] = []
    const subject = tracker(log)
    subject.delivered('s1', 'req-1', 1_000)
    // Another user message (different rpcId) does not count as injection.
    subject.observe('s1', userMessage('other', 1_100))
    subject.observe('s1', assistantMessage(1_200))
    expect(log).toHaveLength(0)
    // The same rpcId in a different session does not count either.
    subject.observe('s2', userMessage('req-1', 1_300))
    subject.observe('s2', assistantMessage(1_400))
    expect(log).toHaveLength(0)
    subject.observe('s1', userMessage('req-1', 1_500))
    subject.observe('s1', assistantMessage(1_600))
    expect(log).toHaveLength(1)
    expect(log[0]).toContain('sessionId=s1')
  })

  it('never emits a line for a queue delivery (no delivered() call)', () => {
    const log: string[] = []
    const subject = tracker(log)
    subject.observe('s1', userMessage('req-q', 1_000))
    subject.observe('s1', assistantMessage(1_100))
    expect(log).toHaveLength(0)
    expect(subject.pendingCount).toBe(0)
  })

  it('evicts the oldest pending entry at the cap instead of growing unbounded', () => {
    const log: string[] = []
    const subject = tracker(log, { maxPending: 2 })
    subject.delivered('s1', 'req-1', 1_000)
    subject.delivered('s1', 'req-2', 2_000)
    subject.delivered('s1', 'req-3', 3_000)
    expect(subject.pendingCount).toBe(2)
    // req-1 was evicted: its injection no longer pairs.
    subject.observe('s1', userMessage('req-1', 4_000))
    subject.observe('s1', assistantMessage(4_100))
    expect(log).toHaveLength(0)
  })

  it('fails open on malformed events without throwing', () => {
    const log: string[] = []
    const subject = tracker(log)
    subject.delivered('s1', 'req-1', 1_000)
    expect(() => subject.observe('s1', { type: 'user/message', time: 1, data: null })).not.toThrow()
    expect(() => subject.observe('s1', { type: 'assistant/message', time: 1, data: undefined })).not.toThrow()
    expect(() => subject.observe('s1', { type: 'turn/start', time: 1, data: { turn: 1 } })).not.toThrow()
    expect(log).toHaveLength(0)
    expect(subject.pendingCount).toBe(1)
  })

  it('renders a record in the session-stop audit-line shape', () => {
    const record: SteerAckRecord = {
      sessionId: 's9',
      requestId: 'session-send-abc',
      deliveredAt: 1_700_000_000_000,
      injectedAt: 1_700_000_002_000,
      firstResponseAt: 1_700_000_005_500,
      latencyMs: 5_500,
    }
    expect(formatSteerAck(record)).toBe(
      '[steer-ack] sessionId=s9 requestId=session-send-abc '
      + 'deliveredAt=2023-11-14T22:13:20.000Z injectedAt=2023-11-14T22:13:22.000Z '
      + 'firstResponseAt=2023-11-14T22:13:25.500Z latencyMs=5500',
    )
  })
})
