import { describe, expect, it } from 'vitest'
import { DEEP_HISTORY_WINDOW, HISTORY_PAGE_BYTES } from '../src/core/connection.ts'
import { ControllableStream, answerOf, makeConnection, requestFrame, type ConnectionHarness } from './support/harness.ts'

/** One durable record as DSH stores it. */
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

interface DeepPage {
  readonly turns: WireTurn[]
  readonly nextBefore?: number
  readonly hasMore: boolean
}

/** One completed four-entry turn whose assistant message carries `bytes` padding. */
function turnOf(seq: number, bytes: number, turn: number): unknown[] {
  return [
    record('turn/start', seq, 100 + seq, { turn }),
    record('user/message', seq + 1, 101 + seq, { text: `ask ${turn}` }),
    record('assistant/message', seq + 2, 102 + seq, { text: 'x'.repeat(bytes) }),
    record('turn/end', seq + 3, 103 + seq, { turn, reason: { kind: 'completed' } }),
  ]
}

/** Several completed turns, oldest first. */
function turnsOf(count: number, bytesPerMessage: number): unknown[] {
  const records: unknown[] = []
  for (let index = 0; index < count; index += 1) records.push(...turnOf(1 + index * 4, bytesPerMessage, index + 1))
  return records
}

/** Every entry seq a payload carries, in the order it carries them. */
function seqsOf(turns: readonly WireTurn[]): number[] {
  return turns.flatMap(turn => turn.entries.map(entry => entry.seq))
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

/** One roster row for an ordinary session. */
function parentRow(sessionId: string): Record<string, unknown> {
  return { sessionId, updatedAt: 1, running: false, blank: false }
}

/** One roster row naming a delegated child's durable parent. */
function childRow(childSessionId: string, parentSessionId: string): Record<string, unknown> {
  return { sessionId: childSessionId, updatedAt: 1, running: false, blank: false, origin: 'subagent', parentSessionId }
}

/** The refusal the harness raises for a delegated child asked as an ordinary session. */
function agentBusy(): Error {
  return Object.assign(new Error('subagent Sessions require their durable parent address'), { code: 'session/agent-busy' })
}

/**
 * A durable session store that pages the way `session/page` does.
 *
 * Only what the bridge can observe is modelled: the inclusive `throughSeq` cut,
 * the exclusive `beforeSeq` cut, and a page bound counted in user and assistant
 * messages. `messagesPerRead` below the span a suite hands over is what makes the
 * store itself end a page short, so the bridge's fold of the store's own
 * `hasMore` is exercised rather than assumed.
 */
function storeOf(records: readonly unknown[], cursor: number, messagesPerRead = 10_000) {
  const events = records.map(entry => (entry as { event: { type: string; seq: number } }).event)
  return {
    cursor,
    page(args: Readonly<Record<string, unknown>>) {
      const throughSeq = args.throughSeq as number
      const beforeSeq = args.beforeSeq as number | undefined
      const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)
      let cut = 0
      let messages = 0
      for (let index = end - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event === undefined) continue
        if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
        messages += 1
        if (messages >= messagesPerRead) {
          cut = index
          break
        }
      }
      return { records: records.slice(cut, end), hasMore: cut > 0 }
    },
  }
}

/** A connection whose host serves one durable store, with an empty roster. */
function deepHarness(store: ReturnType<typeof storeOf>): ConnectionHarness {
  const harness = makeConnection({ paired: true })
  harness.gateway.handler = async call => {
    if (call.method === 'list') return { items: [] }
    if (call.method === 'projections') return { kind: 'sequenced', asOfSeq: store.cursor, values: {} }
    if (call.method === 'page') return store.page(call.args.request as Readonly<Record<string, unknown>>)
    return { accepted: true }
  }
  return harness
}

/** One deep-history answer's payload. */
function deepPageOf(harness: ConnectionHarness, id: number): DeepPage {
  return answerOf(harness, id).r as DeepPage
}

describe('deep history over protocol v1', () => {
  it('user omitting the watermark receives the newest page of a session it never opened', async () => {
    // Given a session of eight 64 KiB turns, larger than one page, reachable only through the store
    const records = turnsOf(8, 64 * 1024)
    const harness = deepHarness(storeOf(records, 32))
    // When the client asks for deep history without a watermark
    await harness.connection.handleText(requestFrame(1, 'session.history.deep', { sessionId: 's-1' }))
    // Then the newest page crosses, inside the default budget, with more still below it
    const page = deepPageOf(harness, 1)
    const seqs = seqsOf(page.turns)
    expect(rawBytesOf(harness, 1)).toBeLessThanOrEqual(HISTORY_PAGE_BYTES)
    expect(page.hasMore).toBe(true)
    expect(seqs).toContain(32)
    expect(seqs.length).toBeGreaterThan(1)
    expect(seqs.length).toBeLessThan(32)
    // And its cursor is its own oldest entry, so no entry is skipped or repeated
    expect(page.nextBefore).toBe(Math.min(...seqs))
    // And the store was asked once, for the whole log, at the session's own address
    expect(harness.gateway.countOf('session', 'page')).toBe(1)
    expect(harness.gateway.lastArgs('session', 'page')).toEqual({
      request: {
        address: { kind: 'session', sessionId: 's-1' },
        throughSeq: 32,
        ...DEEP_HISTORY_WINDOW,
      },
    })
  })

  it('user paging back with nextBefore reaches the oldest entry, every entry exactly once', async () => {
    // Given a session whose entries span several pages
    const records = turnsOf(30, 40 * 1024)
    const harness = deepHarness(storeOf(records, 120))
    const wholeLog = Array.from({ length: 120 }, (_, index) => index + 1)
    // When the client walks backwards from the newest page until nothing older remains
    const pages: number[][] = []
    let before: number | undefined
    for (let index = 0; index < 40; index += 1) {
      const id = 10 + index
      await harness.connection.handleText(requestFrame(id, 'session.history.deep', {
        sessionId: 's-1',
        ...(before === undefined ? {} : { before }),
      }))
      const page = deepPageOf(harness, id)
      pages.push(seqsOf(page.turns))
      if (page.hasMore !== true) break
      // The cursor for the next page is this page's own oldest entry, nothing else
      expect(page.nextBefore).toBe(Math.min(...seqsOf(page.turns)))
      before = page.nextBefore
    }
    // Then every page after the first lies strictly below the one before it
    for (let index = 1; index < pages.length; index += 1) {
      const previous = pages[index - 1] ?? []
      const current = pages[index] ?? []
      expect(Math.max(...current)).toBeLessThan(Math.min(...previous))
    }
    // And together they tile the whole log, each entry exactly once
    const seen = pages.flat()
    expect(pages.length).toBeGreaterThan(1)
    expect(seen.length).toBe(new Set(seen).size)
    expect([...seen].sort((left, right) => left - right)).toEqual(wholeLog)
  })

  it('user reaching the oldest entry receives hasMore false and no nextBefore', async () => {
    // Given a session that fits one page entirely
    const harness = deepHarness(storeOf(turnsOf(2, 64), 8))
    // When the client asks for its newest page
    await harness.connection.handleText(requestFrame(1, 'session.history.deep', { sessionId: 's-1' }))
    // Then nothing older remains and no cursor restates what cannot be continued
    const page = deepPageOf(harness, 1)
    expect(seqsOf(page.turns)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(page.hasMore).toBe(false)
    expect('nextBefore' in page).toBe(false)
  })

  it('user receiving an entry larger than the whole budget gets it as a page of its own', async () => {
    // Given a session whose newest message alone exceeds the budget the client asks for
    const records = [
      ...turnOf(1, 64, 1),
      record('turn/start', 5, 105, { turn: 2 }),
      record('user/message', 6, 106, { text: 'ask 2' }),
      record('assistant/message', 7, 107, { text: 'y'.repeat(8192) }),
    ]
    const harness = deepHarness(storeOf(records, 7))
    // When the client pages with a budget smaller than that one entry
    await harness.connection.handleText(requestFrame(1, 'session.history.deep', { sessionId: 's-1', maxBytes: 4096 }))
    // Then the entry crosses alone instead of being refused
    expect(answerOf(harness, 1).ok).toBe(true)
    const page = deepPageOf(harness, 1)
    expect(seqsOf(page.turns)).toEqual([7])
    expect(page.turns[0]?.entries[0]?.type).toBe('assistant/message')
    expect(page.hasMore).toBe(true)
    expect(page.nextBefore).toBe(7)
    // And that page is honestly over the budget it was given, which is the point
    expect(rawBytesOf(harness, 1)).toBeGreaterThan(4096)
  })

  it('user asking with an unusable watermark or budget is refused invalid-args', async () => {
    // Given a session that would answer a well-formed request
    const harness = deepHarness(storeOf(turnsOf(2, 64), 8))
    // When the watermark or the budget is not a usable page argument
    const requests: Record<string, unknown>[] = [
      { sessionId: 's-1', before: -1 },
      { sessionId: 's-1', before: 1.5 },
      { sessionId: 's-1', before: 'oldest' },
      { sessionId: 's-1', maxBytes: 0 },
      { sessionId: 's-1', maxBytes: 1.5 },
      {},
    ]
    const codes: (string | undefined)[] = []
    for (const [index, payload] of requests.entries()) {
      const id = 20 + index
      await harness.connection.handleText(requestFrame(id, 'session.history.deep', payload))
      codes.push(answerOf(harness, id).e?.code)
    }
    // Then every one of them is refused for its arguments, before any read happens
    expect(codes).toEqual(['invalid-args', 'invalid-args', 'invalid-args', 'invalid-args', 'invalid-args', 'invalid-args'])
    expect(harness.gateway.countOf('session', 'page')).toBe(0)
  })

  it('user reading below the opening window is served from the store, not from the follow baseline', async () => {
    // Given a session whose follow window holds only its newest four turns
    const records = turnsOf(8, 64)
    const harness = deepHarness(storeOf(records, 32))
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const opened = harness.connection.handleText(requestFrame(1, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 32, hasMore: true, projections: {}, records: records.slice(16) })
    await opened
    // When the client asks for the page below the oldest entry that window carried
    await harness.connection.handleText(requestFrame(2, 'session.history.deep', { sessionId: 's-1', before: 17 }))
    // Then the store answers with the entries the window never had
    const page = deepPageOf(harness, 2)
    expect(seqsOf(page.turns)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    expect(page.hasMore).toBe(false)
    // And the deep read opened no stream of its own and left the subscription alone
    expect(harness.gateway.streamRequests).toHaveLength(1)
    expect(follow.ended).toBe(false)
  })

  it('user repeating one request receives the same page, because the method holds no state', async () => {
    // Given a session served from the durable store
    const harness = deepHarness(storeOf(turnsOf(6, 32 * 1024), 24))
    // When the same watermark is asked for twice
    await harness.connection.handleText(requestFrame(1, 'session.history.deep', { sessionId: 's-1', before: 21 }))
    await harness.connection.handleText(requestFrame(2, 'session.history.deep', { sessionId: 's-1', before: 21 }))
    // Then both answers are the same page, byte for byte
    const first = harness.transport.responseTo(1)?.r
    const second = harness.transport.responseTo(2)?.r
    expect(second).toEqual(first)
    expect(harness.gateway.countOf('session', 'page')).toBe(2)
    expect(harness.gateway.streamRequests).toHaveLength(0)
  })

  it('user opening a delegated child receives its durable history through the parent address', async () => {
    // Given a child the harness refuses as an ordinary session and serves as a delegated one
    const store = storeOf(turnsOf(2, 64), 8)
    const harness = makeConnection({ paired: true })
    harness.gateway.handler = async call => {
      if (call.method === 'list') {
        return { items: [parentRow('session-parent'), childRow('child-1', 'session-parent')] }
      }
      if (call.method === 'projections') return { kind: 'sequenced', asOfSeq: store.cursor, values: {} }
      if (call.method === 'page') {
        const request = call.args.request as { address?: { kind?: string } }
        if (request.address?.kind !== 'subagent') throw agentBusy()
        return store.page(request)
      }
      return { accepted: true }
    }
    // When the client asks that child for deep history
    await harness.connection.handleText(requestFrame(1, 'session.history.deep', { sessionId: 'child-1' }))
    // Then its real entries cross, through the address that names its parent
    const page = deepPageOf(harness, 1)
    expect(seqsOf(page.turns)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(harness.gateway.lastArgs('session', 'page')).toMatchObject({
      request: {
        address: { kind: 'subagent', parentSessionId: 'session-parent', childSessionId: 'child-1', mode: 'unknown' },
        throughSeq: 8,
      },
    })
  })

  it('user reading a child whose roster was momentarily unreadable is still served after the retry', async () => {
    // Given a roster read that fails once and then names the child's parent
    const store = storeOf(turnsOf(2, 64), 8)
    const harness = makeConnection({ paired: true })
    let rosterReads = 0
    harness.gateway.handler = async call => {
      if (call.method === 'list') {
        rosterReads += 1
        if (rosterReads === 1) throw Object.assign(new Error('roster unavailable'), { code: 'gateway/internal' })
        return { items: [parentRow('session-parent'), childRow('child-1', 'session-parent')] }
      }
      if (call.method === 'projections') return { kind: 'sequenced', asOfSeq: store.cursor, values: {} }
      if (call.method === 'page') {
        const request = call.args.request as { address?: { kind?: string } }
        if (request.address?.kind !== 'subagent') throw agentBusy()
        return store.page(request)
      }
      return { accepted: true }
    }
    // When the client asks that child for deep history
    await harness.connection.handleText(requestFrame(1, 'session.history.deep', { sessionId: 'child-1' }))
    // Then the harness's own address refusal is what buys the second attempt
    const page = deepPageOf(harness, 1)
    expect(seqsOf(page.turns)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(harness.gateway.countOf('session', 'page')).toBe(2)
    expect(harness.gateway.lastArgs('session', 'page')).toMatchObject({
      request: { address: { kind: 'subagent', childSessionId: 'child-1' } },
    })
  })

  it('user paging a store that cuts its own read short still walks every entry exactly once', async () => {
    // Given a store whose every read ends after two messages, well before its log ends
    const records = turnsOf(6, 64)
    const harness = deepHarness(storeOf(records, 24, 2))
    // When the client walks backwards from the newest page
    const seen: number[] = []
    let before: number | undefined
    for (let index = 0; index < 40; index += 1) {
      const id = 30 + index
      await harness.connection.handleText(requestFrame(id, 'session.history.deep', {
        sessionId: 's-1',
        ...(before === undefined ? {} : { before }),
      }))
      const page = deepPageOf(harness, id)
      seen.push(...seqsOf(page.turns))
      if (page.hasMore !== true) break
      // The cursor is the answer's own oldest entry even when the answer covered a whole read
      expect(page.nextBefore).toBe(Math.min(...seqsOf(page.turns)))
      before = page.nextBefore
    }
    // Then the store's own `hasMore` was folded in: the walk continues past every short read
    expect(harness.gateway.countOf('session', 'page')).toBeGreaterThan(1)
    expect(seen.length).toBe(new Set(seen).size)
    expect([...seen].sort((left, right) => left - right)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1))
  })

  it('user asking for a session the store reports no watermark for is refused instead of guessed at', async () => {
    // Given a host that answers the projection read with no durable cut
    const harness = makeConnection({ paired: true })
    harness.gateway.handler = async call => {
      if (call.method === 'list') return { items: [] }
      if (call.method === 'projections') return null
      return { accepted: true }
    }
    // When the client asks that session for deep history
    await harness.connection.handleText(requestFrame(1, 'session.history.deep', { sessionId: 's-missing' }))
    // Then the answer names the missing read rather than paging from an invented cut
    expect(answerOf(harness, 1).e?.code).toBe('snapshot-unavailable')
    expect(harness.gateway.countOf('session', 'page')).toBe(0)
  })

  it('user learning the method from hello is told the capability, and served without declaring it', async () => {
    // Given a client that declared nothing at all
    const harness = deepHarness(storeOf(turnsOf(2, 64), 8))
    // When it greets the bridge
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1 }))
    // Then the capability is advertised, because the method is served to everyone
    const hello = answerOf(harness, 1).r as { capabilities: string[] }
    expect(hello.capabilities).toContain('session.deep-history.v1')
    // And a client that never declared it is still answered
    await harness.connection.handleText(requestFrame(2, 'session.history.deep', { sessionId: 's-1' }))
    expect(answerOf(harness, 2).ok).toBe(true)
  })
})
