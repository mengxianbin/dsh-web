import { describe, expect, it } from 'vitest'
import { ControllableStream, answerOf, makeConnection, requestFrame, settle, type ConnectionHarness } from './support/harness.ts'

/** One follow record as DSH writes it. */
function record(type: string, seq: number, time: number, data: unknown): unknown {
  return { type: 'event', event: { type, seq, time, data } }
}

/** One follow opening frame. */
function baseline(records: unknown[], cursor: number): unknown {
  return { type: 'snapshot', header: {}, cursor, hasMore: false, projections: {}, records }
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

/** One turn holding a rendered message, so the projection has something to carry. */
function oneTurn(text: string): unknown[] {
  return [
    record('turn/start', 1, 100, { turn: 1 }),
    record('user/message', 2, 101, { text }),
    record('turn/end', 3, 102, { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/** One roster row naming a delegated child's durable parent. */
function childRow(childSessionId: string, parentSessionId: string): Record<string, unknown> {
  return { sessionId: childSessionId, updatedAt: 1, running: false, blank: false, origin: 'subagent', parentSessionId }
}

/**
 * One roster row for the ordinary session a child hangs off. A child is
 * followable only while its parent is a session this roster authorizes.
 */
function parentRow(parentSessionId: string): Record<string, unknown> {
  return { sessionId: parentSessionId, updatedAt: 1, running: false, blank: false }
}

/** The refusal the harness raises for a delegated child asked as an ordinary session. */
function agentBusy(): Error {
  return Object.assign(new Error('subagent Sessions require their durable parent address'), { code: 'session/agent-busy' })
}

/**
 * A gateway that answers one child the way the harness does: an ordinary address
 * is refused with `session/agent-busy`, the durable parent address is served.
 */
function harnessForChild(harness: ConnectionHarness, childSessionId: string, parentSessionId: string): ControllableStream {
  const follow = new ControllableStream()
  harness.gateway.handler = async call =>
    call.method === 'list' ? { items: [parentRow(parentSessionId), childRow(childSessionId, parentSessionId)] } : { accepted: true }
  harness.gateway.follow = call => {
    const request = call.args.request as { address?: { kind?: string } } | undefined
    if (request?.address?.kind !== 'subagent') throw agentBusy()
    return follow.attach(call.signal).iterable()
  }
  return follow
}

/** Snapshot one session over a harness, returning the request id's answer. */
async function snapshotOf(harness: ConnectionHarness, id: number, sessionId: string) {
  return await harness.connection.handleText(requestFrame(id, 'session.snapshot', { sessionId }))
}

describe('delegated sessions over protocol v1', () => {
  it('user opening a delegated session receives its real history through the durable parent address', async () => {
    // Given a child the harness refuses as an ordinary session and serves as a delegated one
    const harness = makeConnection({ paired: true })
    const follow = harnessForChild(harness, 'child-1', 'session-parent')
    // When the user snapshots that child
    const pending = snapshotOf(harness, 1, 'child-1')
    follow.push(baseline(oneTurn('the child wrote this'), 42))
    await pending
    // Then the real turn crosses, and the child was addressed as a delegated one
    const payload = answerOf(harness, 1).r as { turns: WireTurn[]; lastSeq: number }
    expect(payload.lastSeq).toBe(42)
    expect(payload.turns).toHaveLength(1)
    expect(payload.turns[0]?.entries.map(entry => entry.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(payload.turns[0]?.entries[1]?.data).toEqual({ text: 'the child wrote this' })
    expect(payload.turns[0]?.reason).toBe('completed')
    expect(harness.gateway.streamRequests).toHaveLength(1)
    expect(harness.gateway.streamRequests[0]?.args).toEqual({
      request: {
        address: { kind: 'subagent', parentSessionId: 'session-parent', childSessionId: 'child-1', mode: 'unknown' },
        assistantStream: true,
        maxMessages: 200,
      },
    })
  })

  it('user opening a delegated session whose lineage the first roster read lost still reaches it on the harness refusal', async () => {
    // Given a roster read that fails once, and a harness that serves only the delegated address
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    let reads = 0
    harness.gateway.handler = async call => {
      if (call.method !== 'list') return { accepted: true }
      reads += 1
      if (reads === 1) throw Object.assign(new Error('the roster is unavailable'), { code: 'gateway/arguments-invalid' })
      return { items: [parentRow('session-parent'), childRow('child-1', 'session-parent')] }
    }
    harness.gateway.follow = call => {
      const request = call.args.request as { address?: { kind?: string } } | undefined
      if (request?.address?.kind !== 'subagent') throw agentBusy()
      return follow.attach(call.signal).iterable()
    }
    // When the user snapshots that child
    const pending = snapshotOf(harness, 6, 'child-1')
    await settle()
    follow.push(baseline(oneTurn('served on the retry'), 7))
    await pending
    // Then the refusal triggered a second roster read and the delegated retry
    expect(answerOf(harness, 6).ok).toBe(true)
    expect(reads).toBe(2)
    expect(harness.gateway.streamRequests).toHaveLength(2)
    expect(harness.gateway.streamRequests[0]?.args).toEqual({
      request: { address: { kind: 'session', sessionId: 'child-1' }, assistantStream: true, maxMessages: 200 },
    })
    expect(harness.gateway.streamRequests[1]?.args).toEqual({
      request: {
        address: { kind: 'subagent', parentSessionId: 'session-parent', childSessionId: 'child-1', mode: 'unknown' },
        assistantStream: true,
        maxMessages: 200,
      },
    })
  })

  it('user opening a second child of one parent costs no second roster read', async () => {
    // Given one roster read that already named both children of a parent
    const harness = makeConnection({ paired: true })
    const streams = new Map([['child-1', new ControllableStream()], ['child-2', new ControllableStream()]])
    harness.gateway.handler = async call => call.method === 'list'
      ? { items: [parentRow('session-parent'), childRow('child-1', 'session-parent'), childRow('child-2', 'session-parent')] }
      : { accepted: true }
    harness.gateway.follow = call => {
      const request = call.args.request as { address?: { childSessionId?: string; kind?: string } } | undefined
      if (request?.address?.kind !== 'subagent') throw agentBusy()
      const stream = streams.get(request.address.childSessionId ?? '')
      if (stream === undefined) throw new Error(`unexpected child ${String(request.address.childSessionId)}`)
      return stream.attach(call.signal).iterable()
    }
    // When both children are opened
    const first = snapshotOf(harness, 1, 'child-1')
    streams.get('child-1')?.push(baseline(oneTurn('one'), 5))
    await first
    const second = snapshotOf(harness, 2, 'child-2')
    streams.get('child-2')?.push(baseline(oneTurn('two'), 6))
    await second
    // Then both opened, and the roster was read exactly once
    expect(answerOf(harness, 1).ok).toBe(true)
    expect(answerOf(harness, 2).ok).toBe(true)
    expect(harness.gateway.countOf('session', 'list')).toBe(1)
  })

  it('user opening a session whose stream fails for another reason is told the harness code, not an empty history', async () => {
    // Given a follow stream that fails with a code of its own
    const harness = makeConnection({ paired: true })
    harness.gateway.follow = () => { throw Object.assign(new Error('the endpoint refused the named arguments'), { code: 'gateway/arguments-invalid' }) }
    // When the user snapshots a session
    await snapshotOf(harness, 3, 's-1')
    // Then the harness's own code crosses, so the client never reads it as "no history"
    expect(answerOf(harness, 3).e?.code).toBe('gateway/arguments-invalid')
  })

  it('user opening a session whose stream ends before any opening frame is refused rather than shown empty', async () => {
    // Given a follow stream that ends without producing a frame
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = snapshotOf(harness, 4, 's-1')
    follow.end()
    // When the snapshot is awaited
    await pending
    // Then the refusal names the missing opening frame
    expect(answerOf(harness, 4).e?.code).toBe('snapshot-unavailable')
  })

  it('user opening a blank session receives its empty turn instead of a refusal', async () => {
    // Given a client that declared the trim capability, over a session whose log holds only bookkeeping
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['session.snapshot.trim.v1'] }))
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    const pending = snapshotOf(harness, 5, 's-1')
    follow.push(baseline([
      record('permission/preset', 0, 100, { preset: 'default' }),
      record('sandbox/mode', 1, 101, { mode: 'workspace-write' }),
    ], 1))
    await pending
    // When the snapshot is answered
    const payload = answerOf(harness, 5).r as { turns: WireTurn[]; lastSeq: number }
    // Then it is an honest empty projection: a real turn carrying no entry, and the session's own cursor
    expect(answerOf(harness, 5).ok).toBe(true)
    expect(payload.turns).toHaveLength(1)
    expect(payload.turns[0]?.entries).toEqual([])
    expect(payload.lastSeq).toBe(1)
  })
})
