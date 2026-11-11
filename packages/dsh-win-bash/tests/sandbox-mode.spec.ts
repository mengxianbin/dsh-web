/**
 * Sandbox-mode contract: win_bash runs ONLY in a danger-full-access session.
 *
 * WHY THIS IS A DECLARATION AND NOT A CONFINEMENT. A restricted session would
 * have to spawn the pinned payload through the sandbox provider's confine step,
 * and the pinned MSYS2 bash cannot start that way — measured against the real
 * restricted-token runner, bash.exe/sh.exe/dash.exe/echo.exe all die before
 * main with NtCreateDirectoryObject(...msys-2.0S5-...): 0xC0000022, while
 * cmd.exe/node.exe/powershell.exe run confined on the same runner. So the tool
 * refuses a restricted session instead of pretending to confine it: a shell
 * whose every command dies before main is worse than an honest refusal, and a
 * refusal that named a boundary would claim a fence that never held a command.
 *
 * Two things this suite pins:
 *   - the policy is resolved FOR THE CALLING SESSION, so a session the user
 *     restricted cannot slip through on the deployment default;
 *   - the refusal happens before any process is spawned or any job registered,
 *     on both the foreground and the background path.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { resolveConfig } from '../src/config.ts'
import { ShellRegistry } from '../src/shell.ts'
import { buildWinBashTool } from '../src/tool.ts'

const RUNTIME = { bash: 'C:/payload/bash.exe', bin: 'C:/payload/usr/bin' }

/** A subprocess seam that records every spawn it is asked for. */
function recordingSubprocess() {
  const argv: string[][] = []
  return {
    argv,
    runtime: {
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        argv.push([...spec.argv])
        return {
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          control: undefined,
          collected: {},
          // Never settles: these assertions are about whether a spawn happened
          // at all, and one that does must be cancelled rather than waited out.
          done: new Promise(() => {}),
          terminate: () => {},
          waitForExit: async () => true,
        } as unknown as SubprocessHandle
      },
    } as unknown as SubprocessRuntime,
  }
}

/** A job registry that records the jobs it is asked to start. */
function recordingJobs() {
  const started: unknown[] = []
  return {
    started,
    registry: {
      start: (spec: unknown) => {
        started.push(spec)
        return 'win-bash-1'
      },
    },
  }
}

/**
 * The structural context the tool reads.
 *
 * `resolve` records the request it was handed, so the suite can assert that the
 * calling session travelled into the policy read rather than being dropped.
 */
function context(services: {
  mode?: string
  sessionOverride?: string
  subprocess?: unknown
  jobs?: unknown
}): Context {
  const requests: unknown[] = []
  const policyFor = (session: unknown): SandboxExecutionPolicy => {
    const mode = session !== undefined && services.sessionOverride !== undefined
      ? services.sessionOverride
      : services.mode ?? 'danger-full-access'
    return { mode, workspaceRoot: process.cwd() } as unknown as SandboxExecutionPolicy
  }
  return {
    requests,
    get: (name: string) => {
      if (name === 'sandboxPolicy') {
        return {
          resolve: (request?: { session?: unknown }) => {
            requests.push(request)
            return policyFor(request?.session)
          },
        }
      }
      if (name === 'jobs') return services.jobs
      return undefined
    },
    subprocess: services.subprocess,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Context
}

/** The calling agent, with the session the policy read must carry. */
const EXEC = () => ({
  agent: { id: 'session-1', session: { header: { cwd: process.cwd() } } },
  signal: undefined,
})

/** One macrotask turn, so an awaited chain reaches its spawn. */
function settleTurn(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve) })
}

/**
 * Run one foreground call far enough to see whether it spawns, then cancel it.
 * @param tool - the shipped tool.
 * @param shells - the registry the call uses.
 * @returns the thrown message, or undefined when the call got as far as a spawn.
 */
async function foregroundOutcome(
  tool: { execute(args: unknown, exec: never): Promise<unknown> },
  shells: ShellRegistry,
): Promise<string | undefined> {
  const controller = new AbortController()
  let message: string | undefined
  const call = tool.execute({ command: 'echo hi' }, {
    agent: { id: 'session-1', session: { header: { cwd: process.cwd() } } },
    signal: controller.signal,
  } as never)
  const contained = call.then(() => undefined, (error: unknown) => {
    message = error instanceof Error ? error.message : String(error)
  })
  await settleTurn()
  controller.abort()
  await contained
  await shells.disposeAll('test teardown')
  return message
}

describe('the sandbox mode declaration', () => {
  it('operator on a read-only session is refused before any shell is spawned', async () => {
    // Given a session the user restricted to read-only,
    const subprocess = recordingSubprocess()
    const shells = new ShellRegistry(subprocess.runtime)
    const tool = buildWinBashTool(
      context({ mode: 'read-only', subprocess: subprocess.runtime }),
      resolveConfig(undefined),
      RUNTIME,
      shells,
    )
    // When the model runs a foreground command,
    const message = await foregroundOutcome(tool, shells)
    // Then it is refused by name, the measured cause is stated, and no process
    // was started — the call never reaches the boundary it would have to lie about.
    expect(message).toContain('SANDBOX_UNSUPPORTED')
    expect(message).toContain('read-only')
    expect(message).toContain('0xC0000022')
    expect(subprocess.argv).toEqual([])
  })

  it('operator on a workspace-write session is refused by the same rule', async () => {
    // Given a session in the other restricted mode,
    const subprocess = recordingSubprocess()
    const shells = new ShellRegistry(subprocess.runtime)
    const tool = buildWinBashTool(
      context({ mode: 'workspace-write', subprocess: subprocess.runtime }),
      resolveConfig(undefined),
      RUNTIME,
      shells,
    )
    // When the model runs a foreground command,
    const message = await foregroundOutcome(tool, shells)
    // Then the same declaration refuses it, and the refusal points at the
    // native shell that IS confined rather than leaving the caller without a
    // route. win_bash is the PREFERRED shell, not the only one: every refusal
    // has to say where the command can run instead.
    expect(message).toContain('SANDBOX_UNSUPPORTED')
    expect(message).toContain('pwsh')
    expect(message).toContain('native shell')
    expect(subprocess.argv).toEqual([])
  })

  it('operator on a danger-full-access session gets the payload shell spawned unwrapped', async () => {
    // Given the one mode this tool supports,
    const subprocess = recordingSubprocess()
    const shells = new ShellRegistry(subprocess.runtime)
    const tool = buildWinBashTool(
      context({ mode: 'danger-full-access', subprocess: subprocess.runtime }),
      resolveConfig(undefined),
      RUNTIME,
      shells,
    )
    // When the model runs a foreground command,
    await foregroundOutcome(tool, shells)
    // Then the payload's own bash by absolute path is what starts: no wrapper,
    // no PATH lookup.
    expect(subprocess.argv[0]).toEqual(['C:/payload/bash.exe', '--norc', '--noprofile', '-s'])
  })

  it('operator restricting one session cannot have it run on the deployment default', async () => {
    // Given a deployment whose default is full access but whose CALLING session
    // carries a restricted override — which the policy service ranks first,
    const subprocess = recordingSubprocess()
    const shells = new ShellRegistry(subprocess.runtime)
    const contextUnderTest = context({
      mode: 'danger-full-access',
      sessionOverride: 'read-only',
      subprocess: subprocess.runtime,
    })
    const tool = buildWinBashTool(contextUnderTest, resolveConfig(undefined), RUNTIME, shells)
    // When the model runs a foreground command,
    const message = await foregroundOutcome(tool, shells)
    // Then the session's own mode decided, so a session the user restricted
    // cannot reach the shell through the deployment default.
    expect(message).toContain('SANDBOX_UNSUPPORTED')
    expect(message).toContain('read-only')
    expect(subprocess.argv).toEqual([])
    // And the session travelled into the read, which is what makes that true.
    const requests = (contextUnderTest as unknown as { requests: { session?: unknown }[] }).requests
    expect(requests.some(request => request?.session !== undefined)).toBe(true)
  })

  it('operator whose payload cannot start is told which shell to use instead', async () => {
    // Given a subprocess whose process never answers the startup handshake,
    // and a clock that steps past every deadline at once so the handshake fails
    // deterministically instead of waiting out its real bound.
    const subprocess = recordingSubprocess()
    let ticks = 0
    const shells = new ShellRegistry(subprocess.runtime, () => (ticks += 20_000))
    const tool = buildWinBashTool(
      context({ mode: 'danger-full-access', subprocess: subprocess.runtime }),
      resolveConfig(undefined),
      RUNTIME,
      shells,
    )
    // When the model runs a command and the shell never becomes usable,
    let message: string | undefined
    try {
      await tool.execute({ command: 'echo hi' }, EXEC() as never)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    await shells.disposeAll('test teardown')
    // Then the failure names the native shell to fall back to, so a model does
    // not keep retrying a shell that is not coming back.
    expect(message).toContain('handshake')
    expect(message).toContain('pwsh')
  })

  it('operator asking for a background command in a restricted session gets no process and no job', async () => {
    // Given a registered job registry and a restricted session,
    const subprocess = recordingSubprocess()
    const jobs = recordingJobs()
    const tool = buildWinBashTool(
      context({ mode: 'read-only', subprocess: subprocess.runtime, jobs: jobs.registry }),
      resolveConfig(undefined),
      RUNTIME,
      { run: async () => { throw new Error('the background path must not touch the persistent shell') } } as unknown as ShellRegistry,
    )
    // When the model asks for a background command,
    let message: string | undefined
    try {
      await tool.execute({ command: 'echo bg', run_in_background: true }, EXEC() as never)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // Then the mode declaration refuses it before anything is started or
    // registered: the background path obeys the same rule as the foreground one.
    expect(message).toContain('SANDBOX_UNSUPPORTED')
    expect(subprocess.argv).toEqual([])
    expect(jobs.started).toEqual([])
  })
})
