import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_FRAME_BYTES } from '../src/core/envelope.ts'
import { ControllableStream, answerOf, makeConnection, requestFrame, settle, type ConnectionHarness } from './support/harness.ts'

/** One follow record as DSH writes it. */
function record(type: string, seq: number, time: number, data: unknown): unknown {
  return { type: 'event', event: { type, seq, time, data } }
}

/** One assistant-stream chunk frame. */
function chunk(index: number, body: unknown): unknown {
  return { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a-1', revision: 1, index, time: 10 + index, chunk: body } }
}

/** One entry of a snapshot turn as the wire carries it. */
interface WireEntry {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

/** One snapshot turn as the wire carries it. */
interface WireTurn {
  readonly seq: number
  readonly endSeq: number
  readonly reason: string
  readonly entries: WireEntry[]
}

/**
 * One closed turn mixing the entries a client renders with the harness's own
 * bookkeeping records — the shape that made a phone's baseline unopenable.
 */
function mixedTurn(): unknown[] {
  return [
    record('turn/start', 1, 100, { turn: 1 }),
    record('user/message', 2, 101, { text: 'hi' }),
    record('request/header', 3, 102, { model: 'm-1' }),
    record('assistant/message', 4, 103, { text: 'hello' }),
    record('system/message', 5, 104, { text: 'the harness prompt' }),
    record('tool/call', 6, 105, { callId: 'c-1', name: 'read', arguments: '{"path":"a"}' }),
    record('turn/end', 7, 106, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/** Feed one follow baseline to a connection and await its snapshot answer. */
async function snapshot(harness: ConnectionHarness, id: number, records: unknown[], cursor: number): Promise<void> {
  const follow = new ControllableStream()
  harness.gateway.follow = call => follow.attach(call.signal).iterable()
  const pending = harness.connection.handleText(requestFrame(id, 'session.snapshot', { sessionId: 's-1' }))
  follow.push({ type: 'snapshot', header: {}, cursor, hasMore: false, projections: {}, records })
  await pending
}

/** One snapshot answer's turns. */
function turnsOf(harness: ConnectionHarness, id: number): WireTurn[] {
  return (answerOf(harness, id).r as { turns: WireTurn[] }).turns
}

/** One snapshot answer's durable cursor. */
function lastSeqOf(harness: ConnectionHarness, id: number): number {
  return (answerOf(harness, id).r as { lastSeq: number }).lastSeq
}

/** One response frame's exact text, as it crossed the wire. */
function rawAnswer(harness: ConnectionHarness, id: number): string {
  const text = harness.transport.sent.find(entry => {
    const frame = JSON.parse(entry) as { t?: string; id?: number }
    return frame.t === 'res' && frame.id === id
  })
  if (text === undefined) throw new Error(`no response for request ${id}`)
  return text
}

describe('session methods over protocol v1', () => {
  afterEach(() => { vi.useRealTimers() })

  it('user opens a session and the snapshot arrives with its turns and durable cursor', async () => {
    // Given a host whose follow stream opens with a completed turn
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(1, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({
      type: 'snapshot',
      header: { version: 1, id: 's-1', createdAt: 1, isSeeded: false },
      cursor: 42,
      hasMore: false,
      projections: {},
      records: [
        record('turn/start', 1, 100, { turn: 1 }),
        record('user/message', 2, 101, { content: 'hi' }),
        record('turn/end', 3, 102, { turn: 1, reason: { kind: 'completed' } }),
      ],
    })
    // When the user asks for the snapshot
    await pending
    // Then the turns are grouped from turn start to turn end and the cursor crosses as lastSeq
    const answer = answerOf(harness, 1)
    const payload = answer.r as { turns: { seq: number; endSeq: number; reason: string; entries: unknown[] }[]; lastSeq: number }
    expect(payload.lastSeq).toBe(42)
    expect(payload.turns).toHaveLength(1)
    expect(payload.turns[0]?.seq).toBe(1)
    expect(payload.turns[0]?.endSeq).toBe(3)
    expect(payload.turns[0]?.reason).toBe('completed')
    expect(payload.turns[0]?.entries).toHaveLength(3)
  })

  it('user opens a session and the follow stream is asked for process-local deltas', async () => {
    // Given a host whose follow stream opens with an empty baseline
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(2, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    // When the snapshot is answered
    await pending
    // Then the stream was opened through the plain request key with the assistant stream switched on
    expect(harness.gateway.streamRequests).toHaveLength(1)
    expect(harness.gateway.streamRequests[0]?.args).toEqual({
      request: { address: { kind: 'session', sessionId: 's-1' }, assistantStream: true, maxMessages: 200 },
    })
  })

  it('user asking twice for a session that stayed silent reuses the one follow stream', async () => {
    // Given a session already subscribed whose stream has delivered nothing since its opening frame
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const first = harness.connection.handleText(requestFrame(3, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 7, hasMore: false, projections: {}, records: [] })
    await first
    // When the user snapshots again
    await harness.connection.handleText(requestFrame(4, 'session.snapshot', { sessionId: 's-1' }))
    // Then the same stream answered and no second one was opened
    expect(harness.gateway.streamRequests).toHaveLength(1)
    expect((answerOf(harness, 4).r as { lastSeq: number }).lastSeq).toBe(7)
  })

  it('user snapshots a session that ran a turn on its stream and a fresh stream answers the new cursor', async () => {
    // Given a session already subscribed with an empty opening window
    const harness = makeConnection({ paired: true })
    const opening = new ControllableStream()
    const reopened = new ControllableStream()
    const streams = [opening, reopened]
    harness.gateway.follow = call => (streams.shift() ?? new ControllableStream()).attach(call.signal).iterable()
    const first = harness.connection.handleText(requestFrame(21, 'session.snapshot', { sessionId: 's-1' }))
    opening.push({ type: 'snapshot', header: {}, cursor: 3, hasMore: false, projections: {}, records: [] })
    await first
    // When the session runs a turn on that very stream
    opening.push(record('turn/start', 466, 200, { turn: 1 }))
    await settle()
    // And the user asks for the snapshot again
    const second = harness.connection.handleText(requestFrame(22, 'session.snapshot', { sessionId: 's-1' }))
    reopened.push({
      type: 'snapshot',
      header: {},
      cursor: 21,
      hasMore: false,
      projections: {},
      records: [
        record('turn/start', 17, 300, { turn: 2 }),
        record('user/message', 18, 301, { content: 'again' }),
        record('turn/end', 19, 302, { turn: 2, reason: { kind: 'completed' } }),
      ],
    })
    await second
    // Then the moved stream was retired, one fresh stream was opened, and its own opening cursor is the answer
    expect(harness.gateway.streamRequests).toHaveLength(2)
    expect(opening.aborted).toBe(true)
    expect(turnsOf(harness, 22)).toHaveLength(1)
    expect(lastSeqOf(harness, 22)).toBe(21)
  })

  it('user sees assistant text, reasoning and tool arguments as increments', async () => {
    // Given a subscribed session
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(5, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    // When the assistant streams text, reasoning and a call whose arguments arrive in two pieces
    follow.push(chunk(0, { type: 'text-delta', index: 0, text: 'Hel' }))
    follow.push(chunk(1, { type: 'reasoning-delta', index: 1, text: 'because' }))
    follow.push(chunk(2, { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'bash', argumentsDelta: '{"cmd"' }))
    follow.push(chunk(3, { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: ':1}' }))
    await settle()
    // Then each increment is published as its own delta, and the argument pieces concatenate
    const events = harness.transport.ofType('ev').filter(frame => frame.m === 'session.delta')
    expect(events.map(frame => (frame.p as { kind: string }).kind)).toEqual(['text', 'reasoning', 'tool-call', 'tool-call'])
    expect(events[0]?.p).toEqual({ sessionId: 's-1', kind: 'text', text: 'Hel', blockIndex: 0 })
    expect(events[1]?.p).toEqual({ sessionId: 's-1', kind: 'reasoning', text: 'because', blockIndex: 1 })
    const concatenated = events
      .filter(frame => (frame.p as { kind: string }).kind === 'tool-call')
      .map(frame => (frame.p as { argumentsDelta: string }).argumentsDelta)
      .join('')
    expect(concatenated).toBe('{"cmd":1}')
    expect(events[3]?.p).toEqual({ sessionId: 's-1', kind: 'tool-call', callId: 'call-1', name: 'bash', argumentsDelta: ':1}' })
  })

  it('user sees a tool result and the end of the turn as their own deltas', async () => {
    // Given a subscribed session
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(6, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    // When a tool result and a failed turn end arrive
    follow.push(record('tool/result', 11, 200, { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'exit 1' }], isError: true } }))
    follow.push(record('turn/end', 12, 201, { turn: 1, reason: { kind: 'error' } }))
    await settle()
    // Then the result carries its call, output and failure flag, and the turn end carries only its reason
    const events = harness.transport.ofType('ev').filter(frame => frame.m === 'session.delta')
    expect(events[0]?.p).toEqual({ sessionId: 's-1', kind: 'tool-result', callId: 'call-1', output: 'exit 1', isError: true })
    expect(events[1]?.p).toEqual({ sessionId: 's-1', kind: 'turn-end', reason: 'error' })
    expect(events.map(frame => frame.seq)).toEqual([1, 2])
  })

  it('user who already streamed a call does not receive its arguments a second time', async () => {
    // Given a subscribed session that streamed one call's arguments
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(7, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    follow.push(chunk(0, { type: 'tool-call-delta', index: 0, id: 'call-9', name: 'bash', argumentsDelta: '{}' }))
    await settle()
    // When the durable tool call event for that same call arrives
    follow.push(record('tool/call', 12, 202, { turn: 1, step: 1, callId: 'call-9', name: 'bash', arguments: '{}' }))
    await settle()
    // Then only the increment was published, because the durable event would duplicate it
    const toolCalls = harness.transport.ofType('ev').filter(frame => (frame.p as { kind?: string }).kind === 'tool-call')
    expect(toolCalls).toHaveLength(1)
  })

  it('user who subscribed after a call started receives its assembled arguments once', async () => {
    // Given a subscribed session with no streamed arguments for the call
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(8, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    // When the durable tool call event arrives
    follow.push(record('tool/call', 12, 202, { turn: 1, step: 1, callId: 'call-9', name: 'bash', arguments: '{"a":1}' }))
    await settle()
    // Then the whole argument string crosses as one increment
    const toolCalls = harness.transport.ofType('ev').filter(frame => (frame.p as { kind?: string }).kind === 'tool-call')
    expect(toolCalls.map(frame => frame.p)).toEqual([
      { sessionId: 's-1', kind: 'tool-call', callId: 'call-9', name: 'bash', argumentsDelta: '{"a":1}' },
    ])
  })

  it('user prompting a session sends one queued text message with this machine time zone', async () => {
    // Given a paired connection and a host that accepts prompts
    const harness = makeConnection({ paired: true })
    harness.gateway.follow = call => new ControllableStream().attach(call.signal).iterable()
    // When the user prompts
    await harness.connection.handleText(requestFrame(9, 'session.prompt', { sessionId: 's-1', text: 'hello', requestId: 'r-1' }))
    // Then the message rides the request key with the queue mode and the resolved time zone
    expect(answerOf(harness, 9).r).toEqual({ accepted: true })
    expect(harness.gateway.lastArgs('session', 'prompt')).toEqual({
      request: {
        requestId: 'r-1',
        sessionId: 's-1',
        mode: 'queue',
        content: [{ type: 'text', text: 'hello' }],
        clientTimeZone: 'Asia/Shanghai',
      },
    })
  })

  it('user repeating a prompt with the same request id is not sent twice', async () => {
    // Given a connection that already sent one prompt
    const harness = makeConnection({ paired: true })
    harness.gateway.follow = call => new ControllableStream().attach(call.signal).iterable()
    await harness.connection.handleText(requestFrame(10, 'session.prompt', { sessionId: 's-1', text: 'hello', requestId: 'r-1' }))
    // When the same request id is sent again
    await harness.connection.handleText(requestFrame(11, 'session.prompt', { sessionId: 's-1', text: 'hello', requestId: 'r-1' }))
    // Then the host saw one prompt and the retry is acknowledged
    expect(harness.gateway.countOf('session', 'prompt')).toBe(1)
    expect(answerOf(harness, 11).r).toEqual({ accepted: true })
  })

  it('user repeating a prompt after a failed send is allowed to retry', async () => {
    // Given a host that fails the first prompt outright
    const harness = makeConnection({ paired: true })
    harness.gateway.follow = call => new ControllableStream().attach(call.signal).iterable()
    let attempts = 0
    harness.gateway.handler = async () => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('gateway is not serving prompts'), { code: 'gateway/invocation-unavailable' })
      return { accepted: true }
    }
    await harness.connection.handleText(requestFrame(12, 'session.prompt', { sessionId: 's-1', text: 'hello', requestId: 'r-1' }))
    // When the client retries the same request id
    await harness.connection.handleText(requestFrame(13, 'session.prompt', { sessionId: 's-1', text: 'hello', requestId: 'r-1' }))
    // Then the failure crossed as the gateway's own code and the retry reached the host
    expect(answerOf(harness, 12).e?.code).toBe('gateway/invocation-unavailable')
    expect(answerOf(harness, 13).r).toEqual({ accepted: true })
    expect(harness.gateway.countOf('session', 'prompt')).toBe(2)
  })

  it('user interrupting a session cancels the turn and keeps the subscription', async () => {
    // Given a subscribed session
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(14, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await pending
    // When the user interrupts the turn
    await harness.connection.handleText(requestFrame(15, 'session.interrupt', { sessionId: 's-1' }))
    // Then the cancel rides the request key and the follow stream is still live
    expect(answerOf(harness, 15).r).toEqual({ ok: true })
    expect(harness.gateway.lastArgs('session', 'cancel')).toEqual({ request: { sessionId: 's-1' } })
    expect(follow.aborted).toBe(false)
  })

  it('operator sees every follow stream aborted when the connection closes', async () => {
    // Given a connection subscribed to two sessions
    const harness = makeConnection({ paired: true })
    const first = new ControllableStream()
    const second = new ControllableStream()
    harness.gateway.follow = call => {
      const sessionId = (call.args.request as { address: { sessionId: string } }).address.sessionId
      return (sessionId === 's-1' ? first : second).attach(call.signal).iterable()
    }
    const one = harness.connection.handleText(requestFrame(16, 'session.snapshot', { sessionId: 's-1' }))
    first.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await one
    const two = harness.connection.handleText(requestFrame(17, 'session.snapshot', { sessionId: 's-2' }))
    second.push({ type: 'snapshot', header: {}, cursor: 0, hasMore: false, projections: {}, records: [] })
    await two
    // When the connection is torn down
    harness.connection.dispose()
    // Then every stream it owned was aborted and no session is left subscribed
    expect([first.aborted, second.aborted]).toEqual([true, true])
  })

  it('user snapshotting a session whose stream never opens is told the snapshot is unavailable', async () => {
    // Given a host whose follow stream ends without its opening frame
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(18, 'session.snapshot', { sessionId: 's-1' }))
    follow.end()
    // When the snapshot is awaited
    await pending
    // Then the refusal names the missing baseline, and the dead subscription is dropped
    expect(answerOf(harness, 18).e?.code).toBe('snapshot-unavailable')
    const retry = harness.connection.handleText(requestFrame(19, 'session.snapshot', { sessionId: 's-1' }))
    const reopened = new ControllableStream()
    harness.gateway.follow = call => reopened.attach(call.signal).iterable()
    reopened.push({ type: 'snapshot', header: {}, cursor: 3, hasMore: false, projections: {}, records: [] })
    await retry
    expect(harness.gateway.streamRequests).toHaveLength(2)
  })

  it('user snapshotting a session larger than one frame is refused rather than truncated silently', async () => {
    // Given a session whose single recorded turn is larger than one frame may carry
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(20, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({
      type: 'snapshot',
      header: {},
      cursor: 1,
      hasMore: false,
      projections: {},
      records: [
        record('turn/start', 1, 100, { turn: 1 }),
        record('user/message', 2, 101, { text: 'x'.repeat(MAX_FRAME_BYTES + 1024) }),
      ],
    })
    // When the snapshot is awaited
    await pending
    // Then the refusal says the snapshot does not fit, instead of sending a clipped history
    expect(answerOf(harness, 20).e?.code).toBe('snapshot-too-large')
  })

  it('user listing sessions while the host is still activating is retried instead of failed', async () => {
    // Given a gateway that refuses four times while its session service activates
    vi.useFakeTimers()
    const harness = makeConnection({ paired: true })
    let attempts = 0
    harness.gateway.handler = async () => {
      attempts += 1
      if (attempts < 5) throw Object.assign(new Error('service is activating'), { code: 'gateway/service-unavailable' })
      return { items: [{ sessionId: 's-1', updatedAt: 1, running: true, blank: false, agentAvailable: true }] }
    }
    // When the user lists sessions
    const pending = harness.connection.handleText(requestFrame(21, 'session.list'))
    await vi.advanceTimersByTimeAsync(8_000)
    await pending
    // Then the fifth try answered and the roster crossed
    expect(attempts).toBe(5)
    expect(answerOf(harness, 21).r).toEqual({ mode: 'reset', token: '', sessions: [{ id: 's-1', title: '', updatedAt: 1, agentRunning: true, blank: false }] })
  })

  it('operator prompts a session whose stream cannot open and the connection stays usable', async () => {
    // Given a host that refuses to open any follow stream
    const harness = makeConnection({ paired: true })
    harness.gateway.follow = () => { throw new Error('session service refuses follow') }
    // When the user prompts without snapshotting first, so nothing ever awaits that stream
    await harness.connection.handleText(requestFrame(22, 'session.prompt', { sessionId: 's-1', text: 'hi', requestId: 'r-9' }))
    await settle()
    // Then the prompt itself answered and the socket is still answering afterwards
    expect(answerOf(harness, 22).r).toEqual({ accepted: true })
    await harness.connection.handleText(requestFrame(23, 'hello', { proto: 1 }))
    expect(answerOf(harness, 23).ok).toBe(true)
  })

  it('user declaring the snapshot trim capability receives only the entries the client renders', async () => {
    // Given a client that announces the trim capability beside the capability it already declared
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(30, 'hello', { proto: 1, cap: ['session.stream.v1', 'session.snapshot.trim.v1'] }))
    // When it snapshots a turn mixing rendered entries with records it cannot render
    await snapshot(harness, 31, mixedTurn(), 7)
    // Then only the rendered entries cross, in their original order, carrying their own fields
    const turns = turnsOf(harness, 31)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.entries.map(entry => entry.type)).toEqual(['user/message', 'assistant/message', 'tool/call'])
    expect(turns[0]?.entries.map(entry => entry.seq)).toEqual([2, 4, 6])
    expect(turns[0]?.entries[2]?.data).toEqual({ callId: 'c-1', name: 'read', arguments: '{"path":"a"}' })
    // And the turn's own boundaries and the durable cursor stay the projection's own numbers
    expect([turns[0]?.seq, turns[0]?.endSeq, turns[0]?.reason]).toEqual([1, 7, 'completed'])
    expect(lastSeqOf(harness, 31)).toBe(7)
  })

  it('user declaring no trim capability receives the untrimmed baseline byte for byte', async () => {
    // Given two clients over the same turn: one declares no capability, the other announces the older one
    const plain = makeConnection({ paired: true })
    const legacy = makeConnection({ paired: true })
    await legacy.connection.handleText(requestFrame(40, 'hello', { proto: 1, cap: ['session.stream.v1'] }))
    // When both snapshot that turn
    await Promise.all([snapshot(plain, 41, mixedTurn(), 7), snapshot(legacy, 41, mixedTurn(), 7)])
    // Then every record crosses, and the two answers are the same bytes
    expect(rawAnswer(plain, 41)).toBe(rawAnswer(legacy, 41))
    expect(turnsOf(plain, 41)[0]?.entries.map(entry => entry.type))
      .toEqual(['turn/start', 'user/message', 'request/header', 'assistant/message', 'system/message', 'tool/call', 'turn/end'])
  })

  it('user declaring the trim capability receives a baseline that without it exceeds one frame', async () => {
    // Given a single turn whose unrenderable record alone is larger than one frame, beside a small rendered one
    const records = [
      record('system/message', 1, 100, { text: 's'.repeat(MAX_FRAME_BYTES + 1024) }),
      record('assistant/message', 2, 101, { text: 'ok' }),
    ]
    const untrimmed = makeConnection({ paired: true })
    const trimmed = makeConnection({ paired: true })
    await trimmed.connection.handleText(requestFrame(50, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1'] }))
    // When both snapshot that turn
    await Promise.all([snapshot(untrimmed, 51, records, 9), snapshot(trimmed, 51, records, 9)])
    // Then the untrimmed client is refused as too large, and the trimmed one gets the small rendered entry
    expect(answerOf(untrimmed, 51).e?.code).toBe('snapshot-too-large')
    const turns = turnsOf(trimmed, 51)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.entries.map(entry => entry.type)).toEqual(['assistant/message'])
    expect(lastSeqOf(trimmed, 51)).toBe(9)
  })

  it('user declaring the trim capability keeps a turn of pure bookkeeping as an empty turn', async () => {
    // Given a client that announces the trim capability, and a turn holding nothing it could render
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(60, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1'] }))
    // When it snapshots that turn
    await snapshot(harness, 61, [
      record('turn/start', 1, 100, { turn: 1 }),
      record('system/message', 2, 101, { text: 'the harness prompt' }),
      record('turn/end', 3, 102, { turn: 1, reason: { kind: 'completed' } }),
    ], 3)
    // Then the turn is still there with its own boundaries, and its entry list is empty rather than absent
    const turns = turnsOf(harness, 61)
    expect(turns).toHaveLength(1)
    expect([turns[0]?.seq, turns[0]?.endSeq, turns[0]?.reason]).toEqual([1, 3, 'completed'])
    expect(turns[0]?.entries).toEqual([])
  })
})
