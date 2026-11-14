import { describe, expect, it } from 'vitest'
import { HISTORY_PAGE_BYTES } from '../src/core/connection.ts'
import { MAX_FRAME_BYTES } from '../src/core/envelope.ts'
import { ControllableStream, answerOf, makeConnection, requestFrame, settle, type ConnectionHarness } from './support/harness.ts'

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
  readonly endSeq: number
  readonly reason: string
  readonly entries: WireEntry[]
}

interface WirePage {
  readonly turns: WireTurn[]
  readonly nextBefore?: number
  readonly hasMore: boolean
}

/** A completed turn holding one padded assistant message. */
function paddedTurn(seq: number, bytes: number, turn: number): unknown[] {
  return [
    record('turn/start', seq, 100 + seq, { turn }),
    record('assistant/message', seq + 1, 101 + seq, { text: 'x'.repeat(bytes) }),
    record('turn/end', seq + 2, 102 + seq, { turn, reason: { kind: 'completed' } }),
  ]
}

/** Several completed turns, oldest first. */
function paddedTurns(count: number, bytesPerMessage: number): unknown[] {
  const records: unknown[] = []
  for (let index = 0; index < count; index += 1) records.push(...paddedTurn(1 + index * 3, bytesPerMessage, index + 1))
  return records
}

/** Feed one follow baseline to a connection and await its snapshot answer. */
async function openSession(harness: ConnectionHarness, id: number, records: unknown[], cursor: number, sessionId = 's-1'): Promise<void> {
  const follow = new ControllableStream()
  harness.gateway.follow = call => follow.attach(call.signal).iterable()
  const pending = harness.connection.handleText(requestFrame(id, 'session.snapshot', { sessionId }))
  follow.push({ type: 'snapshot', header: {}, cursor, hasMore: false, projections: {}, records })
  await pending
}

/** One session's history request. */
async function historyOf(harness: ConnectionHarness, id: number, payload: Record<string, unknown>): Promise<void> {
  await harness.connection.handleText(requestFrame(id, 'session.history', payload))
}

/** One history answer's page. */
function pageOf(harness: ConnectionHarness, id: number): WirePage {
  return answerOf(harness, id).r as WirePage
}

/** Every entry seq a page carries, oldest first. */
function seqsOf(page: WirePage): number[] {
  return page.turns.flatMap(turn => turn.entries.map(entry => entry.seq))
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

describe('session history pages over protocol v1', () => {
  it('user opening a session and paging it receives the newest entries inside one default page budget', async () => {
    // Given a session whose baseline is larger than one default page
    const harness = makeConnection({ paired: true })
    await openSession(harness, 1, paddedTurns(12, 60 * 1024), 40)
    // When the user asks for history without a cursor
    await historyOf(harness, 2, { sessionId: 's-1' })
    // Then the page is the newest slice, inside the budget, and names its own cursor
    const page = pageOf(harness, 2)
    const seqs = seqsOf(page).sort((left, right) => left - right)
    expect(rawBytesOf(harness, 2)).toBeLessThanOrEqual(HISTORY_PAGE_BYTES)
    expect(HISTORY_PAGE_BYTES).toBe(512 * 1024)
    expect(page.hasMore).toBe(true)
    expect(page.nextBefore).toBe(seqs[0])
    expect(page.turns.length).toBeGreaterThan(0)
    expect(page.turns.every(turn => turn.reason === 'completed')).toBe(true)
  })

  it('user following the cursor back receives every entry exactly once and ends without a cursor', async () => {
    // Given a session already opened, with its baseline's own entry list as the truth
    const harness = makeConnection({ paired: true })
    await openSession(harness, 1, paddedTurns(12, 60 * 1024), 40)
    const snapshot = answerOf(harness, 1).r as { turns: WireTurn[] }
    const expected = snapshot.turns.flatMap(turn => turn.entries.map(entry => entry.seq))
    // When the user pages back until the session reports no more
    const seen: number[] = []
    const pages: WirePage[] = []
    let before: number | undefined
    for (let index = 0; index < 20; index += 1) {
      const id = 10 + index
      await historyOf(harness, id, { sessionId: 's-1', ...(before === undefined ? {} : { before }) })
      const page = pageOf(harness, id)
      pages.push(page)
      seen.push(...seqsOf(page))
      if (page.hasMore !== true) break
      before = page.nextBefore
    }
    // Then the pages tile the baseline: no duplicates, nothing missing, oldest last
    expect(pages.length).toBeGreaterThan(1)
    expect(seen.length).toBe(new Set(seen).size)
    expect([...seen].sort((left, right) => left - right)).toEqual(expected)
    expect(pages.at(-1)?.hasMore).toBe(false)
    expect(pages.at(-1)?.nextBefore).toBeUndefined()
    expect(pages.slice(0, -1).every(page => page.nextBefore !== undefined)).toBe(true)
  })

  it('user paging a session whose single entry exceeds the page budget still receives that entry', async () => {
    // Given one entry far larger than the requested budget, beside small ones
    const harness = makeConnection({ paired: true })
    const records = [
      ...paddedTurn(1, 20, 1),
      ...paddedTurn(4, 300 * 1024, 2),
    ]
    await openSession(harness, 1, records, 6)
    // When the user pages with a budget the oversized entry cannot fit
    await historyOf(harness, 2, { sessionId: 's-1', maxBytes: 1000 })
    // Then the page stops at the small newest entry and says more remains
    const first = pageOf(harness, 2)
    expect(seqsOf(first)).toEqual([6])
    expect(first.hasMore).toBe(true)
    // And the oversized entry itself is delivered as a page of its own rather than refused
    await historyOf(harness, 3, { sessionId: 's-1', maxBytes: 1000, before: first.nextBefore })
    const second = pageOf(harness, 3)
    expect(seqsOf(second)).toEqual([5])
    expect(rawBytesOf(harness, 3)).toBeGreaterThan(300 * 1024)
    expect(answerOf(harness, 3).ok).toBe(true)
  })

  it('operator paging a session without a device token is refused', async () => {
    // Given a connection that never proved a device token
    const harness = makeConnection({ paired: false })
    // When it asks for history
    await historyOf(harness, 1, { sessionId: 's-1' })
    // Then the authorization rule answers before any session work
    expect(answerOf(harness, 1).e?.code).toBe('unpaired')
  })

  it('user paging with a cursor or a budget the protocol cannot honour is refused', async () => {
    // Given a paired connection and an opened session
    const harness = makeConnection({ paired: true })
    await openSession(harness, 1, paddedTurn(1, 64, 1), 3)
    // When each malformed request is made
    await historyOf(harness, 2, { sessionId: 's-1', before: -1 })
    await historyOf(harness, 3, { sessionId: 's-1', maxBytes: 0 })
    await historyOf(harness, 4, { sessionId: 's-1', maxBytes: MAX_FRAME_BYTES + 1 })
    await historyOf(harness, 5, {})
    // Then each is refused as malformed arguments rather than answered with a guess
    expect([2, 3, 4, 5].map(id => answerOf(harness, id).e?.code)).toEqual(['invalid-args', 'invalid-args', 'invalid-args', 'invalid-args'])
  })

  it('user paging a session is served only the entries the trim capability admits', async () => {
    // Given a client that declared the trim capability over a session holding bookkeeping
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1'] }))
    const records = [
      record('system/message', 1, 100, { text: 'the harness prompt' }),
      ...paddedTurn(2, 4096, 1),
    ]
    await openSession(harness, 2, records, 4)
    // When it pages that session
    await historyOf(harness, 3, { sessionId: 's-1' })
    // Then the page carries the rendered entry only, and the trim did not change the turn's own fields
    const page = pageOf(harness, 3)
    expect(seqsOf(page)).toEqual([3])
    expect(page.turns[0]?.reason).toBe('completed')
    expect(page.turns[0]?.endSeq).toBe(4)
  })

  it('operator paging a session leaves the subscription the snapshot opened untouched', async () => {
    // Given an open session and the single follow stream behind it
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = harness.connection.handleText(requestFrame(1, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 40, hasMore: false, projections: {}, records: paddedTurns(4, 64) })
    await pending
    // When history is paged repeatedly and a delta then arrives
    await historyOf(harness, 2, { sessionId: 's-1' })
    await historyOf(harness, 3, { sessionId: 's-1', before: pageOf(harness, 2).nextBefore })
    follow.push({ type: 'event', event: { type: 'turn/end', seq: 41, time: 300, data: { reason: { kind: 'completed' } } } })
    await settle()
    // Then no second stream was opened and the subscription still publishes deltas
    expect(harness.gateway.streamRequests).toHaveLength(1)
    const deltas = harness.transport.ofType('ev').filter(frame => frame.m === 'session.delta')
    expect(deltas.map(frame => (frame.p as { kind: string }).kind)).toEqual(['turn-end'])
  })
})
