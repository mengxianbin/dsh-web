/**
 * The rendered view carries no terminal escapes.
 *
 * WHY THIS IS A CONTRACT AND NOT COSMETICS. On Windows the colour libraries a
 * build tool uses short-circuit the "no TTY means no colour" rule on the
 * platform itself (\`picocolors\` and \`tinyrainbow\` both carry
 * \`platform === 'win32' ||\` as a disjunct), so a piped vitest or pnpm run still
 * emits SGR sequences, and \`TERM=dumb\` — which ./shell.ts already sets — does
 * not turn them off. This tool pipes bytes through on purpose; the step that
 * used to fail was rendering those bytes as text, which showed the caller
 * \`\u001b[33m\` instead of the message it decorates.
 *
 * The bytes themselves stay in ./shell.ts: that layer is the honest stream, and
 * the spill files it writes keep the exact bytes, because ANSI colour IS
 * diagnostic there.
 */
import { describe, expect, it } from 'vitest'
import { renderResult, stripTerminalEscapes } from '../src/tool.ts'

/** An SGR-wrapped line, in the shape vitest and pnpm actually emit on win32. */
const COLOURED = '\u001b[1m\u001b[32m RUN \u001b[39m\u001b[22m tests/protocol.spec.ts \u001b[2m(14 tests)\u001b[22m'

describe('the rendered view of a result', () => {
  it('user reading a coloured result sees the message without the escape sequences', () => {
    // Given a stream whose producer coloured its piped output anyway,
    // When the tool renders that result,
    const text = renderResult({ stdout: COLOURED, stderr: '', exitCode: 0 })
    // Then no escape sequence reaches the caller, and the text is intact.
    expect(text.includes('\u001b')).toBe(false)
    expect(text).toBe(' RUN  tests/protocol.spec.ts (14 tests)')
  })

  it('user reading a red stderr sees the error message, since the colouring there is the same accident', () => {
    // Given a failing command whose stderr was coloured by its producer,
    const result = { stdout: '', stderr: '\u001b[31mError: 3 tests failed\u001b[39m', exitCode: 1 }
    // When the tool renders that result,
    const text = renderResult(result)
    // Then the failure is readable and the exit status still says what happened.
    expect(text.includes('\u001b')).toBe(false)
    expect(text).toContain('Error: 3 tests failed')
    expect(text).toContain('[exit code: 1]')
  })

  it('user reading a result with colons and parameters keeps them as text, because they are a colon-separated list', () => {
    // Given a stream containing text that merely looks like an escape introducer,
    const list = 'PATH entries: a/b:c/d\nnext line'
    // When the tool renders that result,
    const text = renderResult({ stdout: list, stderr: '', exitCode: 0 })
    // Then nothing that was ordinary text is eaten.
    expect(text).toBe(list)
  })

  it('user reading a zero-exit result whose stream carried only colour sees the real words and no truncation claim', () => {
    // Given a fully coloured but complete stream,
    const result = { stdout: COLOURED, stderr: '', exitCode: 0 }
    // When the tool renders it,
    const text = renderResult(result)
    // Then the render adds no notice of its own.
    expect(text).not.toContain('was truncated')
    expect(text).not.toContain('exit code')
  })
})

describe('the stripping helper', () => {
  it('operator whose command uses OSC semantic-prompt marks does not see the embedded JSON in the text', () => {
    // Given a stream carrying an OSC tag, which ends with BEL or ST,
    const marked = 'a\u001b]133;D;0\u0007b\u001b]133;A\u001b\\c'
    // When the sequence is stripped,
    // Then the JSON payload goes with the sequence, and the text between survives.
    expect(stripTerminalEscapes(marked)).toBe('abc')
  })

  it('operator whose command repaints one line with carriage returns reads the final frame only', () => {
    // Given a progress renderer that overwrote its own line in place,
    const repainted = 'building 10%\rbuilding 60%\rbuilding 100%\n'
    // When the sequence is stripped,
    // Then the surviving text is the last frame, not every frame glued together.
    expect(stripTerminalEscapes(repainted)).toBe('building 100%\n')
  })

  it('operator whose output has no escapes at all gets the identical string back, not a rewritten one', () => {
    // Given plain text, including CRLF line endings a Windows command emits,
    const plain = 'line one\r\nline two'
    // When the sequence is stripped,
    // Then the value is returned unchanged rather than normalized behind the caller.
    expect(stripTerminalEscapes(plain)).toBe(plain)
  })
})
