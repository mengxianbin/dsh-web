import { describe, expect, it } from 'vitest'
import { ControllableStream, answerOf, makeConnection, requestFrame, settle, type ConnectionHarness, type WireFrame } from './support/harness.ts'

/** One follow record as DSH writes it. */
function record(type: string, seq: number, time: number, data: unknown): unknown {
  return { type: 'event', event: { type, seq, time, data } }
}

/** One follow opening frame. */
function baseline(records: unknown[], cursor: number): unknown {
  return { type: 'snapshot', header: {}, cursor, hasMore: false, projections: {}, records }
}

/** One roster row for an ordinary session. */
function rootRow(sessionId: string): Record<string, unknown> {
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

/** One controllable follow stream per session id, pre-created so a test can push before the request arrives. */
function streamsOf(harness: ConnectionHarness, ids: readonly string[]): Map<string, ControllableStream> {
  const streams = new Map<string, ControllableStream>()
  for (const id of ids) streams.set(id, new ControllableStream())
  harness.gateway.follow = call => {
    const request = call.args.request as { address?: { kind?: string; sessionId?: string; childSessionId?: string } } | undefined
    const address = request?.address
    const key = address?.kind === 'subagent' ? address.childSessionId ?? '' : address?.sessionId ?? ''
    const stream = streams.get(key)
    if (stream === undefined) throw new Error(`unexpected follow for ${key}`)
    return stream.attach(call.signal).iterable()
  }
  return streams
}

/** Answer one roster read with the given rows. */
function rosterOf(harness: ConnectionHarness, rows: readonly Record<string, unknown>[]): void {
  harness.gateway.handler = async call => call.method === 'list' ? { items: [...rows] } : { accepted: true }
}

/** Push one opening baseline into a session's stream, then open that session and await the answer. */
async function openSession(
  harness: ConnectionHarness,
  streams: Map<string, ControllableStream>,
  id: number,
  sessionId: string,
  records: unknown[] = [],
  cursor = 0,
): Promise<ControllableStream> {
  const stream = streams.get(sessionId)
  if (stream === undefined) throw new Error(`no stream for ${sessionId}`)
  stream.push(baseline(records, cursor))
  await harness.connection.handleText(requestFrame(id, 'session.snapshot', { sessionId }))
  return stream
}

/** Every `session.delta` the connection published, in arrival order. */
function deltas(harness: ConnectionHarness): Record<string, unknown>[] {
  return harness.transport
    .frames()
    .filter((frame: WireFrame) => frame.t === 'ev' && frame.m === 'session.delta')
    .map(frame => frame.p as Record<string, unknown>)
}

/** The last delta of one kind, or undefined when none was published. */
function lastDeltaOf(harness: ConnectionHarness, kind: string): Record<string, unknown> | undefined {
  return deltas(harness).findLast(delta => delta.kind === kind)
}

/** Publish one durable event into an open session's stream and let the drain loop run. */
async function pushEvent(stream: ControllableStream, type: string, seq: number, data: unknown): Promise<void> {
  stream.push(record(type, seq, 100 + seq, data))
  await settle()
}

/** One durable `user/message` carrying the host's own source record. */
function userMessage(id: string, source: Record<string, unknown>, text = 'hi'): unknown {
  return { id, role: 'user', source, content: [{ type: 'text', text }] }
}

describe('subagent threads over protocol v1', () => {
  it('user learns where a message came from when the host recorded a human source', async () => {
    // Given a session open over a follow stream
    const harness = makeConnection({ paired: true })
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 1, 's-1')
    // When the host publishes a message a human typed
    await pushEvent(stream, 'user/message', 10, userMessage('m-1', { kind: 'user', rpcId: 'r-1' }))
    // Then the delta names the actor as human and keeps the host's own source kind
    expect(lastDeltaOf(harness, 'user-message')?.actor).toEqual({ kind: 'human', sourceKind: 'user' })
  })

  it('user sees an approval prompt attributed to a human', async () => {
    // Given a session open over a follow stream
    const harness = makeConnection({ paired: true })
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 1, 's-1')
    // When the host publishes an approved-request message
    await pushEvent(stream, 'user/message', 11, userMessage('m-2', { kind: 'user-approval' }))
    // Then it is attributed to a human with the source kind verbatim
    expect(lastDeltaOf(harness, 'user-message')?.actor).toEqual({ kind: 'human', sourceKind: 'user-approval' })
  })

  it('user sees a message from another agent session attributed to that session', async () => {
    // Given a session open over a follow stream
    const harness = makeConnection({ paired: true })
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 1, 's-1')
    // When the host relays a message from a child session
    await pushEvent(stream, 'user/message', 12, userMessage('m-3', { kind: 'agent-message', form: 'relay', senderSessionId: 'child-9' }))
    // Then the actor is the agent that sent it, by durable session id
    expect(lastDeltaOf(harness, 'user-message')?.actor).toEqual({ kind: 'agent', sourceKind: 'agent-message', sessionId: 'child-9' })
  })

  it('user sees a settled subagent notice attributed to the agent that settled', async () => {
    // Given a session open over a follow stream
    const harness = makeConnection({ paired: true })
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 1, 's-1')
    // When the host publishes a settle notice naming the child
    await pushEvent(stream, 'user/message', 13, userMessage('m-4', { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-9' }))
    // Then it is an agent actor with that session id
    expect(lastDeltaOf(harness, 'user-message')?.actor).toEqual({ kind: 'agent', sourceKind: 'subagent-settled', sessionId: 'child-9' })
  })

  it('user sees a settle notice without a session id attributed to an unnamed agent', async () => {
    // Given a session open over a follow stream
    const harness = makeConnection({ paired: true })
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 1, 's-1')
    // When a settle notice carries no sender session
    await pushEvent(stream, 'user/message', 14, userMessage('m-5', { kind: 'subagent-settled', form: 'notice' }))
    // Then the actor stays an agent and no session id is invented
    expect(lastDeltaOf(harness, 'user-message')?.actor).toEqual({ kind: 'agent', sourceKind: 'subagent-settled' })
  })

  it('user sees the host label on an actor that has one', async () => {
    // Given a session open over a follow stream
    const harness = makeConnection({ paired: true })
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 1, 's-1')
    // When the host's source carries a display label of its own
    await pushEvent(stream, 'user/message', 16, userMessage('m-8', { kind: 'user', label: 'the desk phone' }))
    // Then the label crosses verbatim and nothing is added beside it
    expect(lastDeltaOf(harness, 'user-message')?.actor).toEqual({ kind: 'human', sourceKind: 'user', label: 'the desk phone' })
  })

  it('user sees an unknown host source kind attributed to the system rather than dropped', async () => {
    // Given a session open over a follow stream
    const harness = makeConnection({ paired: true })
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 1, 's-1')
    // When the host publishes a source kind this protocol does not classify
    await pushEvent(stream, 'user/message', 15, userMessage('m-6', { kind: 'runtime-context', form: 'snapshot' }))
    // Then the message still crosses, attributed to the system with the kind verbatim
    const delta = lastDeltaOf(harness, 'user-message')
    expect(delta?.text).toBe('hi')
    expect(delta?.actor).toEqual({ kind: 'system', sourceKind: 'runtime-context' })
  })

  it('user sees the same actor on the messages of a snapshot', async () => {
    // Given a baseline holding a human message and an assistant message
    const harness = makeConnection({ paired: true })
    const streams = streamsOf(harness, ['s-1'])
    const records = [
      record('turn/start', 1, 100, { turn: 1 }),
      record('user/message', 2, 101, userMessage('m-7', { kind: 'user' })),
      record('assistant/message', 3, 102, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
      record('turn/end', 4, 103, { turn: 1, reason: { kind: 'completed' } }),
    ]
    // When the user opens that session
    await openSession(harness, streams, 1, 's-1', records, 4)
    // Then the user message entry carries the actor and the assistant entry carries none
    const turns = (answerOf(harness, 1).r as { turns: { entries: Record<string, unknown>[] }[] }).turns
    const entries = turns[0]?.entries ?? []
    expect(entries[1]?.actor).toEqual({ kind: 'human', sourceKind: 'user' })
    expect(entries[2]).not.toHaveProperty('actor')
  })

  it('user subscribing to a spawned child sees a subagent delta naming the child and its spawning call', async () => {
    // Given a session open, and a client that declared the subagent thread capability
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['subagent.thread.v1'] }))
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 2, 's-1')
    // When the host issues the spawning call and then registers the child
    await pushEvent(stream, 'step/start', 20, { turn: 1, step: 1 })
    await pushEvent(stream, 'tool/call', 21, { turn: 1, step: 1, callId: 'call-spawn', name: 'subagent', arguments: '{}' })
    await pushEvent(stream, 'subagent/catalog', 22, { version: 0, childId: 'child-9', childCreatedAt: 5, mode: 'continuable', label: 'Thread probe' })
    // Then one delta names the child, its label and mode, and the call that spawned it
    expect(lastDeltaOf(harness, 'subagent')).toEqual({
      sessionId: 's-1',
      kind: 'subagent',
      childId: 'child-9',
      label: 'Thread probe',
      mode: 'continuable',
      callId: 'call-spawn',
    })
  })

  it('user sees a subagent delta without a call id when two calls share the step that spawned it', async () => {
    // Given a session open, and a client that declared the subagent thread capability
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['subagent.thread.v1'] }))
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 2, 's-1')
    // When one step issued two calls before the child was registered
    await pushEvent(stream, 'step/start', 30, { turn: 1, step: 1 })
    await pushEvent(stream, 'tool/call', 31, { turn: 1, step: 1, callId: 'call-a', name: 'read', arguments: '{}' })
    await pushEvent(stream, 'tool/call', 32, { turn: 1, step: 1, callId: 'call-b', name: 'subagent', arguments: '{}' })
    await pushEvent(stream, 'subagent/catalog', 33, { version: 0, childId: 'child-9', mode: 'continuable' })
    // Then the child still crosses, with no guessed call id
    const delta = lastDeltaOf(harness, 'subagent')
    expect(delta?.childId).toBe('child-9')
    expect(delta).not.toHaveProperty('callId')
  })

  it('user sees the second child of one spawning call without a call id', async () => {
    // Given a session open, and a client that declared the subagent thread capability
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['subagent.thread.v1'] }))
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 2, 's-1')
    // When one call registers two children in a row
    await pushEvent(stream, 'step/start', 50, { turn: 1, step: 1 })
    await pushEvent(stream, 'tool/call', 51, { turn: 1, step: 1, callId: 'call-team', name: 'subagent', arguments: '{}' })
    await pushEvent(stream, 'subagent/catalog', 52, { version: 0, childId: 'child-a', mode: 'continuable' })
    await pushEvent(stream, 'subagent/catalog', 53, { version: 0, childId: 'child-b', mode: 'continuable' })
    // Then only the first child is tied to that call
    const published = deltas(harness).filter(delta => delta.kind === 'subagent')
    expect(published.map(delta => delta.childId)).toEqual(['child-a', 'child-b'])
    expect(published[0]?.callId).toBe('call-team')
    expect(published[1]).not.toHaveProperty('callId')
  })

  it('user on a client without the capability sees no subagent delta at all', async () => {
    // Given a session open on a client that declared no capability
    const harness = makeConnection({ paired: true })
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1 }))
    const streams = streamsOf(harness, ['s-1'])
    const stream = await openSession(harness, streams, 2, 's-1')
    // When the host registers a child
    await pushEvent(stream, 'subagent/catalog', 40, { version: 0, childId: 'child-9', mode: 'continuable' })
    // Then nothing about it crossed
    expect(lastDeltaOf(harness, 'subagent')).toBeUndefined()
  })

  it('user on a child session whose parent is an authorized session reads its real history', async () => {
    // Given a roster naming both a parent and its delegated child, and a harness that serves only the delegated address
    const harness = makeConnection({ paired: true })
    rosterOf(harness, [rootRow('p-1'), childRow('child-9', 'p-1')])
    const follow = new ControllableStream()
    harness.gateway.follow = call => {
      const request = call.args.request as { address?: { kind?: string } } | undefined
      if (request?.address?.kind !== 'subagent') throw agentBusy()
      return follow.attach(call.signal).iterable()
    }
    const pending = harness.connection.handleText(requestFrame(3, 'session.snapshot', { sessionId: 'child-9' }))
    await settle()
    follow.push(baseline([record('turn/start', 1, 100, { turn: 1 }), record('turn/end', 2, 101, { turn: 1, reason: { kind: 'completed' } })], 2))
    // When the user opens that child
    await pending
    // Then the child's history crosses through the delegated address
    const answer = answerOf(harness, 3)
    expect(answer.ok).toBe(true)
    expect((answer.r as { turns: unknown[] }).turns).toHaveLength(1)
    expect(harness.gateway.streamRequests.at(-1)?.args).toEqual({
      request: {
        address: { kind: 'subagent', parentSessionId: 'p-1', childSessionId: 'child-9', mode: 'unknown' },
        assistantStream: true,
        maxMessages: 200,
      },
    })
  })

  it('user on a child session whose parent no roster resolves is refused as not followable', async () => {
    // Given a roster naming a child whose parent is a session this host never declares
    const harness = makeConnection({ paired: true })
    rosterOf(harness, [childRow('child-9', 'foreign-parent')])
    const streams = streamsOf(harness, ['child-9'])
    // When the user opens that child
    await openSession(harness, streams, 4, 'child-9')
    // Then the read is refused rather than followed blind, and no stream was opened for it
    expect(answerOf(harness, 4).e?.code).toBe('session-not-followable')
    expect(harness.gateway.streamRequests).toHaveLength(0)
  })

  it('user reading the history of a child whose parent no roster resolves is refused as not followable', async () => {
    // Given a roster naming a child whose parent this host never declares
    const harness = makeConnection({ paired: true })
    rosterOf(harness, [childRow('child-9', 'foreign-parent')])
    // When the user asks for that child's older history
    await harness.connection.handleText(requestFrame(5, 'session.history', { sessionId: 'child-9' }))
    // Then the refusal is the same one, and nothing was followed
    expect(answerOf(harness, 5).e?.code).toBe('session-not-followable')
    expect(harness.gateway.streamRequests).toHaveLength(0)
  })

  it('user who already opened the parent may open its child even when the roster names no parent row', async () => {
    // Given a roster naming only the child, and a phone that opened the parent first
    const harness = makeConnection({ paired: true })
    rosterOf(harness, [childRow('child-9', 'p-1')])
    const streams = streamsOf(harness, ['p-1', 'child-9'])
    harness.gateway.follow = call => {
      const request = call.args.request as { address?: { childSessionId?: string; kind?: string } } | undefined
      const key = request?.address?.kind === 'subagent' ? request.address.childSessionId ?? '' : 'p-1'
      const stream = streams.get(key)
      if (stream === undefined) throw new Error(`unexpected follow for ${key}`)
      return stream.attach(call.signal).iterable()
    }
    await openSession(harness, streams, 6, 'p-1', [], 0)
    // When the same connection opens that child
    await openSession(harness, streams, 7, 'child-9', [], 0)
    // Then the child is served, because the session it hangs off is already authorized here
    expect(answerOf(harness, 6).ok).toBe(true)
    expect(answerOf(harness, 7).ok).toBe(true)
  })

  it('user on an ordinary session is served exactly as before', async () => {
    // Given a roster naming an ordinary session
    const harness = makeConnection({ paired: true })
    rosterOf(harness, [rootRow('s-1')])
    const streams = streamsOf(harness, ['s-1'])
    // When the user opens it
    await openSession(harness, streams, 8, 's-1', [], 9)
    // Then its turns and cursor cross unchanged
    expect(answerOf(harness, 8).ok).toBe(true)
    expect((answerOf(harness, 8).r as { lastSeq: number }).lastSeq).toBe(9)
  })

  it('user sees the thread capability and a minor version at or above two in the handshake', async () => {
    // Given a paired connection that greets the bridge
    const harness = makeConnection({ paired: true })
    // When the handshake is answered
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, minor: 1, client: 'ios/0.1' }))
    // Then it reports the capabilities this bridge serves, and a minor version
    // that carries this channel. Later extensions raise the minor further, so
    // this asserts what the thread channel needs instead of freezing the number.
    const payload = answerOf(harness, 1).r as { minor: number; capabilities: string[] }
    expect(payload.minor).toBeGreaterThanOrEqual(2)
    expect(payload.capabilities).toContain('subagent.thread.v1')
  })
})
