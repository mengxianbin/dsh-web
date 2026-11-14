import { describe, expect, it } from 'vitest'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { messageEditTarget, userMessageText } from '../src/core/transcript.ts'

function node(kind: string, seq: number, turn: number, content: readonly unknown[] = []) {
  return {
    kind,
    anchorSeq: seq,
    location: { kind: 'step', turn: { turn } },
    data: { seq, content },
  }
}

function snapshot(nodes: readonly unknown[]): ChatSnapshot {
  return { nodes: { values: () => nodes } } as never
}

const text = (value: string) => ({ type: 'text', text: value } as const)

describe('userMessageText', () => {
  it('user message text joins every text block verbatim', () => {
    // Given adjacent text blocks from one durable user message
    const content = [text('hello'), text(' world')]
    // When the editable text is extracted
    const extracted = userMessageText(content)
    // Then no whitespace or block boundary is invented
    expect(extracted).toBe('hello world')
  })

  it('user message text rejects attachments and blank messages instead of losing content', () => {
    // Given an attachment-bearing message and blank content
    const mixed = [text('look'), { type: 'image', attachment: {} } as never]
    // When eligibility is evaluated
    const results = [userMessageText(mixed), userMessageText([]), userMessageText([text('  \n')])]
    // Then every unsafe or empty candidate is refused
    expect(results).toEqual([null, null, null])
  })
})

describe('messageEditTarget', () => {
  it('user selects an arbitrary historical Turn and cuts immediately before its user event', () => {
    // Given two settled Turns with distinct user event seqs
    const snap = snapshot([
      node('user', 2, 1, [text('first')]),
      node('assistant', 4, 1),
      node('user', 8, 2, [text('second')]),
      node('assistant', 10, 2),
    ])
    // When each Turn tail resolves its edit target
    const first = messageEditTarget(snap, 1)
    const second = messageEditTarget(snap, 2)
    // Then each target carries the exact preceding inclusive boundary
    expect(first).toEqual({ text: 'first', seq: 2, forkAtSeq: 1 })
    expect(second).toEqual({ text: 'second', seq: 8, forkAtSeq: 7 })
  })

  it('user edits the first message through event zero without a blank-session fallback', () => {
    // Given the first durable user message immediately after event zero
    const snap = snapshot([node('user', 1, 1, [text('first')])])
    // When its edit target is resolved
    const target = messageEditTarget(snap, 1)
    // Then the existing first event is the fork anchor
    expect(target).toEqual({ text: 'first', seq: 1, forkAtSeq: 0 })
  })

  it('user cannot target steering, context, or another Turn location', () => {
    // Given no ordinary user message in Turn one
    const snap = snapshot([
      node('steering', 3, 1, [text('steer')]),
      node('context', 4, 1, [text('context')]),
      node('user', 8, 2, [text('other')]),
    ])
    // When Turn one resolves its target
    const target = messageEditTarget(snap, 1)
    // Then unrelated node kinds and the other Turn are excluded
    expect(target).toBeNull()
  })

  it('user cannot edit mixed content or an invalid event boundary', () => {
    // Given attachment, zero-seq, fractional-seq, and empty candidates
    const attachment = snapshot([node('user', 2, 1, [{ type: 'file', file: {} }])])
    const zero = snapshot([node('user', 0, 1, [text('zero')])])
    const fractional = snapshot([node('user', 1.5, 1, [text('fraction')])])
    // When all four candidates are evaluated
    const results = [
      messageEditTarget(attachment, 1),
      messageEditTarget(zero, 1),
      messageEditTarget(fractional, 1),
      messageEditTarget(snapshot([]), 1),
    ]
    // Then none can produce an unsafe fork request
    expect(results).toEqual([null, null, null, null])
  })
})
