/**
 * The vendored payload starting for real on this machine: the acceptance
 * evidence for "a real bash, not a shim". Skipped on hosts that cannot run a
 * Windows PE, so a POSIX reviewer's suite stays green without pretending the
 * payload was exercised there.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bashPath, binDir } from '../src/runtime.ts'

const RUNNABLE = process.platform === 'win32' && process.arch === 'x64'

/** One settled run of the vendored shell. */
interface RunOutput {
  stdout: string
  stderr: string
  code: number | null
}

/**
 * Run one command in a freshly spawned vendored bash.
 * @param command - the bash command to run.
 * @param cwd - the child's working directory (the MSYS root resolution anchor).
 * @returns the settled output.
 */
function runBash(command: string, cwd: string): Promise<RunOutput> {
  return new Promise((resolve, reject) => {
    const temp = join(tmpdir(), 'dsh-win-bash-smoke-' + Math.random().toString(36).slice(2, 8))
    mkdirSync(temp, { recursive: true })
    const child = spawn(bashPath(), ['-c', command], {
      cwd,
      env: {
        ...process.env,
        PATH: binDir() + ';' + (process.env.PATH ?? ''),
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
        MSYSTEM: 'MSYS',
        TERM: 'dumb',
      },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => { resolve({ stdout, stderr, code }) })
  })
}

describe.skipIf(!RUNNABLE)('the vendored bash on a real host', () => {
  it('operator running the payload gets GNU bash reporting its pinned version', async () => {
    // Given the shipped shell started on this machine,
    // When it reports its own version,
    const result = await runBash('echo $BASH_VERSION', process.cwd())
    // Then the pinned MSYS2 bash answered, not a shim and not a PATH bash.
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('5.3.15(2)-release')
  })

  it('operator running the payload gets the MSYS2 userland resolving through the payload root', async () => {
    // Given the shipped shell,
    // When it prints the MSYS root its own installation resolved to,
    const result = await runBash('cd /usr/bin && pwd -W', process.cwd())
    // Then the root is the package's own payload directory, which is what
    // makes every userland command resolve inside the vendored tree.
    expect(result.code).toBe(0)
    expect(result.stdout.trim().toLowerCase()).toBe(binDir().replace(/\\/g, '/').toLowerCase())
  })

  it('operator running the payload gets pipelines, quoting and here-documents working', async () => {
    // Given a command using the syntax that motivates this tool,
    // When it runs,
    const result = await runBash(
      "printf 'b\\na\\nc\\n' | sort | head -2; cat <<EOF\nheredoc-line\nEOF\necho \"quoted '$HOME'\"",
      process.cwd(),
    )
    // Then every construct produced its expected output.
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('a\nb')
    expect(result.stdout).toContain('heredoc-line')
    expect(result.stdout).toContain("quoted '")
  })

  it('operator running the payload gets the command exit status, not the shell wrapper status', async () => {
    // Given a command the shell itself starts but the command fails,
    // When it runs,
    const failing = await runBash('exit 42', process.cwd())
    // Then the status is the command's own.
    expect(failing.code).toBe(42)
  })

  it('operator running the payload gets bash builtins evaluated rather than a literal echo', async () => {
    // Given a command relying on real bash semantics,
    // When it runs,
    const result = await runBash('x=7; for i in 1 2 3; do x=$((x+i)); done; echo "x=$x"', process.cwd())
    // Then arithmetic and loops behaved as bash, which a POSIX sh shim would
    // not guarantee in the same way.
    expect(result.stdout.trim()).toBe('x=13')
  })
})
