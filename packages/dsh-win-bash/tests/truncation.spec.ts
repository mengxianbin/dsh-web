/**
 * Truncation visibility: a model that receives a cut result must be able to
 * see that it was cut, in the text it actually reads.
 *
 * The byte-level truncation itself is ./shell.ts's job and is asserted there.
 * What this suite certifies is the step that used to LOSE that fact: the
 * tool's declared output and its model-facing rendering. A result whose head
 * was dropped is otherwise indistinguishable from a complete short one, and a
 * model reading a truncated listing draws conclusions from data it never saw.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ShellRegistry, ShellResult } from '../src/shell.ts'
import { buildWinBashTool, renderResult } from '../src/tool.ts'
import { resolveConfig } from '../src/config.ts'

/** A settled result as ./shell.ts produces it, with every fact set explicitly. */
function shellResult(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    stdout: 'tail-only-output',
    stderr: '',
    exitCode: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutLostHead: false,
    stderrLostHead: false,
    frameOverflow: false,
    ...overrides,
  }
}

/** The structural context the tool reads: a policy, no sandbox, no jobs. */
function context(policy: Partial<SandboxExecutionPolicy> = {}): Context {
  const resolved = { mode: 'danger-full-access', workspaceRoot: process.cwd(), ...policy }
  return {
    get: (name: string) => (name === 'sandboxPolicy' ? { resolve: () => resolved } : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Context
}

/** A shell registry stand-in that answers with one prepared result. */
function shellsReturning(result: ShellResult): ShellRegistry {
  return { run: async () => result } as unknown as ShellRegistry
}

/** One execution identity, as much of it as the tool reads. */
const EXEC = () => ({
  agent: { id: 'session-1', session: { header: { cwd: process.cwd() } } },
  signal: undefined,
})

/** The model-facing text the tool renders for one settled result. */
async function renderedToolText(result: ShellResult): Promise<string> {
  const tool = buildWinBashTool(
    context(),
    resolveConfig(undefined),
    { bash: 'C:/payload/bash.exe', bin: 'C:/payload/usr/bin' },
    shellsReturning(result),
  )
  const value = await tool.execute({ command: 'echo hi' }, EXEC() as never)
  const blocks = tool.output.render({ command: 'echo hi' }, value as never)
  return blocks.map(block => (block as { text: string }).text).join('')
}

describe('the truncation notice', () => {
  it('user reading a result whose front was dropped sees the cut stated in the text', async () => {
    // Given a command whose visible stdout is the tail of a much larger stream,
    const result = shellResult({ stdout: 'L077920 last line\n', stdoutTruncated: true, stdoutLostHead: true })
    // When the tool renders that result for the model,
    const text = await renderedToolText(result)
    // Then the text says the output was cut, how much is shown, and that the
    // beginning is the part that is missing.
    expect(text).toContain('[win_bash: stdout was truncated')
    expect(text).toContain('only the last 18 bytes are shown')
    expect(text).toContain('the beginning was dropped')
  })

  it('user reading a complete result sees no truncation notice at all', async () => {
    // Given a result that fits its budget,
    const result = shellResult()
    // When the tool renders it,
    const text = await renderedToolText(result)
    // Then nothing claims the output was cut.
    expect(text).toBe('tail-only-output')
    expect(text).not.toContain('was truncated')
  })

  it('user reading a cut stderr stream sees the notice name stderr, not stdout', async () => {
    // Given a result whose stderr alone hit its budget,
    const result = shellResult({ stderr: 'err-tail', stderrTruncated: true, stderrLostHead: true })
    // When the tool renders it,
    const text = await renderedToolText(result)
    // Then the notice names the stream that was actually cut.
    expect(text).toContain('[win_bash: stderr was truncated')
    expect(text).not.toContain('stdout was truncated')
  })

  it('user reading a spill-carrying result is told the path holding the complete stream', async () => {
    // Given a truncated result whose provider spilled the complete stream,
    const result = shellResult({
      stdout: 'tail',
      stdoutTruncated: true,
      stdoutLostHead: true,
      stdoutSpillPath: 'C:/temp/spill-stdout.txt',
    })
    // When the tool renders it,
    const text = await renderedToolText(result)
    // Then the complete stream is named, so the model can recover the rest.
    expect(text).toContain('C:/temp/spill-stdout.txt')
  })

  it('user reading a frame-overflow result is told a middle window was dropped', () => {
    // Given a stream that overflowed the frame watch window,
    // When the renderer is asked for the notice directly,
    const notice = renderResult(shellResult({ stdout: 'x', frameOverflow: true }))
    // Then the notice distinguishes a dropped MIDDLE from a dropped head.
    expect(notice).toContain('a middle window was dropped')
  })
})

describe('the declared truncation contract', () => {
  it('operator inspecting the tool schema sees every truncation fact declared', () => {
    // Given the shipped tool definition,
    const tool = buildWinBashTool(
      context(),
      resolveConfig(undefined),
      { bash: 'C:/payload/bash.exe', bin: 'C:/payload/usr/bin' },
      shellsReturning(shellResult()),
    )
    // When its declared output properties are read,
    const properties = Object.keys((tool.output.schema as { properties: Record<string, unknown> }).properties)
    // Then the facts ./shell.ts computes are part of the canonical value the
    // renderer is projected from, rather than being dropped at this boundary.
    expect(properties).toEqual(expect.arrayContaining([
      'stdoutTruncated',
      'stderrTruncated',
      'stdoutLostHead',
      'stderrLostHead',
      'frameOverflow',
      'stdoutSpillPath',
      'stderrSpillPath',
    ]))
  })

  it('operator inspecting the tool schema sees the truncation wording carries no emoji', () => {
    // Given a rendered truncated result,
    const notice = renderResult(shellResult({ stdout: 'tail', stdoutTruncated: true, stdoutLostHead: true }))
    // When its characters are inspected,
    // Then every one is printable ASCII, as the repository requires.
    expect(/^[\x20-\x7e\n]*$/u.test(notice)).toBe(true)
  })
})
