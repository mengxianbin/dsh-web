/**
 * Pure transcript selection for edit-and-resend. The Chat location index owns
 * Turn membership; this module only selects an ordinary user message and
 * derives the exact inclusive event boundary before it.
 */
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { UserMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** One text-only user message and the prefix boundary used to branch it. */
export interface MessageEditTarget {
  /** Verbatim concatenation of the original text blocks. */
  readonly text: string
  /** Durable source event seq of the user message. */
  readonly seq: number
  /** Inclusive seq of the real event immediately before the user message. */
  readonly forkAtSeq: number
}

/**
 * Extract text only when every content block can be replayed verbatim.
 * Attachments are excluded rather than silently dropped from the new prompt.
 * @param content - durable user-message content blocks.
 * @returns the original text, or null for empty or non-text-only content.
 */
export function userMessageText(content: UserMessageNode['content']): string | null {
  if (content.length === 0) return null
  let text = ''
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') return null
    text += block.text
  }
  return text.trim() === '' ? null : text
}

/**
 * Select the ordinary turn-opening user message for one Turn tail.
 * Steering and injected context have different Chat node kinds and never
 * match. A zero or negative message seq has no real preceding event and is
 * rejected instead of sending an invalid fork boundary.
 * @param snapshot - current Chat projection.
 * @param turn - owning Turn number from the tail location.
 * @returns the editable target, or null when this Turn has none.
 */
export function messageEditTarget(snapshot: ChatSnapshot, turn: number): MessageEditTarget | null {
  for (const node of snapshot.nodes.values()) {
    if (node.kind !== 'user') continue
    const location = node.location
    if ((location.kind !== 'turn' && location.kind !== 'step') || location.turn.turn !== turn) continue
    // The published ChatNodeStore keeps `data` at its extensible base type;
    // the keyed kind check above is the narrowing witness for this read.
    const data = node.data as UserMessageNode
    const text = userMessageText(data.content)
    const seq = data.seq
    if (text === null || !Number.isSafeInteger(seq) || seq <= 0) return null
    return { text, seq, forkAtSeq: seq - 1 }
  }
  return null
}
