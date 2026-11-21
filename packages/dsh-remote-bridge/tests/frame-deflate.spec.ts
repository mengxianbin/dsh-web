/**
 * `frame.deflate.v1`: the capability name, the declaration that reaches the
 * carrier, and the size the decision is worth on the two answers that motivated
 * it — a full roster and a session's opening window.
 *
 * The carrier's own wire form is proved in `websocket.spec.ts`; this suite pins
 * the capability surface and the measured ratio, so a change that quietly stops
 * compressing shows up as a number instead of a slowly loading phone.
 * @module tests/frame-deflate.spec
 */

import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodeFrame, outboundPayloadOf, responseFrame } from '../src/core/envelope.ts'
import { CAP_FRAME_DEFLATE, SERVED_CAPABILITIES } from '../src/core/protocol.ts'
import { answerOf, makeConnection, requestFrame } from './support/harness.ts'

/** Titles a real roster carries, one per session in the fixture. */
const TITLES = [
  'Fix the websocket carrier',
  'Measure the relay round trip',
  'Page a session history to its oldest entry',
  'Review the approval replay',
  'Trim the snapshot baseline',
  'Add the background-job channel',
  'Pair a phone over the loopback token',
  'Note the delta protocol decision',
  'Why is the phone screen eleven seconds behind the host',
  'Compress the frames the relay carries',
  'Retry the tunnel after the laptop wakes',
  'Read the worker log for the upgrade refusal',
  'Count the bytes one listing costs',
  'Decide whether the client may offer permessage-deflate',
  'Keep the frozen envelope shape',
  'Record the decision in the owning note',
]

/** One roster row as `session.list` publishes it. */
function rosterRow(index: number): Record<string, unknown> {
  const child = index % 5 === 4
  return {
    id: `session-${index.toString().padStart(4, '0')}-4f2a`,
    title: `${TITLES[index % TITLES.length] ?? 'Untitled'} (${index})`,
    updatedAt: 1_735_689_600_000 + index * 60_000,
    agentRunning: index % 3 === 0,
    cwd: `/Users/zcl/code/iphone_remote_use_dsh/packages/dsh-remote-bridge/scripts/probe-${index % 7}`,
    ...(child ? { parentSessionId: `session-${(index - 1).toString().padStart(4, '0')}-4f2a`, origin: 'subagent' as const } : {}),
    blank: index % 11 === 0,
    archived: false,
  }
}

/** One `session.list` answer body, at the width a working roster reaches. */
function sessionListText(): string {
  return encodeFrame(responseFrame(4, {
    mode: 'reset',
    token: '',
    sessions: Array.from({ length: 80 }, (_, index) => rosterRow(index)),
  }))
}

/** One turn's entries, as an opening window carries them. */
function turnEntries(turn: number): readonly unknown[] {
  return [
    {
      seq: turn * 10 + 1,
      time: 1_735_689_600_000 + turn * 1_000,
      kind: 'user/message',
      source: { kind: 'user' },
      content: [{ type: 'text', text: `Open the bridge and check the ${TITLES[turn % TITLES.length] ?? 'unknown'} path on the phone over the relay, not over loopback. This is turn ${turn} of the window, and its answer is already on disk.` }],
    },
    {
      seq: turn * 10 + 2,
      time: 1_735_689_600_000 + turn * 1_000 + 40,
      kind: 'assistant/message',
      content: [{
        type: 'text',
        text: `The frame is one JSON object measured against the same 10 MiB cap in both directions, so step ${turn} decides where the bytes are spent before any of them are written: a listing of eighty sessions and an opening window of twenty turns are the two answers a phone pays for first.`,
      }],
    },
    {
      seq: turn * 10 + 3,
      time: 1_735_689_600_000 + turn * 1_000 + 80,
      kind: 'tool/call',
      callId: `call_${turn}`,
      name: 'read',
      args: { file_path: `/Users/zcl/code/.worktrees/dsh-web/netperf-frame-compression/packages/dsh-remote-bridge/src/host/${turn % 2 === 0 ? 'websocket.ts' : 'routes.ts'}`, offset: turn * 20, limit: 80 },
    },
    {
      seq: turn * 10 + 4,
      time: 1_735_689_600_000 + turn * 1_000 + 120,
      kind: 'tool/result',
      callId: `call_${turn}`,
      ok: true,
      content: [{ type: 'text', text: `${(turn * 37).toString(16)} export function serveUpgrade(handoff: UpgradeHandoff): WebSocketCarrier {`.repeat(3) }],
    },
    {
      seq: turn * 10 + 5,
      time: 1_735_689_600_000 + turn * 1_000 + 160,
      kind: 'system/message',
      content: [{ type: 'text', text: `request/header bookkeeping the trim capability would drop (turn ${turn})` }],
    },
  ]
}

/** One `session.snapshot` answer body, at the width an opening window reaches. */
function sessionSnapshotText(): string {
  return encodeFrame(responseFrame(7, {
    turns: Array.from({ length: 20 }, (_, index) => ({
      seq: index * 10 + 1,
      endSeq: index * 10 + 5,
      reason: 'stop',
      time: 1_735_689_600_000 + index * 1_000,
      entries: turnEntries(index),
    })),
    lastSeq: 125,
  }))
}

/** The size of one frame's text and the bytes it crosses as once compressed. */
function compressionOf(text: string): { readonly original: number; readonly deflated: Buffer } {
  const payload = outboundPayloadOf(text, true)
  if (!payload.binary) throw new Error('the fixture should compress')
  return { original: Buffer.byteLength(text, 'utf8'), deflated: payload.deflated }
}

describe('frame.deflate.v1', () => {
  it('operator reads the capability this bridge serves under its frozen wire name', () => {
    // Given the capability list this bridge advertises
    // When its frame-compression entry is read
    // Then it is served, under the name every client matches against
    expect(CAP_FRAME_DEFLATE).toBe('frame.deflate.v1')
    expect(SERVED_CAPABILITIES).toContain(CAP_FRAME_DEFLATE)
  })

  it('user greets the bridge declaring the capability and the carrier is told the peer can inflate', async () => {
    // Given a connection over a recording carrier
    const harness = makeConnection()
    expect(harness.transport.deflate).toBeUndefined()
    // When the greeting declares frame.deflate.v1
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: [CAP_FRAME_DEFLATE] }))
    // Then the carrier may compress, and the handshake advertises the capability back
    expect(harness.transport.deflate).toBe(true)
    expect((answerOf(harness, 1).r as { capabilities: string[] }).capabilities).toContain(CAP_FRAME_DEFLATE)
  })

  it('user greets the bridge without the capability and the carrier keeps writing text', async () => {
    // Given a connection over a recording carrier
    const harness = makeConnection()
    // When the greeting declares unrelated capabilities only
    await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: ['delta.v1', 'jobs.v1'] }))
    // Then the carrier is told, explicitly, that this peer cannot inflate
    expect(harness.transport.deflate).toBe(false)
  })

  it('operator measures the roster answer and the opening window before and after deflate', () => {
    // Given a realistic session.list answer and a realistic session.snapshot answer
    const fixtures = [sessionListText(), sessionSnapshotText()]
    // When both are compressed the way the carrier compresses them
    // Then each inflates back into its own frame, and each shrinks by more than half
    for (const text of fixtures) {
      const { original, deflated } = compressionOf(text)
      expect(original).toBeGreaterThan(1024)
      expect(deflated.length).toBeLessThan(original / 2)
      expect(inflateRawSync(deflated).toString('utf8')).toBe(text)
    }
  })
})
