import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobRoster, type JobViewLike } from '../src/core/jobs.ts'
import {
  LiveActivityNotifier,
  type LiveActivityAddress,
  type LiveActivityNotification,
  type LiveActivitySender,
} from '../src/core/liveactivity.ts'
import { createOwnerPeer } from '../src/core/owner-peer.ts'
import { PushNotifier, type PushAddress, type PushNotification, type PushSendResult, type PushSender } from '../src/core/push.ts'
import {
  TURN_END_PHONE_PROMPTED_MAX,
  TURN_END_QUIET_INTERVAL_MS,
  TURN_END_QUIET_PROBE_TIMEOUT_MS,
  TURN_END_QUIET_REPORT_MS,
  TurnEndQuietGate,
  sessionQuietProbe,
  type QuietAnswer,
} from '../src/core/turn-end-quiet.ts'
import { StandingWatchers } from '../src/host/watchers.ts'
import { TURN_END_QUIET_MAX_ENV, turnEndQuietMaxWait } from '../src/index.ts'
import { ControllableStream, FakeGateway, FakeJobRegistry, makeConnection, requestFrame, settle } from './support/harness.ts'

/** The instant every suite starts its clock at. */
const CLOCK_START = 1_700_000_000_000

/** One follow record as DSH writes it. */
function record(type: string, seq: number, time: number, data: unknown): unknown {
  return { type: 'event', event: { type, seq, time, data } }
}

/** One assistant-stream chunk frame. */
function chunk(index: number, body: unknown): unknown {
  return { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a-1', revision: 1, index, time: 10 + index, chunk: body } }
}

/** One durable user message, in the shape its `source` decides the actor from. */
function userMessage(id: string, source: Record<string, unknown>, text = 'child settled'): unknown {
  return record('user/message', 13, 300, { id, turn: 1, content: [{ type: 'text', text }], source })
}

/** The baseline frame every follow stream opens with. */
const BASELINE = { type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] }

/** The one phone a notification is addressed to. */
const PHONE: PushAddress = { deviceToken: 'aabbccdd', environment: 'sandbox', bundle: 'dev.dsh.Whale' }

/** The one card a suite pushes to. */
const CARD: LiveActivityAddress = { activityId: 'act-1', token: 'ff00aa', sessionId: 's-1', environment: 'sandbox', bundle: 'dev.dsh.Whale' }

/** What both push paths actually delivered, in order. */
interface Sinks {
  readonly cards: LiveActivityNotification[]
  readonly notices: PushNotification[]
  readonly liveActivity: LiveActivityNotifier
  readonly push: PushNotifier
}

/** Both channels over one clock, recording what they sent. */
function sinksAt(clock: { now: number }): Sinks {
  const cards: LiveActivityNotification[] = []
  const notices: PushNotification[] = []
  const cardSender: LiveActivitySender = {
    async sendLiveActivity(target, notification): Promise<PushSendResult> {
      cards.push(notification)
      return { ok: true, status: 200 }
    },
  }
  const phoneSender: PushSender = {
    async send(target, notification): Promise<PushSendResult> {
      notices.push(notification)
      return { ok: true, status: 200 }
    },
  }
  return {
    cards,
    notices,
    liveActivity: new LiveActivityNotifier({ targets: () => [CARD], sender: cardSender, now: () => clock.now }),
    push: new PushNotifier({ targets: () => [PHONE], sender: phoneSender, now: () => clock.now }),
  }
}

/**
 * Install the one timer kind these suites move.
 *
 * Only the timeout pair is faked: `Date.now()` keeps running where the connection
 * reads it, and every gate in these suites is handed the same clock the timers are
 * advanced by, so a wait is a fact about the suite rather than about wall time.
 */
function useSuiteClock(): { readonly clock: { now: number } } {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return { clock: { now: CLOCK_START } }
}

/** Move the suite clock and the fake timers by the same span. */
function advance(clock: { now: number }, ms: number): void {
  clock.now += ms
  vi.advanceTimersByTime(ms)
}

/** One `session/list` row in the shape the probe reads it. */
function sessionRow(sessionId: string, running: boolean, parentSessionId?: string): Record<string, unknown> {
  return { sessionId, running, ...(parentSessionId === undefined ? {} : { parentSessionId }) }
}

/** Point one gateway at a fixed session-list answer. */
function listOf(gateway: FakeGateway, rows: readonly Record<string, unknown>[]): void {
  gateway.handler = async (call) => (call.method === 'list' ? { items: rows } : { accepted: true })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('turn-end quiet gate: one answer to "is this session still working"', () => {
  it('user hears about a finished turn only once the host reports the session quiet', async () => {
    // Given a bridge whose channels are on and a host that still reports work under the session
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    const quietAt = CLOCK_START + 2 * TURN_END_QUIET_INTERVAL_MS
    const probe = async (): Promise<QuietAnswer> => (clock.now >= quietAt ? { quiet: true } : { quiet: false, busy: 'session-running' })
    const gate = new TurnEndQuietGate({ push: sink.push, liveActivity: sink.liveActivity, probe, now: () => clock.now, log: line => { lines.push(line) } })
    // When one turn ends
    gate.noteTurnEnd('s-1', 'completed')
    // Then nothing is announced at the frame, on either channel
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    expect(gate.held).toBe(1)
    // And the first question to the host still finds work in progress
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    // When the host answers quiet at the next question
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then one notification and one card end went out for that turn
    expect(sink.notices).toHaveLength(1)
    expect(sink.notices[0]?.st).toBe('turn-end')
    expect(sink.notices[0]?.s).toBe('s-1')
    expect(sink.cards).toHaveLength(1)
    expect(sink.cards[0]?.aps.event).toBe('end')
    expect(sink.cards[0]?.aps['content-state']).toMatchObject({ phase: 'ended' })
    // And one line says how long it waited
    expect(lines).toContain('turn-end quiet session=s-1 waited=10000ms event=turn-end')
    expect(gate.held).toBe(0)
    gate.dispose()
  })

  it('user hears about a failed turn after the same wait and the card says failed', async () => {
    // Given a bridge whose host reports the session quiet at once
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const gate = new TurnEndQuietGate({ push: sink.push, liveActivity: sink.liveActivity, probe: async () => ({ quiet: true }), now: () => clock.now })
    // When a turn ends abnormally
    gate.noteTurnEnd('s-1', 'error')
    // Then both channels wait for the first question rather than the frame
    expect(sink.notices).toHaveLength(0)
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // And the abnormal reason decides both surfaces
    expect(sink.notices).toHaveLength(1)
    expect(sink.notices[0]?.st).toBe('turn-error')
    expect(sink.cards).toHaveLength(1)
    expect(sink.cards[0]?.aps['content-state']).toMatchObject({ phase: 'failed' })
    gate.dispose()
  })

  it('user is told nothing while the family stays busy, however long the turn end is held', async () => {
    // Given a host that never reports the family quiet
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: false, busy: 'job-live(job-9)' }),
      now: () => clock.now,
      log: line => { lines.push(line) },
    })
    // When the turn ends and the hold reaches the bridge's own report point
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(TURN_END_QUIET_REPORT_MS).toBe(600_000)
    expect(sink.notices).toHaveLength(0)
    advance(clock, TURN_END_QUIET_REPORT_MS - TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then nothing has been announced on either channel, and one line says the wait goes on
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    expect(lines.filter(line => line.includes('still waiting'))).toHaveLength(1)
    expect(lines).toContain('turn-end still waiting session=s-1 waited=600000ms busy=job-live(job-9), nothing announced')
    expect(gate.held).toBe(1)
    // When a minute more passes with the family still busy
    advance(clock, 60_000)
    await settle()
    // Then the turn end is still held and still unannounced, and the line was written once
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    expect(gate.held).toBe(1)
    expect(lines.filter(line => line.includes('still waiting'))).toHaveLength(1)
    gate.dispose()
  })

  it('operator moves the still-waiting line with one environment variable and no send moves with it', async () => {
    // Given the bridge's own default and one configured point
    expect(turnEndQuietMaxWait({})).toBe(600_000)
    expect(turnEndQuietMaxWait({ [TURN_END_QUIET_MAX_ENV]: '1500' })).toBe(1500)
    // Then an unreadable or non-positive value falls back instead of closing the window
    expect(turnEndQuietMaxWait({ [TURN_END_QUIET_MAX_ENV]: '0' })).toBe(600_000)
    expect(turnEndQuietMaxWait({ [TURN_END_QUIET_MAX_ENV]: 'nonsense' })).toBe(600_000)
    // When a gate runs on the configured point over a family that stays busy
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: false, busy: 'session-running' }),
      now: () => clock.now,
      log: line => { lines.push(line) },
      intervalMs: 500,
      reportAfterMs: turnEndQuietMaxWait({ [TURN_END_QUIET_MAX_ENV]: '1500' }),
    })
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, 1_000)
    await settle()
    expect(sink.notices).toHaveLength(0)
    expect(lines.some(line => line.includes('still waiting'))).toBe(false)
    advance(clock, 500)
    await settle()
    // Then the line is written at the configured point rather than the constant, and the
    // turn end is still held: the knob moves a log line, never a send
    expect(lines.some(line => line.includes('still waiting'))).toBe(true)
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    expect(gate.held).toBe(1)
    gate.dispose()
  })

  it('user who starts another turn is not told the finished one ended', async () => {
    // Given a gate holding one turn end for a session that is still busy
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: false, busy: 'session-running' }),
      now: () => clock.now,
      log: line => { lines.push(line) },
    })
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(gate.held).toBe(1)
    // When another turn starts on that session
    gate.noteTurnStarted('s-1')
    // Then the held turn end is gone, and the line says why
    expect(gate.held).toBe(0)
    expect(lines).toContain('turn-end dropped session=s-1 reason=new-turn')
    // And nothing is announced even long after the budget would have run out
    advance(clock, TURN_END_QUIET_REPORT_MS)
    await settle()
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    gate.dispose()
  })

  it('operator sees a second turn announce inside the window because the window is booked at the send', async () => {
    // Given an announced turn end for one session
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    let quietAt = CLOCK_START
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => (clock.now >= quietAt ? { quiet: true } : { quiet: false, busy: 'session-running' }),
      now: () => clock.now,
      log: line => { lines.push(line) },
    })
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(sink.notices).toHaveLength(1)
    // When another turn ends twenty-five seconds after that send and only goes quiet thirty-five seconds after it
    quietAt = CLOCK_START + 40_000
    advance(clock, 25_000)
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(sink.notices).toHaveLength(1)
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then it is delivered: the thirty-second window was booked at the real send, not at the registration
    expect(sink.notices).toHaveLength(2)
    // When a third turn ends inside that window
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then the window drops it, exactly as it drops any notification sent too soon
    expect(sink.notices).toHaveLength(2)
    gate.dispose()
  })

  it('user is told nothing on a bridge that holds no signing key', async () => {
    // Given a bridge whose two channels are both off
    const { clock } = useSuiteClock()
    const asked: string[] = []
    const gate = new TurnEndQuietGate({
      probe: async (sessionId): Promise<QuietAnswer> => {
        asked.push(sessionId)
        return { quiet: true }
      },
      now: () => clock.now,
    })
    // When a turn ends
    gate.noteTurnEnd('s-1', 'completed')
    // Then nothing is held, no timer exists and the host is never asked
    expect(gate.enabled).toBe(false)
    expect(gate.held).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    advance(clock, TURN_END_QUIET_REPORT_MS)
    await settle()
    expect(asked).toEqual([])
    gate.dispose()
  })

  it('operator closes the gate and every held turn end goes with it', async () => {
    // Given a gate holding one turn end with its questions armed
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: false, busy: 'session-running' }),
      now: () => clock.now,
    })
    gate.noteTurnEnd('s-1', 'completed')
    expect(gate.held).toBe(1)
    // Then both of its timers exist: the next question and the deadline
    expect(vi.getTimerCount()).toBe(2)
    // When the bridge unloads
    gate.dispose()
    // Then no timer is left and nothing is announced afterwards
    expect(vi.getTimerCount()).toBe(0)
    expect(gate.held).toBe(0)
    advance(clock, TURN_END_QUIET_REPORT_MS)
    await settle()
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
  })

  it('user waits for the whole family, whichever member is the one still working', async () => {
    // Given a host whose session list names a root, a child and a grandchild
    const gateway = new FakeGateway()
    const registry = new FakeJobRegistry()
    const jobs = new JobRoster({ faces: () => ({ jobs: registry }), log: () => undefined })
    const probe = sessionQuietProbe({ gateway, peer: createOwnerPeer(new Context()), jobs })
    listOf(gateway, [sessionRow('s-1', false), sessionRow('s-2', true, 's-1'), sessionRow('s-3', false, 's-2')])
    // Then the root is not quiet while the work under it is still going
    expect(await probe('s-1')).toEqual({ quiet: false, busy: 'descendant-running(s-2)' })
    // And a grandchild is not quiet either: the family is the root's, so a leaf waits
    // for the running member above it instead of announcing its own turn end
    expect(await probe('s-3')).toEqual({ quiet: false, busy: 'ancestor-running(s-2)' })
    expect(await probe('s-2')).toEqual({ quiet: false, busy: 'session-running' })
    // And a session in another tree is not made to wait for that work
    listOf(gateway, [sessionRow('s-1', false), sessionRow('s-2', true, 's-1'), sessionRow('s-9', false)])
    expect(await probe('s-9')).toEqual({ quiet: true })
    // When the host's own chain loops back on itself
    listOf(gateway, [sessionRow('s-4', false, 's-5'), sessionRow('s-5', false, 's-4'), sessionRow('s-6', true, 's-6')])
    // Then the walk stops instead of following it
    expect(await probe('s-4')).toEqual({ quiet: true })
    // And a looping chain stops at the repeat rather than climbing for ever, which
    // leaves the two sessions in one family — what the chain itself claims
    listOf(gateway, [sessionRow('s-4', false, 's-5'), sessionRow('s-5', true, 's-4')])
    expect(await probe('s-4')).toEqual({ quiet: false, busy: 'descendant-running(s-5)' })
    jobs.dispose()
  })

  it('user waits for a job the host still holds under any member of the family', async () => {
    // Given a host holding a job owned by a grandchild session, still stopping
    const gateway = new FakeGateway()
    const registry = new FakeJobRegistry()
    const jobs = new JobRoster({ faces: () => ({ jobs: registry }), log: () => undefined })
    const probe = sessionQuietProbe({ gateway, peer: createOwnerPeer(new Context()), jobs })
    listOf(gateway, [sessionRow('s-1', false), sessionRow('s-2', false, 's-1'), sessionRow('s-3', false, 's-2')])
    const stopping: JobViewLike = { id: 'job-1', kind: 'bash', label: 'build', owner: 's-3', status: 'stopping', startedAt: 1 }
    const unowned: JobViewLike = { id: 'job-0', kind: 'bash', label: 'nobody', status: 'running', startedAt: 1 }
    const stranger: JobViewLike = { id: 'job-2', kind: 'bash', label: 'elsewhere', owner: 'x-9', status: 'running', startedAt: 1 }
    registry.set([stopping, unowned, stranger])
    // Then the root waits for it, a job no session owns is not its work, and a job
    // another family owns is not either
    expect(await probe('s-1')).toEqual({ quiet: false, busy: 'job-live(job-1)' })
    // When the host's own projection says that job finished
    registry.set([{ ...stopping, status: 'succeeded', finishedAt: 2 }, unowned, stranger])
    expect(await probe('s-1')).toEqual({ quiet: true })
    // When the session's own agent is the one running
    listOf(gateway, [sessionRow('s-1', true)])
    expect(await probe('s-1')).toEqual({ quiet: false, busy: 'session-running' })
    // And a host that composes no job registry holds no job this bridge can name
    const bare = new JobRoster({ faces: () => ({}), log: () => undefined })
    const bareProbe = sessionQuietProbe({ gateway, peer: createOwnerPeer(new Context()), jobs: bare })
    listOf(gateway, [sessionRow('s-1', false)])
    expect(await bareProbe('s-1')).toEqual({ quiet: true })
    jobs.dispose()
    bare.dispose()
  })

  it('user following a session is told the turn ended once the session is quiet', async () => {
    // Given a paired phone following one session and a gate over the same channels
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const quietAt = CLOCK_START + 2 * TURN_END_QUIET_INTERVAL_MS
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => (clock.now >= quietAt ? { quiet: true } : { quiet: false, busy: 'session-running' }),
      now: () => clock.now,
    })
    const harness = makeConnection({ paired: true, push: sink.push, liveActivity: sink.liveActivity, turnEndQuiet: gate })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(2, 'session.snapshot', { sessionId: 's-1' }))
    follow.push(BASELINE)
    await pending
    // When the turn ends while the host still reports that session running
    follow.push(record('turn/end', 12, 201, { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    // Then the increment reached the phone and no announcement went out
    expect(harness.transport.ofType('ev').filter(frame => frame.m === 'session.delta')).toHaveLength(1)
    expect(sink.notices).toHaveLength(0)
    // And the next question still finds it working
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(sink.notices).toHaveLength(0)
    // When the host answers quiet at the question after that
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then one notification and one card end went out for that turn
    expect(sink.notices).toHaveLength(1)
    expect(sink.notices[0]?.st).toBe('turn-end')
    expect(sink.cards).toHaveLength(1)
    expect(sink.cards[0]?.aps.event).toBe('end')
    gate.dispose()
    harness.connection.dispose()
  })

  it('user who prompts again is not told the previous turn ended', async () => {
    // Given a followed session whose turn end is held
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: true }),
      now: () => clock.now,
      log: line => { lines.push(line) },
    })
    const harness = makeConnection({ paired: true, push: sink.push, liveActivity: sink.liveActivity, turnEndQuiet: gate })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(3, 'session.snapshot', { sessionId: 's-1' }))
    follow.push(BASELINE)
    await pending
    follow.push(record('turn/end', 12, 201, { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    expect(gate.held).toBe(1)
    // When the phone's own stream carries an increment of the next turn
    follow.push(chunk(0, { type: 'text-delta', index: 0, text: 'again' }))
    await settle()
    // Then the held turn end is dropped and the line says why
    expect(gate.held).toBe(0)
    expect(lines).toContain('turn-end dropped session=s-1 reason=new-turn')
    // And no announcement is made for the turn the user already left behind
    advance(clock, TURN_END_QUIET_REPORT_MS)
    await settle()
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    gate.dispose()
    harness.connection.dispose()
  })

  it('user is still told the turn ended when a settled child reports on the parent stream', async () => {
    // Given a followed session whose turn end is held while its child is still running
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: true }),
      now: () => clock.now,
    })
    const harness = makeConnection({ paired: true, push: sink.push, liveActivity: sink.liveActivity, turnEndQuiet: gate })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(4, 'session.snapshot', { sessionId: 's-1' }))
    follow.push(BASELINE)
    await pending
    follow.push(record('turn/end', 12, 201, { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    expect(gate.held).toBe(1)
    // When that child settles and the host pushes the notice of it onto the parent
    follow.push(userMessage('m-settled', { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-9' }))
    await settle()
    // Then the held end survives, because a settled child is not a new turn
    expect(gate.held).toBe(1)
    // And it is announced once the session is quiet
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(sink.notices).toHaveLength(1)
    expect(sink.notices[0]?.st).toBe('turn-end')
    expect(sink.cards).toHaveLength(1)
    expect(sink.cards[0]?.aps.event).toBe('end')
    gate.dispose()
    harness.connection.dispose()
  })

  it('user is still told the turn ended when the host publishes a usage count', async () => {
    // Given a followed session whose turn end is held
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: true }),
      now: () => clock.now,
    })
    const harness = makeConnection({ paired: true, push: sink.push, liveActivity: sink.liveActivity, turnEndQuiet: gate })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(5, 'session.snapshot', { sessionId: 's-1' }))
    follow.push(BASELINE)
    await pending
    follow.push(record('turn/end', 12, 201, { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    expect(gate.held).toBe(1)
    // When the finished assistant message delivers its usage count on the same stream
    follow.push(record('assistant/message', 13, 202, { turn: 1, step: 1, content: [{ type: 'text', text: 'done' }], usage: { inputTokens: 10, outputTokens: 5 } }))
    await settle()
    // Then the held end survives, because a token count is not a new turn
    expect(gate.held).toBe(1)
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(sink.notices).toHaveLength(1)
    expect(sink.cards).toHaveLength(1)
    gate.dispose()
    harness.connection.dispose()
  })

  it('operator sees the card end survive the notice of a settled child', async () => {
    // Given a standing watcher on a carded session, with its turn end held
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: true }),
      now: () => clock.now,
    })
    const gateway = new FakeGateway()
    const stream = new ControllableStream()
    gateway.follow = call => stream.attach(call.signal).iterable()
    const watchers = new StandingWatchers({
      gateway,
      peer: createOwnerPeer(new Context()),
      sessions: () => ['s-1'],
      liveActivity: sink.liveActivity,
      push: sink.push,
      turnEndQuiet: gate,
      log: () => undefined,
    })
    watchers.sync()
    stream.push(BASELINE)
    stream.push(record('turn/end', 12, 201, { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    expect(gate.held).toBe(1)
    // When the settled child's notice arrives on that same stream
    stream.push(userMessage('m-settled', { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-9' }))
    await settle()
    // Then the held end survives the notice
    expect(gate.held).toBe(1)
    // And both surfaces report it once the session is quiet
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(sink.notices).toHaveLength(1)
    expect(sink.cards).toHaveLength(1)
    expect(sink.cards[0]?.aps.event).toBe('end')
    watchers.dispose()
    gate.dispose()
  })

  it('user prompting again from this stream is what drops the finished turn', async () => {
    // Given a followed session whose turn end is held
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: true }),
      now: () => clock.now,
      log: line => { lines.push(line) },
    })
    const harness = makeConnection({ paired: true, push: sink.push, liveActivity: sink.liveActivity, turnEndQuiet: gate })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(6, 'session.snapshot', { sessionId: 's-1' }))
    follow.push(BASELINE)
    await pending
    follow.push(record('turn/end', 12, 201, { turn: 1, reason: { kind: 'completed' } }))
    await settle()
    expect(gate.held).toBe(1)
    // When this session's own user prompts again
    follow.push(userMessage('m-human', { kind: 'user' }, 'one more thing'))
    await settle()
    // Then the held end is dropped, and the line says why
    expect(gate.held).toBe(0)
    expect(lines).toContain('turn-end dropped session=s-1 reason=new-turn')
    // And nothing is announced for the turn the user already left behind
    advance(clock, TURN_END_QUIET_REPORT_MS)
    await settle()
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    gate.dispose()
    harness.connection.dispose()
  })

  it('user hears nothing while any depth of the family runs and hears the turn end once the family is quiet', async () => {
    // Given a host whose root session is idle while its child and grandchild still work
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const gateway = new FakeGateway()
    const registry = new FakeJobRegistry()
    const jobs = new JobRoster({ faces: () => ({ jobs: registry }), log: () => undefined })
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: sessionQuietProbe({ gateway, peer: createOwnerPeer(new Context()), jobs }),
      now: () => clock.now,
    })
    listOf(gateway, [sessionRow('s-1', false), sessionRow('s-2', true, 's-1'), sessionRow('s-3', true, 's-2')])
    // When the root's turn ends
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then nothing is announced for it on either channel
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    expect(gate.held).toBe(1)
    // When only the grandchild is still going
    listOf(gateway, [sessionRow('s-1', false), sessionRow('s-2', false, 's-1'), sessionRow('s-3', true, 's-2')])
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(sink.notices).toHaveLength(0)
    expect(gate.held).toBe(1)
    // When the whole family is idle
    listOf(gateway, [sessionRow('s-1', false), sessionRow('s-2', false, 's-1'), sessionRow('s-3', false, 's-2')])
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then one notification and one card end went out, for the session whose turn ended
    expect(sink.notices).toHaveLength(1)
    expect(sink.notices[0]?.st).toBe('turn-end')
    expect(sink.notices[0]?.s).toBe('s-1')
    expect(sink.cards).toHaveLength(1)
    expect(gate.held).toBe(0)
    // And a further wait says nothing more about that turn
    advance(clock, TURN_END_QUIET_INTERVAL_MS * 10)
    await settle()
    expect(sink.notices).toHaveLength(1)
    expect(sink.cards).toHaveLength(1)
    gate.dispose()
    jobs.dispose()
  })

  it('user hears nothing while a job lives under any member of the family and hears it once the job is done', async () => {
    // Given a host holding a live job under a grandchild of the session that ended
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const gateway = new FakeGateway()
    const registry = new FakeJobRegistry()
    const jobs = new JobRoster({ faces: () => ({ jobs: registry }), log: () => undefined })
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: sessionQuietProbe({ gateway, peer: createOwnerPeer(new Context()), jobs }),
      now: () => clock.now,
    })
    listOf(gateway, [sessionRow('s-1', false), sessionRow('s-2', false, 's-1'), sessionRow('s-3', false, 's-2')])
    const build: JobViewLike = { id: 'job-7', kind: 'bash', label: 'build', owner: 's-3', status: 'running', startedAt: 1 }
    const unowned: JobViewLike = { id: 'job-0', kind: 'bash', label: 'nobody', status: 'running', startedAt: 1 }
    registry.set([build, unowned])
    // When the root's turn ends
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then the family's work holds it back, and a job no session owns never does
    expect(sink.notices).toHaveLength(0)
    expect(gate.held).toBe(1)
    // When the host's own projection says that job finished
    registry.set([{ ...build, status: 'succeeded', finishedAt: 2 }, unowned])
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then the turn end is announced
    expect(sink.notices).toHaveLength(1)
    expect(sink.notices[0]?.s).toBe('s-1')
    expect(gate.held).toBe(0)
    gate.dispose()
    jobs.dispose()
  })

  it('user is told nothing about a subagent session the phone never prompted', async () => {
    // Given a host that says the session was spawned by another one
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: true, subagent: true }),
      now: () => clock.now,
      log: line => { lines.push(line) },
    })
    // When that subagent session ends its own turn
    gate.noteTurnEnd('s-child', 'completed')
    expect(gate.held).toBe(1)
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then the registration is dropped on the host's own word, in one line
    expect(gate.held).toBe(0)
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    expect(lines).toContain('turn-end dropped session=s-child reason=subagent-not-prompted')
    // And nothing arrives for it later either
    advance(clock, TURN_END_QUIET_REPORT_MS)
    await settle()
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    gate.dispose()
  })

  it('user who prompted a subagent session itself is told when its family falls quiet', async () => {
    // Given a gate and a paired phone, and a host that says the session is a subagent's
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: true, subagent: true }),
      now: () => clock.now,
    })
    const harness = makeConnection({ paired: true, push: sink.push, liveActivity: sink.liveActivity, turnEndQuiet: gate })
    // When the phone prompts that session over the wire
    await harness.connection.handleText(requestFrame(7, 'session.prompt', { sessionId: 's-child', text: 'keep going', requestId: 'r-1' }))
    expect(harness.gateway.lastArgs('session', 'prompt')).toMatchObject({ request: { sessionId: 's-child' } })
    // And its turn ends while the host says the family is quiet
    gate.noteTurnEnd('s-child', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then that turn end is announced, addressed to the session the phone prompted
    expect(sink.notices).toHaveLength(1)
    expect(sink.notices[0]?.st).toBe('turn-end')
    expect(sink.notices[0]?.s).toBe('s-child')
    // And the card path ends a card only for the session it names, which is another one
    expect(sink.cards).toHaveLength(0)
    expect(gate.held).toBe(0)
    gate.dispose()
    harness.connection.dispose()
  })

  it('user is told nothing while the host cannot answer and the held turn end survives the failed question', async () => {
    // Given a host whose session list cannot be read for now
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    let readable = false
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async (): Promise<QuietAnswer> => {
        if (!readable) throw new Error('gateway closed')
        return { quiet: true }
      },
      now: () => clock.now,
      log: line => { lines.push(line) },
    })
    // When the turn ends and the question gets no answer
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then nothing is announced, the entry is still held, and the failure is one line
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    expect(gate.held).toBe(1)
    expect(lines).toContain('turn-end quiet check failed session=s-1: gateway closed')
    // When the host does answer at the next question
    readable = true
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then the turn end is announced
    expect(sink.notices).toHaveLength(1)
    expect(sink.cards).toHaveLength(1)
    expect(gate.held).toBe(0)
    gate.dispose()
  })

  it('operator sees a question the host never answers abandoned and asked again, never a quiet answer', async () => {
    // Given a host whose every question hangs
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    const asked: string[] = []
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: (sessionId): Promise<QuietAnswer> => {
        asked.push(sessionId)
        return new Promise<QuietAnswer>(() => undefined)
      },
      now: () => clock.now,
      log: line => { lines.push(line) },
    })
    // When the turn ends and a minute passes with no answer at all
    gate.noteTurnEnd('s-1', 'completed')
    // The clock is stepped rather than jumped: a question leaves on a microtask, and a
    // real clock lets that microtask run between two timers, so only stepping models it
    for (let elapsed = 0; elapsed < 60_000; elapsed += TURN_END_QUIET_INTERVAL_MS) {
      advance(clock, TURN_END_QUIET_INTERVAL_MS)
      await settle()
    }
    // Then nothing was announced for it, and the entry is still held
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    expect(gate.held).toBe(1)
    // And the bound gave that question up in one line instead of waiting for ever
    expect(lines).toContain(`turn-end quiet check unreadable session=s-1 after=${TURN_END_QUIET_PROBE_TIMEOUT_MS}ms`)
    // And the entry asked again on its interval rather than stopping at that question
    expect(asked.length).toBeGreaterThan(1)
    gate.dispose()
  })

  it('user hears the turn end once a later question answers quiet after the first one never came back', async () => {
    // Given a host that hangs on the first question and answers the question after it
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    let asked = 0
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: (): Promise<QuietAnswer> => {
        asked += 1
        return asked === 1 ? new Promise<QuietAnswer>(() => undefined) : Promise.resolve<QuietAnswer>({ quiet: true })
      },
      now: () => clock.now,
      log: line => { lines.push(line) },
    })
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(asked).toBe(1)
    // When that first question outlives its bound
    advance(clock, TURN_END_QUIET_PROBE_TIMEOUT_MS)
    await settle()
    // Then the entry is held rather than dropped, and one line says nothing came back
    expect(gate.held).toBe(1)
    expect(sink.notices).toHaveLength(0)
    expect(lines.some(line => line.includes('unreadable'))).toBe(true)
    // When the next question finds the family quiet
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then exactly one notification goes out, for the session whose turn ended
    expect(sink.notices).toHaveLength(1)
    expect(sink.notices[0]?.s).toBe('s-1')
    expect(sink.cards).toHaveLength(1)
    expect(gate.held).toBe(0)
    gate.dispose()
  })

  it('operator gets nothing from a question that answers after the bound abandoned it, and no extra question', async () => {
    // Given a host whose first question answers by hand and whose later ones stay busy
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const asked: string[] = []
    let release: ((answer: QuietAnswer) => void) | undefined
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: (sessionId): Promise<QuietAnswer> => {
        asked.push(sessionId)
        if (asked.length > 1) return Promise.resolve<QuietAnswer>({ quiet: false, busy: 'session-running' })
        return new Promise<QuietAnswer>(resolve => { release = resolve })
      },
      now: () => clock.now,
    })
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(asked).toHaveLength(1)
    // When that question outlives its bound and the entry asks again
    advance(clock, TURN_END_QUIET_PROBE_TIMEOUT_MS)
    await settle()
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(asked).toHaveLength(2)
    // When the abandoned question finally comes back with a quiet answer
    release?.({ quiet: true })
    await settle()
    // Then it announces nothing and asks nothing: its generation is no longer current
    expect(sink.notices).toHaveLength(0)
    expect(sink.cards).toHaveLength(0)
    expect(asked).toHaveLength(2)
    expect(gate.held).toBe(1)
    // And the entry keeps its own cadence from the question really in flight
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(asked).toHaveLength(3)
    gate.dispose()
  })

  it('user hears the turn end from a question that answers slowly but inside its bound', async () => {
    // Given a host that takes most of the bound to answer
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const lines: string[] = []
    let release: ((answer: QuietAnswer) => void) | undefined
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: () => new Promise<QuietAnswer>(resolve => { release = resolve }),
      now: () => clock.now,
      log: line => { lines.push(line) },
    })
    gate.noteTurnEnd('s-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(typeof release).toBe('function')
    // When the answer arrives nine seconds later, still inside the bound
    advance(clock, 9_000)
    release?.({ quiet: true })
    await settle()
    // Then the turn end is announced, and no question was given up on the way
    expect(sink.notices).toHaveLength(1)
    expect(sink.notices[0]?.s).toBe('s-1')
    expect(sink.cards).toHaveLength(1)
    expect(lines.some(line => line.includes('unreadable'))).toBe(false)
    expect(gate.held).toBe(0)
    gate.dispose()
  })

  it('user gets an error from a session list with no item table, never a quiet answer', async () => {
    // Given a probe over one gateway
    const gateway = new FakeGateway()
    const jobs = new JobRoster({ faces: () => ({}), log: () => undefined })
    const probe = sessionQuietProbe({ gateway, peer: createOwnerPeer(new Context()), jobs })
    // When the host answers the session list with something else entirely
    gateway.handler = async () => ({})
    // Then the probe throws instead of claiming the family is quiet
    await expect(probe('s-1')).rejects.toThrow('session/list returned no item table')
    jobs.dispose()
  })

  it('operator gets a capped memory of what the phone prompted, oldest dropped first', async () => {
    // Given the bridge's own ceiling and a gate lowered to two sessions
    expect(TURN_END_PHONE_PROMPTED_MAX).toBe(5_000)
    const { clock } = useSuiteClock()
    const sink = sinksAt(clock)
    const gate = new TurnEndQuietGate({
      push: sink.push,
      liveActivity: sink.liveActivity,
      probe: async () => ({ quiet: true, subagent: true }),
      now: () => clock.now,
      phonePromptLimit: 2,
    })
    gate.notePhonePrompt('s-a')
    gate.notePhonePrompt('s-b')
    // When a third session is prompted
    gate.notePhonePrompt('s-c')
    // Then the oldest was forgotten, so its subagent turn end is dropped again
    gate.noteTurnEnd('s-a', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(sink.notices).toHaveLength(0)
    expect(gate.held).toBe(0)
    // And the two most recent are still remembered
    gate.noteTurnEnd('s-b', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    expect(sink.notices).toHaveLength(1)
    expect(sink.notices[0]?.s).toBe('s-b')
    gate.dispose()
    // When a deployment asks for more than the bridge allows, the ceiling still holds
    const capped = sinksAt(clock)
    const ceiling = new TurnEndQuietGate({
      push: capped.push,
      liveActivity: capped.liveActivity,
      probe: async () => ({ quiet: true, subagent: true }),
      now: () => clock.now,
      phonePromptLimit: 99_999,
    })
    for (let index = 1; index <= TURN_END_PHONE_PROMPTED_MAX + 1; index += 1) ceiling.notePhonePrompt(`p-${index}`)
    ceiling.noteTurnEnd('p-1', 'completed')
    advance(clock, TURN_END_QUIET_INTERVAL_MS)
    await settle()
    // Then the first of those was evicted rather than kept, so nothing is announced for it
    expect(capped.notices).toHaveLength(0)
    expect(ceiling.held).toBe(0)
    ceiling.dispose()
  })
})
