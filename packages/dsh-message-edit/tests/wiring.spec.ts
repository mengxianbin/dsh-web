import { describe, expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSubmitMessageEdit, type SubmitMessageEditInput } from '../src/client/wiring.ts'

const source = 'session-source' as SessionId
const child = 'session-child' as SessionId

function input(overrides: Partial<SubmitMessageEditInput> = {}): SubmitMessageEditInput {
  return { sessionId: source, forkAtSeq: 7, editedText: 'edited text', ...overrides }
}

function bench() {
  const calls: string[] = []
  const prompt = vi.fn(async () => {
    calls.push('prompt')
    return { ok: true as const, value: { accepted: true as const } }
  })
  const reference = {
    get ready() {
      calls.push('ready')
      return Promise.resolve({ session: { prompt } })
    },
    binding: { session: { prompt } },
  }
  const fork = vi.fn(async () => {
    calls.push('fork')
    return child
  })
  const using = vi.fn(async (_id: SessionId, _options: unknown, operation: (reference: unknown) => unknown) => {
    calls.push('using')
    return operation(reference)
  })
  const openSession = vi.fn(() => { calls.push('open') })
  const sessions = { fork, using } as unknown as ISessions
  return { calls, prompt, reference, fork, using, openSession, sessions }
}

describe('createSubmitMessageEdit', () => {
  it('user resends through fork, retain, ready, open, and one verbatim prompt', async () => {
    // Given a healthy controller and text whose surrounding whitespace matters
    const b = bench()
    const submit = createSubmitMessageEdit(b.sessions, b.openSession)
    // When the edited submission settles
    const result = await submit(input({ editedText: '  edited\n text  ' }))
    // Then the child is returned and every side effect occurs once in order
    expect(result).toBe(child)
    expect(b.fork).toHaveBeenCalledExactlyOnceWith({ sessionId: source, atSeq: 7, increaseTitle: true })
    expect(b.using).toHaveBeenCalledExactlyOnceWith(child, { source: 'messageEdit' }, expect.any(Function))
    expect(b.openSession).toHaveBeenCalledExactlyOnceWith(child)
    expect(b.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: '  edited\n text  ' }], 'queue')
    expect(b.calls).toEqual(['fork', 'using', 'ready', 'open', 'prompt'])
  })

  it('user stays on the source without a prompt when fork fails', async () => {
    // Given a Host that refuses the fork
    const b = bench()
    b.fork.mockRejectedValue(new Error('session/fork-unavailable'))
    const submit = createSubmitMessageEdit(b.sessions, b.openSession)
    // When the user attempts to resend
    const attempt = submit(input())
    // Then the refusal is visible and no later side effect is attempted
    await expect(attempt).rejects.toThrow('session/fork-unavailable')
    expect(b.using).not.toHaveBeenCalled()
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.prompt).not.toHaveBeenCalled()
  })

  it('user does not navigate or prompt when the child cannot become ready', async () => {
    // Given a created child whose initial open fails
    const b = bench()
    Object.defineProperty(b.reference, 'ready', { get: () => Promise.reject(new Error('open failed')) })
    const submit = createSubmitMessageEdit(b.sessions, b.openSession)
    // When readiness settles unsuccessfully
    const attempt = submit(input())
    // Then navigation and prompt are both withheld
    await expect(attempt).rejects.toThrow('open failed')
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.prompt).not.toHaveBeenCalled()
  })

  it('user sees a prompt refusal after the child opens', async () => {
    // Given a ready child whose prompt is rejected
    const b = bench()
    b.prompt.mockResolvedValue({ ok: false, error: { code: 'session/busy', message: 'still running' } } as never)
    const submit = createSubmitMessageEdit(b.sessions, b.openSession)
    // When the edited prompt is submitted
    const attempt = submit(input())
    // Then the Host reason survives and no duplicate prompt is sent
    await expect(attempt).rejects.toThrow('session/busy: still running')
    expect(b.openSession).toHaveBeenCalledExactlyOnceWith(child)
    expect(b.prompt).toHaveBeenCalledTimes(1)
  })

  it('user does not prompt when navigation fails', async () => {
    // Given navigation that throws after the child is ready
    const b = bench()
    b.openSession.mockImplementation(() => { throw new Error('navigation failed') })
    const submit = createSubmitMessageEdit(b.sessions, b.openSession)
    // When the navigation failure settles
    const attempt = submit(input())
    // Then no prompt is sent into an unopened branch
    await expect(attempt).rejects.toThrow('navigation failed')
    expect(b.prompt).not.toHaveBeenCalled()
  })

  it('user cannot fork blank text or an invalid boundary', async () => {
    // Given blank text and two invalid event boundaries
    const b = bench()
    const submit = createSubmitMessageEdit(b.sessions, b.openSession)
    // When all three submissions are rejected
    const blank = submit(input({ editedText: ' \n' }))
    const negative = submit(input({ forkAtSeq: -1 }))
    const fractional = submit(input({ forkAtSeq: 1.5 }))
    // Then validation fails before any fork is requested
    await expect(blank).rejects.toThrow('edited message must not be empty')
    await expect(negative).rejects.toThrow('edit boundary must be a non-negative safe integer')
    await expect(fractional).rejects.toThrow('edit boundary must be a non-negative safe integer')
    expect(b.fork).not.toHaveBeenCalled()
  })
})
