/**
 * One persistent bash process per calling agent, driven over piped stdio.
 *
 * Why pipes and not the host's terminal seam: this tool needs a persistent
 * SHELL, not a terminal emulator. What must survive across calls is the shell
 * process state (its current directory, exported variables, functions and
 * aliases) plus exact stdout/stderr bytes and an exact exit code — all of
 * which the subprocess seam's collected streams give directly. A PTY would add
 * echoing and escape sequences this tool would then have to strip again, and
 * would not change the state model.
 *
 * Recovery policy: a shell that exits, wedges or fails its handshake is torn
 * down and the CURRENT call fails with a specific message; the NEXT call
 * starts a fresh shell. State loss is reported rather than hidden, because a
 * silent fresh shell would run the model's next command in the wrong directory
 * with no signal that the previous call's cd/export vanished.
 * @module @linxin666/dsh-win-bash/shell
 */

import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { buildFrame, markerFor, parseFrame, type FrameMarker, type FrameOutcome } from './protocol.ts'

/** Command stdout budget, in bytes, for one call. */
export const DEFAULT_MAX_STDOUT_BYTES = 128 * 1024

/** Command stderr budget, in bytes, for one call. */
export const DEFAULT_MAX_STDERR_BYTES = 32 * 1024

/** Spill-file byte cap per stream, so a runaway command cannot fill the disk. */
export const DEFAULT_SPILL_BYTES = 8 * 1024 * 1024

/** Grace period handed to the subprocess seam for range teardown. */
export const GRACE_MS = 5000

/** Ceiling on the bytes buffered while looking for a frame's end marker. */
export const FRAME_WATCH_BYTES = 4 * 1024 * 1024

/** In-memory capture ceiling for one shell's stderr, in bytes. */
export const SHELL_STDERR_CAPTURE_BYTES = 256 * 1024

/** Poll cadence while waiting for a frame to complete. */
const POLL_INTERVAL_MS = 15

/** How long a freshly spawned shell gets to answer its startup handshake. */
const HANDSHAKE_TIMEOUT_MS = 15_000

/** How long one spawn waits for its ledger line before reporting the pid unavailable. */
const SHELL_PID_TIMEOUT_MS = 1000

/** Poll cadence while waiting for the ledger line of the spawn in flight. */
const SHELL_PID_POLL_MS = 15

/** Age past which a spawn lock is abandoned (its holder died mid-section). */
const SPAWN_LOCK_STALE_MS = 10_000

/** How long one spawn may wait for the cross-process lock before proceeding unlocked. */
const SPAWN_LOCK_WAIT_MS = 2000

/** Exit status reported for a call the tool itself gave up on. */
export const TIMEOUT_EXIT_CODE = 124

/** Environment variable names carrying the per-shell private temp directory. */
export const TEMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const

/**
 * The argv of one pinned shell: the payload's own bash by absolute path, no rc
 * file and no profile, reading its commands from stdin. This tool never
 * consults PATH, and every shell it starts — the session's persistent one and
 * every background job — is built from this one function so the two can never
 * drift into different shells.
 * @param runtime - the verified payload paths.
 * @returns the argv to spawn.
 */
export function shellArgv(runtime: { bash: string }): string[] {
  return [runtime.bash, '--norc', '--noprofile', '-s']
}

/**
 * The environment contract every pinned shell starts with.
 * @param runtime - the verified payload paths.
 * @param temp - the private temp directory that shell owns.
 * @param base - the ambient environment the PATH is appended to.
 * @returns the entries this tool sets explicitly.
 */
export function shellEnvironment(
  runtime: { bin: string },
  temp: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    // The vendored usr/bin goes FIRST on PATH: the payload's own userland
    // is what commands resolve to, and no host Git for Windows, WSL or
    // per-user shim later in the inherited PATH can shadow it.
    PATH: runtime.bin + (process.platform === 'win32' ? ';' : ':') + (base.PATH ?? ''),
    // The payload resolves /tmp from its own etc/fstab usertemp entry,
    // which follows these three names. Pinning them keeps bash's whole
    // mkstemp family inside one private directory per shell instead of
    // the machine's shared temp root.
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    // The MSYS2 personality the payload was built from, which
    // profile.d/msystem reads.
    MSYSTEM: 'MSYS',
    // No terminal is attached, so coreutils would otherwise colour output
    // and pad it into columns based on an inherited TERM guess.
    TERM: 'dumb',
  }
}

/**
 * Create one shell process's private temp directory.
 * @returns the absolute directory, created if absent.
 */
export function shellTempDir(): string {
  const temp = join(tmpdir(), 'dsh-win-bash-' + process.pid.toString() + '-' + randomUUID().slice(0, 8))
  mkdirSync(temp, { recursive: true })
  return temp
}

/**
 * Where the subprocess seam appends its observational spawn ledger.
 *
 * The registry reads that ledger to learn each shell's tree-root pid: the
 * shared handle type has no pid (removed from the seam on 2026-08-28), while
 * the ledger's `runner` field records the direct child the host spawned — the
 * three-piece root whose parent is the host (verified live 2026-11-19:
 * `node.exe` → `bash.exe` + `conhost.exe`). Resolution follows the provider's
 * own order minus the layered data-root config file (best effort: a home
 * relocated only through that layer reads as missing here and degrades to
 * pid -1, never a throw).
 * @returns the absolute ledger path.
 */
function subprocessLedgerPath(): string {
  const override = process.env.DSH_SUBPROCESS_LEDGER
  if (override !== undefined && override.trim() !== '') return override.trim()
  const home = process.env.DSH_HOME
  if (home !== undefined && home.trim() !== '') return join(home.trim(), 'subprocess-ledger.jsonl')
  return join(homedir(), '.dsh', 'subprocess-ledger.jsonl')
}

/** One held cross-process spawn lock, or the unlocked stand-in when none was taken. */
interface SpawnLock {
  /** Release the lock; idempotent, never throws. */
  release(): void
}

/** The stand-in returned when the lock could not be taken: releasing it does nothing. */
const UNLOCKED_SPAWN_LOCK: SpawnLock = {
  release(): void {
    // Nothing was taken, so nothing can be released.
  },
}

/**
 * Take the cross-process spawn lock, so this spawn's ledger line cannot be
 * interleaved with another host's shell spawn between the offset read and the
 * tail read. A lock older than {@link SPAWN_LOCK_STALE_MS} is stolen (its
 * holder died mid-section); a lock that never frees within the wait degrades
 * to the unlocked stand-in, because the ledger read is best-effort by contract
 * and a shell must never fail to start over bookkeeping.
 * @param lockPath - the lock file next to the ledger.
 * @returns the held lock.
 */
async function acquireSpawnLock(lockPath: string): Promise<SpawnLock> {
  const deadline = Date.now() + SPAWN_LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      let released = false
      return {
        release: (): void => {
          if (released) return
          released = true
          try {
            unlinkSync(lockPath)
          } catch {
            // Already stolen by a stale-age reclaim or removed by cleanup.
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return UNLOCKED_SPAWN_LOCK
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > SPAWN_LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        // The lock vanished between attempts: retry immediately.
      }
      if (Date.now() > deadline) return UNLOCKED_SPAWN_LOCK
      await new Promise<void>(resolve => { setTimeout(resolve, SHELL_PID_POLL_MS) })
    }
  }
}

/**
 * The byte offset this spawn's ledger line must be read from. A missing ledger
 * counts as offset 0: the provider creates it on first append, and while the
 * lock is held no other win-bash spawn on this machine can write one.
 * @param ledgerPath - the seam's ledger file.
 * @returns the current file size in bytes, or 0 when absent.
 */
function ledgerOffset(ledgerPath: string): number {
  try {
    return statSync(ledgerPath).size
  } catch {
    return 0
  }
}

/**
 * Whether the pid names a live process right now.
 *
 * The ledger line is written on the runner's spawn event, so the pid is fresh
 * when it is recorded — but a runner that dies before this read could have had
 * its pid recycled (observed live 2026-11-19), which would hand a kill-anchor
 * consumer somebody else's process. Liveness is a floor, not identity: a
 * recycled-but-live pid passes and is indistinguishable here by design.
 * @param pid - the candidate tree-root pid.
 * @returns false only when the pid is provably gone.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Resolve the tree-root pid of the spawn that starts at `offset`.
 *
 * Reads only bytes appended after `offset` and accepts the first `spawn` line
 * whose `target` equals this spawn's argv[0] exactly: the payload's absolute
 * bash path is spawned only by this plugin (verified repo-wide 2026-11-19), so
 * the match is exact rather than heuristic, and the caller holds the spawn
 * lock across the whole window so another host's shell spawn cannot slip in.
 * Never throws: a ledger that never delivers (disabled, unwritable, or a
 * fallback spawn path that records nothing) reports -1 after the timeout, and
 * the shell itself is unaffected.
 * @param ledgerPath - the seam's ledger file.
 * @param offset - byte offset recorded before the spawn.
 * @param target - this spawn's argv[0], matched exactly.
 * @returns the live tree-root pid, or -1 when the ledger did not deliver one.
 */
async function resolveShellPid(ledgerPath: string, offset: number, target: string): Promise<number> {
  const deadline = Date.now() + SHELL_PID_TIMEOUT_MS
  let position = offset
  let pending = ''
  const buffer = Buffer.alloc(8 * 1024)
  for (;;) {
    let text = pending
    try {
      const fd = openSync(ledgerPath, 'r')
      try {
        for (;;) {
          const read = readSync(fd, buffer, 0, buffer.length, position)
          if (read <= 0) break
          position += read
          text += buffer.toString('utf8', 0, read)
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      // Ledger absent so far: wait for the provider to create it.
    }
    const lines = text.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.includes('"event":"spawn"')) continue
      let record: { readonly runner?: unknown, readonly target?: unknown }
      try {
        record = JSON.parse(line) as { readonly runner?: unknown, readonly target?: unknown }
      } catch {
        continue
      }
      if (record.target !== target || typeof record.runner !== 'number') continue
      return isProcessAlive(record.runner) ? record.runner : -1
    }
    if (Date.now() >= deadline) return -1
    await new Promise<void>(resolve => { setTimeout(resolve, SHELL_PID_POLL_MS) })
  }
}

/** One command's complete result, as the tool consumes it. */
export interface ShellResult {
  /** The command's stdout, bounded to the visible budget. */
  readonly stdout: string
  /** The command's stderr, bounded to the visible budget. */
  readonly stderr: string
  /** The command's exit status. */
  readonly exitCode: number
  /** True when visible stdout hit its byte budget. */
  readonly stdoutTruncated: boolean
  /** True when visible stderr hit its byte budget. */
  readonly stderrTruncated: boolean
  /** True when the retained stdout lost its head (marker or budget). */
  readonly stdoutLostHead: boolean
  /** True when the retained stderr lost its head. */
  readonly stderrLostHead: boolean
  /** The complete stdout, when it was truncated and the provider spilled it. */
  readonly stdoutSpillPath?: string
  /** The complete stderr, when it was truncated and the provider spilled it. */
  readonly stderrSpillPath?: string
  /** True when stdout overflowed the frame window, so the middle was dropped. */
  readonly frameOverflow: boolean
}

/**
 * The fallback every failure here points at.
 *
 * win_bash is the PREFERRED shell on Windows, not the only one: whenever it
 * cannot serve a call the native shell tool takes over, and a failure that did
 * not say so would leave the model retrying a shell that is not coming back
 * instead of switching to the one that works.
 */
export const NATIVE_FALLBACK_HINT = ' Use the host pwsh tool instead: it is the native shell for this platform'
  + ' and remains available whenever win_bash cannot serve a call.'

/** Failure raised when the shell cannot serve a call. */
export class ShellUnavailableError extends Error {
  /** Stable machine-readable reason. */
  readonly code: string

  /**
   * @param code - stable reason code.
   * @param message - explanation safe to show the model.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShellUnavailableError'
    this.code = code
  }
}

/** One live shell process and the facts the framing needs. */
interface LiveShell {
  /** The spawned process handle. */
  readonly handle: SubprocessHandle
  /**
   * Epoch ms when this record was constructed — the shell's birth moment,
   * assigned from the registry's clock in the same object literal as the handle.
   */
  readonly born: number
  /**
   * Tree-root process id of the shell's three-piece tree (`node runner.js` →
   * `bash.exe` → `conhost.exe`, parent = the host), or -1 when the seam's
   * ledger did not deliver a live one. The shared handle type carries no pid —
   * it was removed from the seam on 2026-08-28 (a95f0b368f) — so this rides
   * the provider's own spawn ledger instead; see {@link resolveShellPid}.
   */
  shellPid: number
  /** Set once the handle's outcome settles, so a dead shell is never reused. */
  exited: boolean
  /**
   * The process's own exit facts once it settled. A command that runs 'exit N'
   * ends the SHELL, and the shell's status IS that command's status, so the
   * tool can still report a real exit code instead of an error.
   */
  exitCode: number | null
  /**
   * Whole-stream byte offsets every earlier call on this process consumed,
   * ONE PER STREAM. Collected readers are whole-stream and non-consuming, so
   * each call must resume from here or it would re-parse the previous calls'
   * frames. The two counters are independent: stdout and stderr are separate
   * byte streams with unrelated lengths, and using one shared counter would
   * start the shorter stream past its own data.
   */
  cursor: ShellCursor
}

/** Per-stream resume offsets for one live shell. */
interface ShellCursor {
  /** Bytes of stdout already consumed by earlier calls. */
  stdout: number
  /** Bytes of stderr already consumed by earlier calls. */
  stderr: number
}

/**
 * One shell as the introspection endpoint reports it: the facts a consumer
 * needs to tie a live OS process to the session that owns it, without any
 * handle, stream or mutation escaping the registry.
 */
export interface ShellSnapshot {
  /** Canonical session id of the owning agent, or null when it cannot be read. */
  readonly sessionId: string | null
  /** Tree-root process id of the shell's three-piece tree, or -1 when unavailable. */
  readonly shellPid: number
  /** Epoch ms when the shell record was constructed. */
  readonly born: number
  /** Whether the shell's outcome has already settled. */
  readonly exited: boolean
}

/** Budgets and deadline for one {@link ShellRegistry.run} call. */
export interface RunBudget {
  /** Visible stdout byte budget. */
  readonly stdoutBytes: number
  /** Visible stderr byte budget. */
  readonly stderrBytes: number
  /** Whole-call deadline in milliseconds. */
  readonly timeoutMs: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
}

/** One bounded accumulator fed by an offset-based collected reader. */
class StreamTail {
  private buffer = ''
  /** Whole-stream offset already consumed from the provider's reader. */
  private offset = 0
  private overflowed = false
  private spilled = false
  private spill: string | undefined

  /**
   * @param label - which collected reader this accumulator drains.
   * @param from - whole-stream offset already consumed by earlier calls on
   *   the same process. Collected readers are whole-stream and non-consuming,
   *   so without this a call would re-read every previous frame.
   */
  constructor(private readonly label: 'stdout' | 'stderr', from = 0) {
    this.offset = from
  }

  /** Everything retained so far. */
  text(): string {
    return this.buffer
  }

  /** Whether the retained window dropped bytes (a lossy read or a trim). */
  lost(): boolean {
    return this.overflowed
  }

  /** Whether anything visible was cut, which is what a spill file is for. */
  wasCut(): boolean {
    return this.spilled
  }

  /** Spill file holding the complete stream, once the provider made one. */
  spillPath(): string | undefined {
    return this.spill
  }

  /**
   * Cut the visible text down to its last budget bytes, recording that the
   * stream was cut so the caller can point at the spill file for the rest.
   * @param budget - the visible byte budget.
   * @returns the visible text and whether it was cut.
   */
  visible(budget: number): { text: string, truncated: boolean } {
    const result = tailBytes(this.buffer, budget)
    if (result.truncated) this.spilled = true
    return result
  }

  /** Record that this stream's visible text was cut somewhere upstream. */
  markCut(): void {
    this.spilled = true
  }

  /** Whole-stream byte offset already consumed. */
  consumed(): number {
    return this.offset
  }

  /**
   * Drain new bytes from one handle's collected readers.
   * @param handle - the live shell's handle.
   * @param watchBytes - how many bytes may be buffered before the head drops.
   */
  drain(handle: SubprocessHandle, watchBytes: number): void {
    const reader = this.label === 'stdout' ? handle.collected.stdout : handle.collected.stderr
    if (reader === undefined) return
    const read = reader.readFrom(this.offset)
    this.offset = read.nextOffset
    if (read.lossy) this.overflowed = true
    if (read.spillPath !== undefined) this.spill = read.spillPath
    if (read.text === '') return
    this.buffer += read.text
    while (byteLength(this.buffer) > watchBytes) {
      this.overflowed = true
      this.buffer = this.buffer.slice(Math.ceil(this.buffer.length / 4))
    }
  }
}

/** UTF-8 byte length of a string. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Keep the LAST budget bytes of a string, reporting whether it dropped any.
 * @param text - the full text.
 * @param budget - the visible byte budget.
 * @returns the visible text and whether it was cut.
 */
export function tailBytes(text: string, budget: number): { text: string, truncated: boolean } {
  if (byteLength(text) <= budget) return { text, truncated: false }
  // Cut from the front on a byte basis. A multi-byte character split by the
  // cut would decode to U+FFFD, which is dropped so the result stays clean
  // text rather than carrying a replacement character nobody wrote.
  const bytes = Buffer.from(text, 'utf8')
  const tail = bytes.subarray(bytes.length - budget).toString('utf8')
  return { text: tail.startsWith('\uFFFD') ? tail.slice(1) : tail, truncated: true }
}

/**
 * The persistent shells of one plugin instance, keyed by calling agent.
 *
 * The keys are the live agent objects and the map is plain, so an agent's
 * shell is dropped by that agent's own disposal hook rather than by a weak
 * reference that decides for itself when to act.
 */
export class ShellRegistry {
  private readonly shells = new Map<object, LiveShell>()

  /**
   * @param subprocess - the host's managed subprocess seam.
   * @param now - clock, injected so tests run without real waiting.
   */
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Live shell count, for teardown assertions. */
  get size(): number {
    return this.shells.size
  }

  /** Whether the given owner currently holds a live shell. */
  has(owner: object): boolean {
    const shell = this.shells.get(owner)
    return shell !== undefined && !shell.exited
  }

  /**
   * A read-only view of every shell this registry holds.
   *
   * Read-only by construction — one pass over the map, no mutation, no spawn,
   * nothing that can fail — so the introspection endpoint can answer under any
   * registry state. An owner whose session id is unreadable reports a null
   * sessionId instead of throwing: one bad owner must never take the whole
   * endpoint down.
   * @returns one entry per held shell, in map order.
   */
  snapshot(): ShellSnapshot[] {
    const snapshots: ShellSnapshot[] = []
    for (const [owner, shell] of this.shells) {
      const id = (owner as { session?: { id?: unknown } }).session?.id
      snapshots.push({
        sessionId: typeof id === 'string' ? canonicalSessionKey(id) : null,
        shellPid: shell.shellPid,
        born: shell.born,
        exited: shell.exited,
      })
    }
    return snapshots
  }

  /**
   * Run one command in the owner's persistent shell, starting it on first use.
   * @param owner - the calling agent (the shell lifetime key).
   * @param runtime - absolute shell and payload paths.
   * @param cwd - the session workspace a newly started shell begins in.
   * @param command - the command to run.
   * @param budget - output budgets and the call deadline.
   * @returns the command's complete result.
   */
  async run(
    owner: object,
    runtime: { bash: string, bin: string },
    cwd: string,
    command: string,
    budget: RunBudget,
  ): Promise<ShellResult> {
    const shell = await this.ensure(owner, runtime, cwd, budget.signal)
    const marker = markerFor(randomUUID())
    const stdout = new StreamTail('stdout', shell.cursor.stdout)
    const stderr = new StreamTail('stderr', shell.cursor.stderr)
    shell.handle.stdin?.write(buildFrame(command, marker))
    const deadline = this.now() + budget.timeoutMs
    let sawBegin = false
    // Resume offsets advance on EVERY return path, so the next call on this
    // process starts after this frame instead of re-parsing it.
    const resume = (): void => {
      shell.cursor.stdout = stdout.consumed()
      shell.cursor.stderr = stderr.consumed()
    }

    for (;;) {
      if (budget.signal?.aborted === true) {
        resume()
        await this.dispose(owner, 'the tool call was aborted')
        throw new ShellUnavailableError(
          'aborted',
          'The win_bash call was aborted and its persistent shell was stopped. The next call starts a fresh shell, '
          + 'so shell state changed before this call was aborted is gone.',
        )
      }
      const frame = readFrame(shell, stdout, stderr, marker, sawBegin)
      // Latch the begin marker: a command whose output exceeds the watch window
      // loses its head, and the end marker must still be recognized then.
      sawBegin ||= frame.text.includes(marker.begin)
      if (frame.outcome !== undefined) {
        const result = complete(frame.outcome, stdout, stderr, budget)
        resume()
        return result
      }
      if (shell.exited) {
        // A drained-but-unframed exit means the command ended the SHELL (an
        // explicit 'exit N', or a runtime failure). When the process reported
        // its own status, that status IS this command's status, so the call
        // answers with a real exit code plus a note that the shell is gone and
        // the next call starts fresh. Without a status there is nothing honest
        // to report but the teardown itself.
        resume()
        this.shells.delete(owner)
        const partial = tailBytes(recoverPartial(frame.text, marker), budget.stdoutBytes)
        if (shell.exitCode === null) {
          throw new ShellUnavailableError(
            'shell-exited',
            'The persistent bash shell exited without reporting a status, so this command did not complete. '
            + 'The next win_bash call starts a fresh shell in the session workspace with a new current directory and environment.',
          )
        }
        const visibleErr = stderr.visible(budget.stderrBytes)
        const note = '[the command ended the persistent bash process; the next win_bash call starts a fresh shell]'
        return {
          stdout: partial.text,
          stderr: visibleErr.text === '' ? note : visibleErr.text + '\n' + note,
          exitCode: shell.exitCode,
          stdoutTruncated: partial.truncated,
          stderrTruncated: visibleErr.truncated,
          stdoutLostHead: stdout.lost() || partial.truncated,
          stderrLostHead: stderr.lost() || visibleErr.truncated,
          frameOverflow: stdout.lost(),
          ...(stdout.wasCut() && stdout.spillPath() !== undefined ? { stdoutSpillPath: stdout.spillPath() } : {}),
          ...(stderr.wasCut() && stderr.spillPath() !== undefined ? { stderrSpillPath: stderr.spillPath() } : {}),
        }
      }
      if (this.now() > deadline) {
        await this.dispose(owner, 'the command exceeded its time budget')
        const visibleErr = stderr.visible(budget.stderrBytes)
        const note = '[timed out after ' + budget.timeoutMs.toString()
          + 'ms; the persistent shell was stopped, so the next win_bash call starts a fresh shell]'
        const partial = tailBytes(recoverPartial(frame.text, marker), budget.stdoutBytes)
        if (partial.truncated) stdout.markCut()
        resume()
        return {
          stdout: partial.text,
          stderr: visibleErr.text === '' ? note : visibleErr.text + '\n' + note,
          exitCode: TIMEOUT_EXIT_CODE,
          stdoutTruncated: partial.truncated,
          stderrTruncated: visibleErr.truncated,
          stdoutLostHead: stdout.lost() || partial.truncated,
          stderrLostHead: stderr.lost() || visibleErr.truncated,
          frameOverflow: stdout.lost(),
          ...(stdout.wasCut() && stdout.spillPath() !== undefined ? { stdoutSpillPath: stdout.spillPath() } : {}),
          ...(stderr.wasCut() && stderr.spillPath() !== undefined ? { stderrSpillPath: stderr.spillPath() } : {}),
        }
      }
      await new Promise<void>(resolve => { setTimeout(resolve, POLL_INTERVAL_MS) })
    }
  }

  /**
   * Get the owner's live shell, starting one when absent.
   * @param owner - calling agent identity.
   * @param runtime - absolute shell and payload paths.
   * @param cwd - the session workspace a new shell starts in.
   * @param signal - cancellation while the shell starts.
   * @returns the live shell record.
   */
  private async ensure(
    owner: object,
    runtime: { bash: string, bin: string },
    cwd: string,
    signal?: AbortSignal,
  ): Promise<LiveShell> {
    const existing = this.shells.get(owner)
    if (existing !== undefined && !existing.exited) return existing
    if (existing !== undefined) this.shells.delete(owner)
    const argv = shellArgv(runtime)
    const ledgerPath = subprocessLedgerPath()
    // The lock spans offset → spawn → tail read so another host's shell spawn
    // cannot slip its ledger line into this window and lend us its pid.
    const lock = await acquireSpawnLock(ledgerPath + '.spawn-lock')
    try {
      const offset = ledgerOffset(ledgerPath)
      const handle = this.subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'pipe',
          stdout: { maxBytes: FRAME_WATCH_BYTES, spill: { maxBytes: DEFAULT_SPILL_BYTES } },
          stderr: { maxBytes: SHELL_STDERR_CAPTURE_BYTES, spill: { maxBytes: DEFAULT_SPILL_BYTES } },
        },
        graceMs: GRACE_MS,
        env: shellEnvironment(runtime, shellTempDir()),
      })
      const shell: LiveShell = { handle, born: this.now(), shellPid: -1, exited: false, cursor: { stdout: 0, stderr: 0 }, exitCode: null }
      const markExited = (outcome: { exitCode: number | null }): void => {
        shell.exitCode = outcome.exitCode
        shell.exited = true
      }
      void handle.done.then(markExited, () => { shell.exited = true })
      this.shells.set(owner, shell)
      shell.shellPid = await resolveShellPid(ledgerPath, offset, argv[0])
      await this.handshake(shell, signal)
      return shell
    } finally {
      lock.release()
    }
  }

  /**
   * Confirm a fresh shell answers before the first real command runs, so a
   * payload that cannot start surfaces as one clear failure instead of as a
   * mysterious empty result on the model's command.
   */
  private async handshake(shell: LiveShell, signal?: AbortSignal): Promise<void> {
    const marker = markerFor(randomUUID())
    const stdout = new StreamTail('stdout', shell.cursor.stdout)
    shell.handle.stdin?.write(buildFrame('printf %s "$BASH_VERSION"', marker))
    const deadline = this.now() + HANDSHAKE_TIMEOUT_MS
    for (;;) {
      if (shell.exited) {
        throw new ShellUnavailableError(
          'shell-exited',
          'The vendored bash exited during startup, so win_bash cannot run commands in this session.' + NATIVE_FALLBACK_HINT,
        )
      }
      if (signal?.aborted === true) {
        throw new ShellUnavailableError('aborted', 'The win_bash call was aborted while the persistent shell was starting.')
      }
      stdout.drain(shell.handle, 256 * 1024)
      const outcome = parseFrame(stdout.text(), marker, true)
      if (outcome !== undefined) {
        if (outcome.exitCode !== 0 || !/^\d+(\.\d+)?/.test(outcome.stdout)) {
          throw new ShellUnavailableError(
            'handshake-failed',
            'The vendored bash did not report a version (exit ' + outcome.exitCode.toString() + ').' + NATIVE_FALLBACK_HINT,
          )
        }
        // The handshake's own bytes are consumed here too: the first real
        // command must resume past the version frame, not re-parse it.
        shell.cursor.stdout = stdout.consumed()
        return
      }
      if (this.now() > deadline) {
        throw new ShellUnavailableError(
          'handshake-timeout',
          'The vendored bash did not answer its startup handshake in time.' + NATIVE_FALLBACK_HINT,
        )
      }
      await new Promise<void>(resolve => { setTimeout(resolve, POLL_INTERVAL_MS) })
    }
  }

  /**
   * Stop one owner's shell and forget it. Termination goes through the seam's
   * managed-process range, so a background job the command left behind is torn
   * down with the shell rather than surviving the plugin.
   * @param owner - calling agent identity.
   * @param reason - recorded by the provider for diagnostics.
   */
  async dispose(owner: object, reason: string): Promise<void> {
    const shell = this.shells.get(owner)
    if (shell === undefined) return
    this.shells.delete(owner)
    await terminate(shell, reason)
  }

  /**
   * Stop the shells of every owner whose session matches, and forget them.
   *
   * This is the archive-time reclamation leg: archiving does NOT dispose the
   * agent (the row and its resident agent outlive the archive), so waiting on
   * `agent/disposed` alone leaves a closed-over session's bash resident until
   * the plugin unloads. The id arrives from the Workspace registry's stop
   * seam, whose spelling may lack the `session-` prefix the agent's own
   * session id carries, so both sides are compared in canonical form.
   * @param sessionId - the session being archived.
   * @param reason - recorded by the provider for diagnostics.
   * @returns how many shells this call reclaimed (0 when none matched).
   */
  async disposeSession(sessionId: string, reason: string): Promise<number> {
    const wanted = canonicalSessionKey(sessionId)
    const doomed: object[] = []
    for (const owner of this.shells.keys()) {
      const id = (owner as { session?: { id?: unknown } }).session?.id
      if (typeof id === 'string' && canonicalSessionKey(id) === wanted) doomed.push(owner)
    }
    await Promise.allSettled(doomed.map(owner => this.dispose(owner, reason)))
    return doomed.length
  }

  /** Stop every shell this registry owns; used on plugin unload. */
  async disposeAll(reason: string): Promise<void> {
    const shells = [...this.shells.values()]
    this.shells.clear()
    await Promise.allSettled(shells.map(shell => terminate(shell, reason)))
  }
}

/**
 * One spelling of a session id for matching: `session-<uuid>` and `<uuid>`
 * name the same session (the archive set stores both), so a stop request must
 * match an owner either way.
 * @param id - a session id in either spelling.
 * @returns the canonical spelling used for comparison.
 */
function canonicalSessionKey(id: string): string {
  return id.startsWith('session-') ? id : `session-${id}`
}

/** One frame read attempt: the parsed outcome and the raw stdout it came from. */
interface FrameRead {
  /** The parsed frame, once both markers and the status digits arrived. */
  readonly outcome: FrameOutcome | undefined
  /** Raw accumulated stdout, used to recover a partial result on timeout. */
  readonly text: string
}

/**
 * Drain both streams once and try to parse the call's frame.
 *
 * Draining and parsing are one step on purpose: a caller that drained without
 * parsing left the accumulator holding a frame it never consumed, and the next
 * call then re-read that stale text as its own result.
 * @param shell - the live shell.
 * @param stdout - the stdout accumulator.
 * @param stderr - the stderr accumulator.
 * @param marker - the call's markers.
 * @param sawBegin - whether the begin marker was already observed.
 * @returns the parsed outcome (once complete) and the raw stdout.
 */
function readFrame(
  shell: LiveShell,
  stdout: StreamTail,
  stderr: StreamTail,
  marker: FrameMarker,
  sawBegin: boolean,
): FrameRead {
  stdout.drain(shell.handle, FRAME_WATCH_BYTES)
  stderr.drain(shell.handle, FRAME_WATCH_BYTES)
  const text = stdout.text()
  return {
    outcome: text.includes(marker.end) ? parseFrame(text, marker, sawBegin) : undefined,
    text,
  }
}

/**
 * Assemble the tool-visible result from a completed frame.
 *
 * The stdout comes from the PARSED FRAME, not from the raw accumulator: the
 * accumulator still holds the markers and every earlier byte of the stream,
 * so reading it directly would hand the model the framing as its output.
 */
function complete(outcome: FrameOutcome, stdout: StreamTail, stderr: StreamTail, budget: RunBudget): ShellResult {
  const visibleOut = tailBytes(outcome.stdout, budget.stdoutBytes)
  if (visibleOut.truncated) stdout.markCut()
  const visibleErr = stderr.visible(budget.stderrBytes)
  const outDropped = outcome.lostPrefix || stdout.lost() || visibleOut.truncated
  return {
    stdout: visibleOut.text,
    stderr: visibleErr.text,
    exitCode: outcome.exitCode,
    stdoutTruncated: outDropped,
    stderrTruncated: visibleErr.truncated,
    stdoutLostHead: outDropped,
    stderrLostHead: stderr.lost() || visibleErr.truncated,
    frameOverflow: stdout.lost(),
    ...(stdout.wasCut() && stdout.spillPath() !== undefined ? { stdoutSpillPath: stdout.spillPath() } : {}),
    ...(stderr.wasCut() && stderr.spillPath() !== undefined ? { stderrSpillPath: stderr.spillPath() } : {}),
  }
}

/** Whatever stdout is recoverable after a timeout, with the begin marker cut. */
function recoverPartial(text: string, marker: FrameMarker): string {
  const begin = text.lastIndexOf(marker.begin)
  return begin < 0 ? text : text.slice(begin + marker.begin.length).replace(/^\n/, '')
}

/** Signal and await one shell's managed range, never letting teardown throw. */
async function terminate(shell: LiveShell, reason: string): Promise<void> {
  void reason
  try {
    shell.handle.terminate()
    await shell.handle.waitForExit()
  } catch {
    // A provider that can no longer observe its range must not block teardown:
    // the process was signalled and the registry entry is already gone.
  }
}