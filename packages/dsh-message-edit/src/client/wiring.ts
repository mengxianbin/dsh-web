/** Runtime orchestration for edit-and-resend, kept separate from the view. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Durable facts needed for one edited submission. */
export interface SubmitMessageEditInput {
  readonly sessionId: SessionId
  /** Inclusive source event boundary immediately before the edited message. */
  readonly forkAtSeq: number
  readonly editedText: string
}

/** Open a child Session in the main Workspace view. */
export type OpenSession = (sessionId: SessionId) => void

/**
 * Build the edit submission verb. The source Session is never mutated. A
 * successful fork is retained and opened before prompting so the child is
 * ready and the user lands on the branch whose prompt was accepted. Every
 * temporary reference is released by `sessions.using`, including failures.
 * @param sessions - official Client Session Controller face.
 * @param openSession - official Workspace navigation verb.
 * @returns the submitted child id after the edited prompt is accepted.
 */
export function createSubmitMessageEdit(sessions: ISessions, openSession: OpenSession) {
  return async (input: SubmitMessageEditInput): Promise<SessionId> => {
    if (!Number.isSafeInteger(input.forkAtSeq) || input.forkAtSeq < 0) {
      throw new Error('edit boundary must be a non-negative safe integer')
    }
    if (input.editedText.trim() === '') throw new Error('edited message must not be empty')
    const childId = await sessions.fork({
      sessionId: input.sessionId,
      atSeq: input.forkAtSeq,
      increaseTitle: true,
    })
    await sessions.using(childId, { source: 'messageEdit' }, async (reference) => {
      await reference.ready
      openSession(childId)
      const result = await reference.binding.session.prompt([{ type: 'text', text: input.editedText }], 'queue')
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    })
    return childId
  }
}
