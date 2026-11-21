import { describe, expect, it } from 'vitest'
import { HISTORY_PAGE_BYTES } from '../src/core/connection.ts'
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
  readonly endSeq: number
  readonly reason: string
  readonly entries: WireEntry[]
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

/** Every entry seq a payload carries, oldest first. */
function seqsOf(turns: readonly WireTurn[]): number[] {
  return turns.flatMap(turn => turn.entries.map(entry => entry.seq))
}

/** The oldest entry seq a payload carries: the cursor for the next, older page. */
function oldestSeqOf(turns: readonly WireTurn[]): number | undefined {
  const seqs = seqsOf(turns)
  return seqs.length === 0 ? undefined : Math.min(...seqs)
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

/** Feed one follow baseline to a connection and await its snapshot answer. */
async function openSession(harness: ConnectionHarness, id: number, records: unknown[], cursor: number, payload: Record<string, unknown> = {}, windowHasMore = false): Promise<void> {
  const follow = new ControllableStream()
  harness.gateway.follow = call => follow.attach(call.signal).iterable()
  const pending = harness.connection.handleText(requestFrame(id, 'session.snapshot', { sessionId: 's-1', ...payload }))
  follow.push({ type: 'snapshot', header: {}, cursor, hasMore: windowHasMore, projections: {}, records })
  await pending
}

/** One snapshot answer's payload. */
function snapshotOf(harness: ConnectionHarness, id: number): { turns: WireTurn[]; lastSeq: number; hasMore?: boolean } {
  return answerOf(harness, id).r as { turns: WireTurn[]; lastSeq: number; hasMore?: boolean }
}

/** One completed turn of two small entries: a window one page holds whole. */
const ONE_SMALL_TURN = [
  record('turn/start', 1, 100, { turn: 1 }),
  record('user/message', 2, 101, { text: 'hello' }),
  record('assistant/message', 3, 102, { text: 'hi' }),
  record('turn/end', 4, 103, { turn: 1, reason: { kind: 'completed' } }),
]

/** Twelve completed turns of 60 KiB each: one window well past a page, 36 entries in all. */
const WINDOW_TURNS = 12
const WHOLE_WINDOW = paddedTurns(WINDOW_TURNS, 60 * 1024)
const WHOLE_WINDOW_SEQS = Array.from({ length: WINDOW_TURNS * 3 }, (_, index) => index + 1)

describe('paged opening snapshots over protocol v1', () => {
  it('user declaring the page capability receives one bounded page instead of the whole window', async () => {
    // Given a client that declared the page capability, over a session larger than one page
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.page.v1'] }))
    // When it opens that session
    await openSession(harness, 2, WHOLE_WINDOW, 40)
    // Then the answer is one page inside the default budget, with more still below it
    const page = snapshotOf(harness, 2)
    expect(HISTORY_PAGE_BYTES).toBe(512 * 1024)
    expect(rawBytesOf(harness, 2)).toBeLessThanOrEqual(HISTORY_PAGE_BYTES)
    expect(page.lastSeq).toBe(40)
    expect(page.hasMore).toBe(true)
    expect(seqsOf(page.turns).length).toBeGreaterThan(1)
    expect(seqsOf(page.turns).length).toBeLessThan(WHOLE_WINDOW_SEQS.length)
    // And the cursor is the page's own oldest entry, so no second field restates it
    expect('nextBefore' in page).toBe(false)
    expect(oldestSeqOf(page.turns)).toBe(Math.min(...seqsOf(page.turns)))
  })

  it('user declaring the page capability walks the whole session through history with nothing repeated or lost', async () => {
    // Given an opened first page over a window it cannot fit in one frame
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.page.v1'] }))
    await openSession(harness, 2, WHOLE_WINDOW, 40)
    // When the client pages back from the oldest entry its first page carried
    const seen = seqsOf(snapshotOf(harness, 2).turns)
    let before = oldestSeqOf(snapshotOf(harness, 2).turns)
    for (let index = 0; index < 20 && before !== undefined; index += 1) {
      const id = 10 + index
      await harness.connection.handleText(requestFrame(id, 'session.history', { sessionId: 's-1', before }))
      const page = answerOf(harness, id).r as { turns: WireTurn[]; nextBefore?: number; hasMore: boolean }
      seen.push(...seqsOf(page.turns))
      if (page.hasMore !== true) break
      before = page.nextBefore
    }
    // Then the pages tile the window: every entry exactly once, oldest last
    expect(seen.length).toBe(new Set(seen).size)
    expect(seen.length).toBeGreaterThan(1)
    expect([...seen].sort((left, right) => left - right)).toEqual(WHOLE_WINDOW_SEQS)
  })

  it('user declaring the page capability receives an entry larger than a whole frame instead of a refusal', async () => {
    // Given one entry larger than a whole frame, on one session opened by two clients
    const records = [
      ...paddedTurn(1, 64, 1),
      ...paddedTurn(4, MAX_FRAME_BYTES + 1024, 2),
    ]
    const paged = makeConnection({ paired: true })
    await paged.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1', 'session.snapshot.page.v1'] }))
    const whole = makeConnection({ paired: true })
    // When both open that session
    await openSession(paged, 2, records, 6)
    await openSession(whole, 2, records, 6)
    // Then the client that did not opt in is refused as too large, and the paged one is not
    expect(answerOf(whole, 2).e?.code).toBe('snapshot-too-large')
    const page = snapshotOf(paged, 2)
    expect(answerOf(paged, 2).ok).toBe(true)
    expect(seqsOf(page.turns)).toEqual([5])
    expect(page.hasMore).toBe(true)
  })

  it('user declaring the page capability receives a page as large as its newest entry when that one entry is past the budget', async () => {
    // Given a window of ordinary turns whose newest turn is one 2.2 MB message:
    // the size two real `session.snapshot` replies measured on a relayed iPhone
    // client on 2026-10-19 against this 512 KiB budget
    const records = [...paddedTurns(4, 60 * 1024), ...paddedTurn(13, 2_200_000, 5)]
    const paged = makeConnection({ paired: true })
    await paged.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1', 'session.snapshot.page.v1'] }))
    // And the same window with that one turn left out
    const control = makeConnection({ paired: true })
    await control.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1', 'session.snapshot.page.v1'] }))
    // When both open their session
    await openSession(paged, 2, records, 15)
    await openSession(control, 2, paddedTurns(4, 60 * 1024), 12)
    // Then the page is that one entry: nothing is trimmed, split or dropped,
    // because a page ends at an entry and never inside one
    const page = snapshotOf(paged, 2)
    expect(answerOf(paged, 2).ok).toBe(true)
    expect(seqsOf(page.turns)).toEqual([14])
    expect(page.hasMore).toBe(true)
    // And the answer is 2200221 bytes against a budget of 524288 — the budget is
    // measured on the whole reply, which cannot bound a single entry — while the
    // same window of ordinary entries answers inside it
    expect(rawBytesOf(paged, 2)).toBe(2200221)
    expect(HISTORY_PAGE_BYTES).toBe(512 * 1024)
    expect(rawBytesOf(control, 2)).toBeLessThanOrEqual(HISTORY_PAGE_BYTES)
  })

  it('user not declaring the page capability receives the full window byte for byte and its budget is ignored', async () => {
    // Given two clients that did not declare the page capability, one asking for a tiny budget
    const plain = makeConnection({ paired: true })
    const unrelated = makeConnection({ paired: true })
    await unrelated.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.stream.v1'] }))
    // When both open the same session, the second with a budget it never opted into
    await openSession(plain, 2, WHOLE_WINDOW, 40)
    await openSession(unrelated, 2, WHOLE_WINDOW, 40, { maxBytes: 100 })
    // Then neither is paged: the whole window crosses, the two answers are the same bytes,
    // and the page capability's own field is absent
    expect(rawBytesOf(unrelated, 2)).toBe(rawBytesOf(plain, 2))
    expect(rawBytesOf(plain, 2)).toBeGreaterThan(HISTORY_PAGE_BYTES)
    expect(seqsOf(snapshotOf(plain, 2).turns)).toEqual(WHOLE_WINDOW_SEQS)
    expect(snapshotOf(plain, 2).turns).toHaveLength(WINDOW_TURNS)
    expect(snapshotOf(plain, 2).hasMore).toBeUndefined()
  })

  it('user declaring the page capability sees one turn carried across its first page and the older one', async () => {
    // Given a session whose single turn is larger than one page
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1', 'session.snapshot.page.v1'] }))
    const records = [
      record('turn/start', 1, 100, { turn: 1 }),
      ...Array.from({ length: 20 }, (_, index) => record('assistant/message', 2 + index, 101 + index, { text: 'y'.repeat(40 * 1024) })),
      record('turn/end', 22, 130, { turn: 1, reason: { kind: 'completed' } }),
    ]
    await openSession(harness, 2, records, 22)
    // When the client opens it and then asks for the page below its first one
    const first = snapshotOf(harness, 2)
    await harness.connection.handleText(requestFrame(3, 'session.history', { sessionId: 's-1', before: oldestSeqOf(first.turns) }))
    const second = answerOf(harness, 3).r as { turns: WireTurn[]; hasMore: boolean }
    // Then the same turn carries both pages, each with its own run of entries
    expect(first.turns).toHaveLength(1)
    expect(second.turns).toHaveLength(1)
    expect(first.turns[0]?.seq).toBe(1)
    expect(second.turns[0]?.seq).toBe(1)
    expect(first.turns[0]?.endSeq).toBe(22)
    expect(second.turns[0]?.endSeq).toBe(22)
    expect(seqsOf(first.turns).length).toBeGreaterThan(0)
    expect(seqsOf(second.turns).length).toBeGreaterThan(0)
    expect(Math.max(...seqsOf(second.turns))).toBeLessThan(Math.min(...seqsOf(first.turns)))
  })

  it('user declaring the page capability with a budget no page could be measured against is refused', async () => {
    // Given an opened session on a connection that declared the page capability
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.page.v1'] }))
    await openSession(harness, 2, WHOLE_WINDOW, 40)
    // When it asks for a page with each impossible budget
    await harness.connection.handleText(requestFrame(3, 'session.snapshot', { sessionId: 's-1', maxBytes: 0 }))
    await harness.connection.handleText(requestFrame(4, 'session.snapshot', { sessionId: 's-1', maxBytes: -1 }))
    await harness.connection.handleText(requestFrame(5, 'session.snapshot', { sessionId: 's-1', maxBytes: MAX_FRAME_BYTES + 1 }))
    // Then each is refused as malformed arguments rather than answered with a guess
    expect([3, 4, 5].map(id => answerOf(harness, id).e?.code)).toEqual(['invalid-args', 'invalid-args', 'invalid-args'])
  })
  it('user declaring the page capability learns a single turn was cut short by the budget', async () => {
    // Given one turn whose own entries are several pages long
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1', 'session.snapshot.page.v1'] }))
    const records = [
      record('turn/start', 1, 100, { turn: 1 }),
      ...Array.from({ length: 20 }, (_, index) => record('assistant/message', 2 + index, 101 + index, { text: 'y'.repeat(40 * 1024) })),
      record('turn/end', 22, 130, { turn: 1, reason: { kind: 'completed' } }),
    ]
    // When it opens that session
    await openSession(harness, 2, records, 22)
    // Then the page carries part of that same turn and still reports older entries
    const page = snapshotOf(harness, 2)
    expect(page.turns).toHaveLength(1)
    expect(page.turns[0]?.seq).toBe(1)
    expect(page.hasMore).toBe(true)
    expect(seqsOf(page.turns).length).toBeGreaterThan(1)
    expect(seqsOf(page.turns).length).toBeLessThan(20)
    // And the cursor stays that page's own oldest entry, with no second field
    expect(Math.min(...seqsOf(page.turns))).toBeGreaterThan(2)
    expect('nextBefore' in page).toBe(false)
  })

  it('user declaring the page capability learns nothing is older when one turn fits the page', async () => {
    // Given one turn that fits one page whole
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1', 'session.snapshot.page.v1'] }))
    // When it opens that session
    await openSession(harness, 2, ONE_SMALL_TURN, 4)
    // Then the page carries the whole turn and reports nothing below it
    const page = snapshotOf(harness, 2)
    expect(page.turns).toHaveLength(1)
    expect(seqsOf(page.turns)).toEqual([2, 3])
    expect(page.hasMore).toBe(false)
  })

  it('user declaring the page capability still learns more remains when whole turns fall outside the page', async () => {
    // Given a window of twelve turns, of which one page holds only the newest
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1', 'session.snapshot.page.v1'] }))
    // When it opens that session
    await openSession(harness, 2, WHOLE_WINDOW, 40)
    // Then the answer is unchanged: fewer turns than the window holds, and more below them
    const page = snapshotOf(harness, 2)
    expect(page.hasMore).toBe(true)
    expect(page.turns.length).toBeGreaterThan(0)
    expect(page.turns.length).toBeLessThan(WINDOW_TURNS)
    expect(seqsOf(page.turns).length).toBeLessThan(WHOLE_WINDOW_SEQS.length)
    expect('nextBefore' in page).toBe(false)
  })

  it('user reading a whole page is told hasMore speaks only about its own projection, even when the window stopped short', async () => {
    // Given a window whose every entry fits one page, over a session the window cannot reach the start of
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1', 'session.snapshot.page.v1'] }))
    // When it opens that session
    await openSession(harness, 2, ONE_SMALL_TURN, 510, {}, true)
    // Then the page is whole and reports nothing older, because nothing older exists in
    // the projection it was cut from: the harness's own window flag is not folded in, so
    // this field never claims a page the bridge cannot serve. Durable history below the
    // window is session.history.deep's question, not this field's.
    const page = snapshotOf(harness, 2)
    expect(seqsOf(page.turns)).toEqual([2, 3])
    expect(page.lastSeq).toBe(510)
    expect(page.hasMore).toBe(false)
    expect('nextBefore' in page).toBe(false)
  })

  it('user declaring the page capability ends the walk on a page that reports nothing older', async () => {
    // Given an opened first page over a window of twelve turns
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1', 'session.snapshot.page.v1'] }))
    await openSession(harness, 2, WHOLE_WINDOW, 40)
    // When it walks back from that page's own oldest entry until one reports no more
    const first = snapshotOf(harness, 2)
    const seen = seqsOf(first.turns)
    let before = oldestSeqOf(first.turns)
    let last: { turns: WireTurn[]; nextBefore?: number; hasMore: boolean } | undefined
    let rounds = 0
    for (; rounds < 12 && before !== undefined; rounds += 1) {
      const id = 20 + rounds
      await harness.connection.handleText(requestFrame(id, 'session.history', { sessionId: 's-1', before }))
      last = answerOf(harness, id).r as { turns: WireTurn[]; nextBefore?: number; hasMore: boolean }
      seen.push(...seqsOf(last.turns))
      if (!last.hasMore) break
      before = last.nextBefore
    }
    // Then the walk stops on the window's own oldest entries, reporting nothing older and no cursor
    expect(last?.hasMore).toBe(false)
    expect(Math.min(...seqsOf(last?.turns ?? []))).toBe(2)
    expect(last?.nextBefore).toBeUndefined()
    // And it got there in finitely many pages, every entry exactly once
    expect(rounds).toBeLessThan(12)
    expect(seen.length).toBe(new Set(seen).size)
  })

  it('user declaring the page capability asking below a window that stopped short gets a terminal empty page', async () => {
    // Given a page carrying the whole of a window that the harness reports as cut
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1', 'session.snapshot.page.v1'] }))
    await openSession(harness, 2, ONE_SMALL_TURN, 510, {}, true)
    const first = snapshotOf(harness, 2)
    // When it asks that same page's projection for the page below its oldest entry
    await harness.connection.handleText(requestFrame(3, 'session.history', { sessionId: 's-1', before: oldestSeqOf(first.turns) }))
    const below = answerOf(harness, 3).r as { turns: WireTurn[]; nextBefore?: number; hasMore: boolean }
    // Then the answer is empty and terminal rather than another cursor to loop on, so a
    // client that reads this field as "ask for more" always reaches a false
    expect(below.turns).toEqual([])
    expect(below.hasMore).toBe(false)
    expect(below.nextBefore).toBeUndefined()
  })
})
