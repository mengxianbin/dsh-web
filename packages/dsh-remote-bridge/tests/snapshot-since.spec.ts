import { describe, expect, it } from 'vitest'
import { MAX_FRAME_BYTES } from '../src/core/envelope.ts'
import { ControllableStream, answerOf, makeConnection, requestFrame, type ConnectionHarness } from './support/harness.ts'

/** One follow record as DSH writes it. */
function record(type: string, seq: number, time: number, data: unknown): unknown {
  return { type: 'event', event: { type, seq, time, data } }
}

interface WireEntry {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

interface WireTurn {
  readonly seq: number
  readonly time: number
  readonly endSeq: number
  readonly endTime: number
  readonly reason: string
  readonly entries: WireEntry[]
}

/** One snapshot answer, fields and all. */
interface SnapshotAnswer {
  readonly turns: WireTurn[]
  readonly lastSeq: number
  readonly hasMore?: boolean
  readonly mode?: string
  readonly reset?: boolean
}

const SINCE = 'session.snapshot.since.v1'
const TRIM = 'session.snapshot.trim.v1'

/** Declare a set of capabilities in the handshake. */
async function greet(harness: ConnectionHarness, capabilities: readonly string[]): Promise<void> {
  await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: capabilities }))
}

/** Feed one follow baseline to a connection and await its snapshot answer. */
async function openSession(harness: ConnectionHarness, id: number, records: unknown[], cursor: number, payload: Record<string, unknown> = {}): Promise<void> {
  const follow = new ControllableStream()
  harness.gateway.follow = call => follow.attach(call.signal).iterable()
  const pending = harness.connection.handleText(requestFrame(id, 'session.snapshot', { sessionId: 's-1', ...payload }))
  follow.push({ type: 'snapshot', header: {}, cursor, hasMore: false, projections: {}, records })
  await pending
}

/** One snapshot answer's payload. */
function snapshotOf(harness: ConnectionHarness, id: number): SnapshotAnswer {
  return answerOf(harness, id).r as SnapshotAnswer
}

/** The exact bytes of one answer, as they crossed the wire. */
function rawBytesOf(harness: ConnectionHarness, id: number): number {
  const text = harness.transport.sent.find(entry => {
    const frame = JSON.parse(entry) as { t?: string; id?: number }
    return frame.t === 'res' && frame.id === id
  })
  if (text === undefined) throw new Error(`no response for request ${id}`)
  return Buffer.byteLength(text, 'utf8')
}

/** Every entry seq a payload carries, oldest first. */
function seqsOf(turns: readonly WireTurn[]): number[] {
  return turns.flatMap(turn => turn.entries.map(entry => entry.seq))
}

/** One durable entry seq's own event, or undefined when the payload does not carry it. */
function entryOf(turns: readonly WireTurn[], seq: number): WireEntry | undefined {
  for (const turn of turns) {
    for (const entry of turn.entries) if (entry.seq === seq) return entry
  }
  return undefined
}

const PROMPT_TEXT = 'The follow stream dropped its opening frame again on the relay. Can you find out why the bridge does not reopen the subscription?'
const ANSWER_TEXT = 'The opening frame is the subscription baseline, so a dropped frame leaves the connection with no window at all. '.repeat(120)
const TOOL_OUTPUT = 'Test Files  41 passed (41)\n     Tests  375 passed (375)\n  Duration  18.42s\n'.repeat(120)

/** Durable entries one realistic turn writes. */
const TURN_ENTRIES = 8

/**
 * One realistic turn of a long session, oldest entry first: the harness's own
 * bookkeeping, a prompt, a tool call, its result and the answer.
 * @param base - the durable seq this turn starts at.
 * @param turn - the turn number the host wrote into every event.
 */
function turnFrom(base: number, turn: number): unknown[] {
  const time = 1_760_000_000_000 + base * 1000
  return [
    record('turn/start', base, time, { turn }),
    record('request/header', base + 1, time, { turn, step: 0, model: 'deepseek-chat', stream: true }),
    record('system/message', base + 2, time, { turn, text: 'Harness bookkeeping for this turn.' }),
    record('user/message', base + 3, time, { id: `msg-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text: PROMPT_TEXT }] }),
    record('assistant/message', base + 4, time, { turn, usage: { inputTokens: 1840, outputTokens: 620, totalTokens: 2460 }, content: [{ type: 'text', text: ANSWER_TEXT }] }),
    record('tool/call', base + 5, time, { turn, callId: `call-${turn}`, name: 'bash', arguments: '{"command":"pnpm --filter @linxin666/dsh-remote-bridge test"}' }),
    record('tool/result', base + 6, time, { turn, message: { toolCallId: `call-${turn}`, isError: false, content: [{ type: 'text', text: TOOL_OUTPUT }] } }),
    record('turn/end', base + 7, time, { turn, reason: { kind: 'completed' } }),
  ]
}

/**
 * A window of consecutive realistic turns, oldest first.
 * @param count - how many turns the window holds.
 * @param firstTurn - the turn number the oldest of them carries.
 */
function windowOf(count: number, firstTurn = 1): unknown[] {
  const records: unknown[] = []
  for (let index = 0; index < count; index += 1) {
    records.push(...turnFrom((firstTurn - 1 + index) * TURN_ENTRIES + 1, firstTurn + index))
  }
  return records
}

/** Three turns whose entries are seqs 1..24. */
const THREE_TURNS = windowOf(3)
/** Three turns whose entries are seqs 25..48: a window that scrolled one turn on. */
const SCROLLED_TURNS = windowOf(3, 4)

describe('incremental snapshots behind session.snapshot.since.v1', () => {
  it('user not declaring the capability is answered the whole window and its watermark is ignored', async () => {
    // Given one client that declared nothing, and one that declared an unrelated name
    const plain = makeConnection({ paired: true })
    const unrelated = makeConnection({ paired: true })
    await greet(unrelated, ['session.stream.v1'])
    // When both open the same session, the second naming a watermark it holds
    await openSession(plain, 2, THREE_TURNS, 40)
    await openSession(unrelated, 2, THREE_TURNS, 40, { sinceSeq: 18 })
    // Then the parameter changed nothing: the same bytes cross, no incremental
    // field is added, and the whole window is still there
    expect(rawBytesOf(unrelated, 2)).toBe(rawBytesOf(plain, 2))
    expect(seqsOf(snapshotOf(unrelated, 2).turns)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1))
    expect('mode' in snapshotOf(unrelated, 2)).toBe(false)
    expect('reset' in snapshotOf(unrelated, 2)).toBe(false)
  })

  it('user declaring the capability without a watermark is answered the same bytes as before it existed', async () => {
    // Given one client that declared the capability and one that declared nothing
    const declared = makeConnection({ paired: true })
    const plain = makeConnection({ paired: true })
    await greet(declared, [SINCE])
    // When both open the same session with no watermark
    await openSession(declared, 2, THREE_TURNS, 40)
    await openSession(plain, 2, THREE_TURNS, 40)
    // Then the declaration alone bought nothing: same bytes, no incremental field
    expect(rawBytesOf(declared, 2)).toBe(rawBytesOf(plain, 2))
    expect(snapshotOf(declared, 2)).toEqual(snapshotOf(plain, 2))
    expect('mode' in snapshotOf(declared, 2)).toBe(false)
  })

  it('user declaring the capability with a watermark inside the window receives only the entries above it', async () => {
    // Given the same session opened whole by a client that declared nothing
    const plain = makeConnection({ paired: true })
    await openSession(plain, 2, THREE_TURNS, 40)
    // And a client that declared the capability and holds everything through seq 18
    const harness = makeConnection({ paired: true })
    await greet(harness, [SINCE])
    // When that client reconnects and names the watermark it holds
    await openSession(harness, 2, THREE_TURNS, 40, { sinceSeq: 18 })
    // Then the answer is the delta: no entry at or below the watermark, the same
    // turn fields the full baseline carries, and the two fields that mark it
    const answer = snapshotOf(harness, 2)
    expect(answer.mode).toBe('since')
    expect(answer.reset).toBe(false)
    expect(answer.lastSeq).toBe(40)
    expect(answer.turns).toHaveLength(1)
    expect(seqsOf(answer.turns)).toEqual([19, 20, 21, 22, 23, 24])
    expect(entryOf(answer.turns, 18)).toBeUndefined()
    const fullTurn = snapshotOf(plain, 2).turns[2]
    expect(answer.turns[0]).toMatchObject({ seq: 17, endSeq: 24, reason: 'completed', time: fullTurn?.time })
    // And its entries are that turn's own entries above the watermark, byte for byte
    expect(answer.turns[0]?.entries).toEqual(fullTurn?.entries.slice(2))
  })

  it('user declaring the capability with a watermark the window rolled past receives the whole baseline and a reset', async () => {
    // Given the same window as a client that declared nothing receives it
    const plain = makeConnection({ paired: true })
    await openSession(plain, 2, SCROLLED_TURNS, 48)
    // And a client that declared the capability and still holds everything through seq 18
    const harness = makeConnection({ paired: true })
    await greet(harness, [SINCE])
    // When that client reconnects into a window that now starts at seq 25
    await openSession(harness, 2, SCROLLED_TURNS, 48, { sinceSeq: 18 })
    // Then continuity cannot be proven, so the answer is today's baseline plus
    // the two fields that tell the client its copy is stale
    const answer = snapshotOf(harness, 2)
    expect(answer.mode).toBe('full')
    expect(answer.reset).toBe(true)
    expect(answer.turns).toEqual(snapshotOf(plain, 2).turns)
    expect(answer.lastSeq).toBe(48)
    expect(rawBytesOf(harness, 2) - rawBytesOf(plain, 2)).toBe(',"mode":"full","reset":true'.length)
  })

  it('user reconnecting right after a finished turn receives a delta far smaller than the baseline it replaces', async () => {
    // Given a session of 24 realistic turns, 192 durable entries in all, and two
    // clients that declared the trim and the since capability
    const TURNS = 24
    const records = windowOf(TURNS)
    const full = makeConnection({ paired: true })
    await greet(full, [TRIM, SINCE])
    const reconnect = makeConnection({ paired: true })
    await greet(reconnect, [TRIM, SINCE])
    // When one takes the whole opening window and the other holds everything
    // through the end of turn 23, so only the last turn is new to it
    await openSession(full, 2, records, TURNS * TURN_ENTRIES)
    await openSession(reconnect, 2, records, TURNS * TURN_ENTRIES, { sinceSeq: (TURNS - 1) * TURN_ENTRIES })
    // Then both are the same session at the same cursor, told in very different
    // bytes: the whole window's 96 rendered entries against the last turn's own
    // four, 569876 bytes against 23835, so one reconnect pays the turn it missed
    // rather than all 24 turns / 192 durable entries again
    const whole = snapshotOf(full, 2)
    const delta = snapshotOf(reconnect, 2)
    expect(seqsOf(whole.turns)).toHaveLength(TURNS * 4)
    expect(seqsOf(delta.turns)).toEqual([188, 189, 190, 191])
    expect(delta.mode).toBe('since')
    expect(delta.reset).toBe(false)
    expect(delta.lastSeq).toBe(whole.lastSeq)
    expect(rawBytesOf(full, 2)).toBe(569876)
    expect(rawBytesOf(reconnect, 2)).toBe(23835)
    expect(rawBytesOf(reconnect, 2) * 20).toBeLessThan(rawBytesOf(full, 2))
  })

  it('user whose delta cannot cross one frame receives the baseline and a reset instead of a refusal', async () => {
    // Given a window of three turns of 3.5 MiB each, so the delta above seq 3 is
    // past the 10 MiB frame cap while the newest turns alone still fit
    const MB = 1024 * 1024
    const turns = windowOf(3).map((entry, index) => {
      const chunk = (entry as { event: { type: string; seq: number; time: number } }).event
      if (chunk.type !== 'assistant/message') return entry
      return record(chunk.type, chunk.seq, chunk.time, { turn: index, content: [{ type: 'text', text: 'z'.repeat(3.5 * MB) }] })
    })
    const harness = makeConnection({ paired: true })
    await greet(harness, [SINCE])
    // When it names a watermark below the whole window
    await openSession(harness, 2, turns, 24, { sinceSeq: 3 })
    // Then the delta is dropped for the baseline, which is trimmed by whole
    // turns until it fits, and the client is told to reset
    const answer = snapshotOf(harness, 2)
    expect(answer.mode).toBe('full')
    expect(answer.reset).toBe(true)
    expect(answer.turns.length).toBeLessThan(3)
    expect(rawBytesOf(harness, 2)).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    expect(MAX_FRAME_BYTES).toBe(10 * MB)
  })

  it('user declaring the capability against an empty window receives an empty delta and its cursor', async () => {
    // Given a client that declared the capability and a session whose opening
    // window carries no entry at all
    const harness = makeConnection({ paired: true })
    await greet(harness, [SINCE])
    // When it names a watermark it holds
    await openSession(harness, 2, [], 7, { sinceSeq: 7 })
    // Then there is nothing to lose, so nothing is proven wrong: an empty delta
    expect(snapshotOf(harness, 2)).toEqual({ turns: [], lastSeq: 7, mode: 'since', reset: false })
  })
})
