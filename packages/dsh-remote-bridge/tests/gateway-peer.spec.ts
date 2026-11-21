import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { createOwnerPeer } from '../src/core/owner-peer.ts'
import { ControllableStream, answerOf, makeConnection, requestFrame } from './support/harness.ts'

/** A real P-256 key pair, in the SPKI form a client would send. */
function p256(): { spki: string; key: KeyObject } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    spki: Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).toString('base64url'),
    key: pair.privateKey,
  }
}

/** One real ES256 signature over the given bytes. */
function es256(key: KeyObject, message: Buffer): string {
  return Buffer.from(cryptoSign('sha256', message, { key, dsaEncoding: 'ieee-p1363' })).toString('base64url')
}

async function rosterFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-bridge-peer-'))
  return join(directory, 'remote-bridge', 'devices.json')
}

describe('gateway calls and the in-process owner peer', () => {
  it('user on a paired connection invokes the host speaking for the bridge owner peer', async () => {
    // Given a paired connection
    const harness = makeConnection({ paired: true })
    harness.gateway.handler = async () => ({ items: [] })
    // When the user lists sessions
    await harness.connection.handleText(requestFrame(1, 'session.list'))
    // Then the call spoke for the very peer the bridge minted for itself:
    // the owner principal, no forwarded-event interactions, and no identity
    // a client frame could have set
    expect(answerOf(harness, 1).r).toEqual({ mode: 'reset', token: '', sessions: [] })
    const call = harness.gateway.invocations[0]
    expect(call?.peer).toBe(harness.ownerPeer)
    expect(call?.peer.principal).toEqual({ kind: 'owner' })
    expect(call?.peer.interactions).toBe('none')
    expect(String(call?.peer.id)).toMatch(/^remote-bridge-owner:/)
  })

  it('user on a paired connection opens the follow stream for the same peer and its own signal still crosses', async () => {
    // Given a paired connection and a follow stream the test drives
    const harness = makeConnection({ paired: true })
    const follow = new ControllableStream()
    harness.gateway.follow = call => follow.attach(call.signal).iterable()
    // When the user opens a session
    const pending = harness.connection.handleText(requestFrame(2, 'session.snapshot', { sessionId: 's-1' }))
    follow.push({ type: 'snapshot', header: {}, cursor: 7, hasMore: false, projections: {}, records: [] })
    await pending
    // Then the stream speaks for the same owner peer, and the subscription's
    // own abort signal still crosses alongside it, untouched by the peer work
    expect(answerOf(harness, 2).r).toEqual({ turns: [], lastSeq: 7 })
    const call = harness.gateway.streamRequests[0]
    expect(call?.peer).toBe(harness.ownerPeer)
    expect(call?.peer.principal).toEqual({ kind: 'owner' })
    expect(call?.peer.interactions).toBe('none')
    expect(call?.signal).toBeInstanceOf(AbortSignal)
    expect(call?.signal).not.toBe(harness.ownerPeer.signal)
  })

  it('user on a connection that pairs mid-session reaches the host only after the pairing gate', async () => {
    // Given an unpaired connection that completes the real pairing handshake
    const harness = makeConnection({ rosterFile: await rosterFile() })
    const key = p256()
    await harness.connection.handleText(requestFrame(3, 'pair.begin', { token: harness.pairing.issueToken().value }))
    const nonce = (answerOf(harness, 3).r as { nonce: string }).nonce
    await harness.connection.handleText(requestFrame(4, 'pair.finish', { devicePubKey: key.spki, signature: es256(key.key, Buffer.from(nonce, 'base64url')) }))
    expect(answerOf(harness, 4).ok).toBe(true)
    // Then the whole handshake touched the harness never: the owner peer
    // crossed nowhere before the gate closed behind pairing
    expect(harness.gateway.invocations).toEqual([])
    expect(harness.gateway.streamRequests).toEqual([])
    harness.gateway.handler = async () => ({ items: [] })
    // When the now-paired user lists sessions
    await harness.connection.handleText(requestFrame(5, 'session.list'))
    // Then the first gateway call of this connection speaks for the owner peer
    expect(answerOf(harness, 5).r).toEqual({ mode: 'reset', token: '', sessions: [] })
    expect(harness.gateway.invocations).toHaveLength(1)
    expect(harness.gateway.invocations[0]?.peer).toBe(harness.ownerPeer)
  })

  it('guest on an unpaired connection is refused by the bridge itself and no peer crosses', async () => {
    // Given a connection with no device token
    const harness = makeConnection()
    // When it reaches for the session surface, unary and streamed alike
    await harness.connection.handleText(requestFrame(6, 'session.list'))
    await harness.connection.handleText(requestFrame(7, 'session.snapshot', { sessionId: 's-1' }))
    // Then the bridge itself refused both before any gateway call existed, so
    // the owner peer was never exercised for this connection
    expect(answerOf(harness, 6).e?.code).toBe('unpaired')
    expect(answerOf(harness, 7).e?.code).toBe('unpaired')
    expect(harness.gateway.invocations).toEqual([])
    expect(harness.gateway.streamRequests).toEqual([])
  })

  it('user naming a principal in its payload does not change whom the call speaks for', async () => {
    // Given a paired connection
    const harness = makeConnection({ paired: true })
    harness.gateway.handler = async () => ({ items: [] })
    // When the user smuggles an identity into the payload
    await harness.connection.handleText(requestFrame(8, 'session.list', { principal: { kind: 'owner' }, peer: { id: 'forged' } }))
    // Then the call still speaks for the bridge's own peer and the payload field is dead
    expect(answerOf(harness, 8).r).toEqual({ mode: 'reset', token: '', sessions: [] })
    expect(harness.gateway.invocations[0]?.peer).toBe(harness.ownerPeer)
    expect(harness.gateway.invocations[0]?.peer.principal).toEqual({ kind: 'owner' })
  })

  it('user sending a principal inside a prompt leaves the wire args untouched', async () => {
    // Given a paired connection
    const harness = makeConnection({ paired: true })
    // When the user prompts with an identity field riding along
    await harness.connection.handleText(requestFrame(9, 'session.prompt', { sessionId: 's-1', text: 'hi', requestId: 'r-1', principal: { kind: 'owner' } }))
    // Then the prompt was sent speaking for the owner peer, and the args carry
    // exactly the wire layout — no client-named identity anywhere
    expect(answerOf(harness, 9).r).toEqual({ accepted: true })
    const call = harness.gateway.invocations[0]
    expect(call?.peer).toBe(harness.ownerPeer)
    expect(call?.args).toEqual({
      request: {
        requestId: 'r-1',
        sessionId: 's-1',
        mode: 'queue',
        content: [{ type: 'text', text: 'hi' }],
        clientTimeZone: 'Asia/Shanghai',
      },
    })
  })

  it('operator sees the owner peer abort its signal on dispose and racing disposals share one completion', async () => {
    // Given a freshly minted owner peer bound to a plugin context
    const peer = createOwnerPeer(new Context())
    expect(peer.signal.aborted).toBe(false)
    // When disposal races itself
    const first = peer.dispose()
    const second = peer.dispose()
    // Then both calls share one completion and the signal is aborted once
    expect(second).toBe(first)
    expect(peer.signal.aborted).toBe(true)
    await expect(first).resolves.toBeUndefined()
  })
})
