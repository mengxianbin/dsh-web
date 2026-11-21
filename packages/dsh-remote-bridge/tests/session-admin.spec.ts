/**
 * The session-admin channel: the host's rename, pin, unpin, archive and
 * unarchive endpoints forwarded one-to-one behind `session.admin.v1`, the
 * arguments this bridge refuses before a write is asked of the host, and the
 * announcement that puts the five methods in a client's protocol at all.
 * @module tests/session-admin
 */

import { describe, expect, it } from 'vitest'
import { CAP_SESSION_ADMIN, CAP_WORKSPACE } from '../src/core/protocol.ts'
import { answerOf, makeConnection, requestFrame, type ConnectionHarness } from './support/harness.ts'

/**
 * Connect a paired client that declared one set of capabilities.
 * @param cap - the capabilities the client declares.
 * @param paired - whether the connection presented a device token.
 * @returns the harness, after its handshake was answered.
 */
async function adminConnection(cap: readonly string[] = [CAP_SESSION_ADMIN], paired = true): Promise<ConnectionHarness> {
  const harness = makeConnection({ paired })
  await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: [...cap] }))
  return harness
}

/** The request the gateway was handed for one endpoint, or undefined when it was never called. */
function requestOf(harness: ConnectionHarness, namespace: string, method: string): Record<string, unknown> | undefined {
  return harness.gateway.lastArgs(namespace, method) as Record<string, unknown> | undefined
}

describe('session.rename', () => {
  it('operator renaming a session has the title forwarded through the gateway and the host answer returned unchanged', async () => {
    // Given a host that renames a session and answers the durable event it committed
    const harness = await adminConnection()
    harness.gateway.handler = async call => call.method === 'rename'
      ? { title: 'Plan the trip', seq: 41 }
      : { accepted: true }
    // When the phone renames that session
    await harness.connection.handleText(requestFrame(2, 'session.rename', { sessionId: 'session-source', title: 'Plan the trip' }))
    // Then the write crossed as `session/rename`'s single request argument, unrenamed
    expect(requestOf(harness, 'session', 'rename')).toEqual({ request: { sessionId: 'session-source', title: 'Plan the trip' } })
    // And the answer is the host's own body, both keys and nothing invented
    expect(answerOf(harness, 2).r).toEqual({ title: 'Plan the trip', seq: 41 })
  })

  it('operator whose host refuses a rename is told the host code and text unchanged', async () => {
    // Given a host that does not hold the named session
    const harness = await adminConnection()
    harness.gateway.handler = async () => {
      throw Object.assign(new Error('no session with that id is live or stored'), { code: 'session/not-found' })
    }
    // When the phone renames it
    await harness.connection.handleText(requestFrame(2, 'session.rename', { sessionId: 'session-gone', title: 'Plan the trip' }))
    // Then the refusal is the host's own, with nothing added and nothing renamed
    expect(answerOf(harness, 2)).toEqual({ ok: false, e: { code: 'session/not-found', msg: 'no session with that id is live or stored' } })
  })

  it('operator whose host fails without a code is still told the host text', async () => {
    // Given a rename that crashed carrying no code at all
    const harness = await adminConnection()
    harness.gateway.handler = async () => { throw new Error('the title writer crashed') }
    // When the phone renames a session
    await harness.connection.handleText(requestFrame(2, 'session.rename', { sessionId: 'session-source', title: 'Plan the trip' }))
    // Then the only code left is this bridge's own internal, and the host's text is the message
    expect(answerOf(harness, 2)).toEqual({ ok: false, e: { code: 'internal', msg: 'the title writer crashed' } })
  })

  it('operator sending a rename without a session or without a title is refused before the host is asked', async () => {
    // Given a host that would rename anything it was sent
    const harness = await adminConnection()
    // When the phone omits the session, omits the title, empties either, or sends a title that is not text
    await harness.connection.handleText(requestFrame(2, 'session.rename', { title: 'Plan the trip' }))
    await harness.connection.handleText(requestFrame(3, 'session.rename', { sessionId: 'session-source' }))
    await harness.connection.handleText(requestFrame(4, 'session.rename', { sessionId: '', title: 'Plan the trip' }))
    await harness.connection.handleText(requestFrame(5, 'session.rename', { sessionId: 'session-source', title: '' }))
    await harness.connection.handleText(requestFrame(6, 'session.rename', { sessionId: 'session-source', title: 41 }))
    // Then every one is refused as arguments, and no title was written
    for (const id of [2, 3, 4, 5, 6]) {
      expect(answerOf(harness, id)).toEqual({ ok: false, e: { code: 'invalid-args', msg: 'session.rename requires sessionId and title' } })
    }
    expect(harness.gateway.countOf('session', 'rename')).toBe(0)
  })
})

describe('session.pin, session.unpin and session.unarchive', () => {
  it('operator pinning a session has it forwarded one-to-one and is answered one decided ok', async () => {
    // Given a host whose pin endpoint answers the complete set it now holds
    const harness = await adminConnection()
    harness.gateway.handler = async call => call.method === 'pinSession'
      ? { pinnedSessionIds: ['session-source'] }
      : { accepted: true }
    // When the phone pins one session
    await harness.connection.handleText(requestFrame(2, 'session.pin', { sessionId: 'session-source' }))
    // Then the endpoint was asked with that session alone, and the answer is this
    // bridge's decided ok rather than the host's set — a client re-reads workspace.list
    expect(requestOf(harness, 'workspace', 'pinSession')).toEqual({ request: { sessionId: 'session-source' } })
    expect(answerOf(harness, 2).r).toEqual({ ok: true })
  })

  it('operator unpinning and unarchiving a session reaches the endpoint that owns each verb', async () => {
    // Given a host that answers every set mutation with its own set
    const harness = await adminConnection()
    harness.gateway.handler = async () => ({ pinnedSessionIds: [], archivedSessionIds: [] })
    // When the phone unpins one session and unarchives another
    await harness.connection.handleText(requestFrame(2, 'session.unpin', { sessionId: 'session-pinned' }))
    await harness.connection.handleText(requestFrame(3, 'session.unarchive', { sessionId: 'session-archived' }))
    // Then each verb reached its own endpoint and no other, one request key each
    expect(requestOf(harness, 'workspace', 'unpinSession')).toEqual({ request: { sessionId: 'session-pinned' } })
    expect(requestOf(harness, 'workspace', 'unarchiveSession')).toEqual({ request: { sessionId: 'session-archived' } })
    expect(harness.gateway.countOf('workspace', 'pinSession')).toBe(0)
    expect(answerOf(harness, 2).r).toEqual({ ok: true })
    expect(answerOf(harness, 3).r).toEqual({ ok: true })
  })

  it('operator whose host refuses a pin is told the host code and text unchanged', async () => {
    // Given a host that refuses to pin a session it has archived
    const harness = await adminConnection()
    harness.gateway.handler = async () => {
      throw Object.assign(new Error('a session in the archive set cannot be pinned'), { code: 'workspace/session-archived' })
    }
    // When the phone pins that session
    await harness.connection.handleText(requestFrame(2, 'session.pin', { sessionId: 'session-archived' }))
    // Then nothing was rewritten on the way out
    expect(answerOf(harness, 2)).toEqual({ ok: false, e: { code: 'workspace/session-archived', msg: 'a session in the archive set cannot be pinned' } })
  })

  it('operator sending a set mutation without a session id is refused before the host is asked', async () => {
    // Given a host that would mutate any set it was sent
    const harness = await adminConnection()
    // When the phone calls each verb with no session, or with an empty one
    const verbs = ['session.pin', 'session.unpin', 'session.unarchive']
    for (const [index, verb] of verbs.entries()) {
      await harness.connection.handleText(requestFrame(10 + index, verb, {}))
      await harness.connection.handleText(requestFrame(20 + index, verb, { sessionId: '' }))
    }
    // Then each is refused by name, and no endpoint was reached
    expect(answerOf(harness, 10)).toEqual({ ok: false, e: { code: 'invalid-args', msg: 'session.pin requires sessionId' } })
    expect(answerOf(harness, 11)).toEqual({ ok: false, e: { code: 'invalid-args', msg: 'session.unpin requires sessionId' } })
    expect(answerOf(harness, 12)).toEqual({ ok: false, e: { code: 'invalid-args', msg: 'session.unarchive requires sessionId' } })
    expect(answerOf(harness, 20).e?.code).toBe('invalid-args')
    expect(harness.gateway.invocations).toEqual([])
  })
})

describe('session.archive', () => {
  it('operator archiving a session without naming stopActivity leaves it off the host request entirely', async () => {
    // Given a host that archives a finished session
    const harness = await adminConnection()
    harness.gateway.handler = async () => ({ archivedSessionIds: ['session-source'] })
    // When the phone archives it
    await harness.connection.handleText(requestFrame(2, 'session.archive', { sessionId: 'session-source' }))
    // Then the request carries the session alone: whether running work stops is the host's question
    const args = requestOf(harness, 'workspace', 'archiveSession') as { request: Record<string, unknown> }
    expect(args).toEqual({ request: { sessionId: 'session-source' } })
    expect(Object.hasOwn(args.request, 'stopActivity')).toBe(false)
    expect(answerOf(harness, 2).r).toEqual({ ok: true })
  })

  it('operator who confirmed stopping the running work has stopActivity forwarded as decided', async () => {
    // Given a host that stops a running session's work only when it is asked to
    const harness = await adminConnection()
    harness.gateway.handler = async () => ({ archivedSessionIds: ['session-source'] })
    // When the phone archives it twice, once with the choice and once against it
    await harness.connection.handleText(requestFrame(2, 'session.archive', { sessionId: 'session-source', stopActivity: true }))
    await harness.connection.handleText(requestFrame(3, 'session.archive', { sessionId: 'session-other', stopActivity: false }))
    // Then the boolean crossed verbatim, not normalized to its presence
    expect(requestOf(harness, 'workspace', 'archiveSession')).toEqual({ request: { sessionId: 'session-other', stopActivity: false } })
    expect(harness.gateway.countOf('workspace', 'archiveSession')).toBe(2)
    expect(answerOf(harness, 2).r).toEqual({ ok: true })
    expect(answerOf(harness, 3).r).toEqual({ ok: true })
  })

  it('operator whose host refuses to archive a running session is told the host code and text unchanged', async () => {
    // Given a host that reports the running work it will not archive over
    const harness = await adminConnection()
    harness.gateway.handler = async () => {
      throw Object.assign(new Error('the session is still running a turn'), { code: 'workspace/session-active' })
    }
    // When the phone archives it without naming stopActivity
    await harness.connection.handleText(requestFrame(2, 'session.archive', { sessionId: 'session-running' }))
    // Then the refusal names the host's own condition, which is what a phone needs to offer the confirmation
    expect(answerOf(harness, 2)).toEqual({ ok: false, e: { code: 'workspace/session-active', msg: 'the session is still running a turn' } })
  })

  it('operator sending stopActivity that is not a boolean is refused before the host is asked', async () => {
    // Given a host that would archive anything it was sent
    const harness = await adminConnection()
    // When the phone sends a string, a number, null or an object in that slot
    const choices: unknown[] = ['true', 1, null, { stop: true }]
    for (const [index, stopActivity] of choices.entries()) {
      await harness.connection.handleText(requestFrame(10 + index, 'session.archive', { sessionId: 'session-source', stopActivity }))
    }
    // Then each is refused as arguments and nothing was archived
    for (const index of choices.keys()) {
      expect(answerOf(harness, 10 + index)).toEqual({ ok: false, e: { code: 'invalid-args', msg: 'session.archive stopActivity must be a boolean when present' } })
    }
    expect(harness.gateway.countOf('workspace', 'archiveSession')).toBe(0)
  })

  it('operator archiving without a session id is refused before the host is asked', async () => {
    // Given a host that would archive any session it was sent
    const harness = await adminConnection()
    // When the phone omits the session, or names one with no text in it
    await harness.connection.handleText(requestFrame(2, 'session.archive', { stopActivity: true }))
    await harness.connection.handleText(requestFrame(3, 'session.archive', { sessionId: '' }))
    // Then both are refused here, and the archive endpoint was never reached
    expect(answerOf(harness, 2)).toEqual({ ok: false, e: { code: 'invalid-args', msg: 'session.archive requires sessionId' } })
    expect(answerOf(harness, 3)).toEqual({ ok: false, e: { code: 'invalid-args', msg: 'session.archive requires sessionId' } })
    expect(harness.gateway.countOf('workspace', 'archiveSession')).toBe(0)
  })
})

describe('session.admin.v1', () => {
  it('operator who never declared the session-admin channel has all five methods refused as unknown and no write is forwarded', async () => {
    // Given a connection that declared nothing at all
    const harness = await adminConnection([])
    // When the phone calls each of the five methods anyway
    const calls: [string, Record<string, unknown>][] = [
      ['session.rename', { sessionId: 'session-source', title: 'Plan the trip' }],
      ['session.pin', { sessionId: 'session-source' }],
      ['session.unpin', { sessionId: 'session-source' }],
      ['session.archive', { sessionId: 'session-source' }],
      ['session.unarchive', { sessionId: 'session-source' }],
    ]
    for (const [index, [method, payload]] of calls.entries()) {
      await harness.connection.handleText(requestFrame(10 + index, method, payload))
    }
    // Then none of them exists for this client, exactly as before the channel
    for (const index of calls.keys()) {
      expect(answerOf(harness, 10 + index)).toEqual({ ok: false, e: { code: 'unknown-method', msg: `unknown method ${calls[index]?.[0]}` } })
    }
    // And the host was asked nothing on its behalf
    expect(harness.gateway.invocations).toEqual([])
  })

  it('operator who declared only the workspace half is still told the five writes are unknown', async () => {
    // Given a connection that declared the reading half alone
    const harness = await adminConnection([CAP_WORKSPACE])
    // When the phone pins a session
    await harness.connection.handleText(requestFrame(2, 'session.pin', { sessionId: 'session-source' }))
    // Then reading is not writing: the pin was never forwarded
    expect(answerOf(harness, 2).e?.code).toBe('unknown-method')
    expect(harness.gateway.invocations).toEqual([])
  })

  it('operator who is not paired is refused before any write reaches the host', async () => {
    // Given a connection that declared the channel but presented no device token
    const harness = await adminConnection([CAP_SESSION_ADMIN], false)
    // When the phone pins a session
    await harness.connection.handleText(requestFrame(2, 'session.pin', { sessionId: 'session-source' }))
    // Then pairing comes first, and the host was asked nothing
    expect(answerOf(harness, 2)).toEqual({ ok: false, e: { code: 'unpaired', msg: 'this connection is not paired' } })
    expect(harness.gateway.invocations).toEqual([])
  })
})
