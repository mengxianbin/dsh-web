/**
 * Wire protocol for the session's persistent bash shell.
 *
 * The shell is one long-lived 'bash -s' process per session, so every tool
 * call must (a) inject its command without racing the previous one and (b)
 * find the exact end of that command's output and its exit status inside one
 * continuous byte stream. Both jobs ride this module and nothing else, so the
 * framing is unit-testable without a process.
 *
 * Frame shape, written on stdin for each call:
 *
 *     printf '\n%s\n' '<M>BEGIN'
 *     . /dev/stdin <<'<M>END'
 *     <the model's command, verbatim, any number of lines>
 *     <M>END
 *     __dsh_win_bash_status=$?
 *     printf '\n%s%d\n' '<M>END' "$__dsh_win_bash_status"
 *
 * Why a heredoc and not a plain brace-group: the shell parses a brace group
 * one command at a time, so a syntactic error inside it aborts the REST of the
 * group — a model line with an unterminated quote would swallow the end marker
 * and leave the call (and the shell) wedged forever. The command is therefore
 * read through a heredoc into the source builtin, which the shell parses as
 * ONE unit: a syntax error is reported and the shell moves on to the next
 * line, where the status capture and the end marker still run. Measured on the
 * vendored bash: an unterminated quote produces 'unexpected EOF while looking
 * for matching' on stderr, and the very next call succeeds on the same
 * process.
 *
 * The begin/end markers carry a per-call nonce, so a command cannot forge the
 * end of its own frame even if it echoes marker-shaped text.
 * @module @linxin666/dsh-win-bash/protocol
 */

/** Literal prefix of every frame marker; the nonce follows it. */
export const MARKER_PREFIX = '__DSH_WIN_BASH_'

/** Suffix closing the nonce, keeping the marker a single shell word. */
export const MARKER_SUFFIX = '__'

/** Begin/end marker pair for one call. */
export interface FrameMarker {
  /** Printed before the command runs; the command's output follows it. */
  readonly begin: string
  /** Printed after the command's status is captured; the digits follow it. */
  readonly end: string
}

/**
 * Build the marker pair for one call. The nonce is stripped to alphanumerics
 * so the markers stay valid heredoc delimiters and single shell words.
 * @param nonce - caller-supplied uniqueness source (a UUID).
 * @returns the begin/end markers, both printable and both nonce-bearing.
 */
export function markerFor(nonce: string): FrameMarker {
  const safe = nonce.replace(/[^A-Za-z0-9]/g, '')
  const base = MARKER_PREFIX + safe + MARKER_SUFFIX
  return { begin: base + 'BEGIN', end: base + 'END' }
}

/**
 * Render the stdin frame for one command. The command is inserted verbatim:
 * the heredoc is quoted, so the shell performs no expansion on it while
 * reading, and the sourced text is executed exactly as the model wrote it.
 * @param command - the model's command, any number of lines.
 * @param marker - the markers for this call.
 * @returns the text to write to the shell's stdin, newline-terminated.
 */
export function buildFrame(command: string, marker: FrameMarker): string {
  return [
    "printf '\\n%s\\n' '" + marker.begin + "'",
    ". /dev/stdin <<'" + marker.end + "'",
    command,
    marker.end,
    '__dsh_win_bash_status=$?',
    "printf '\\n%s%d\\n' '" + marker.end + '\' "$__dsh_win_bash_status"',
    '',
  ].join('\n')
}

/** One complete command frame recovered from the output stream. */
export interface FrameOutcome {
  /** The command's stdout: everything between the two markers, verbatim. */
  readonly stdout: string
  /** The command's exit status. */
  readonly exitCode: number
  /**
   * Whether the begin marker had already slid out of the retained output
   * window, so 'stdout' is a suffix of the real output rather than all of it.
   */
  readonly lostPrefix: boolean
}

/**
 * Recover one command's stdout and exit status from accumulated output.
 * Unframed or still-running text returns undefined, so the caller keeps
 * waiting instead of reporting a truncated result.
 * @param text - accumulated stdout for the current call.
 * @param marker - the markers for this call.
 * @param sawBegin - whether the begin marker was observed before the window slid.
 * @returns the outcome once the end marker and its digits arrived.
 */
export function parseFrame(text: string, marker: FrameMarker, sawBegin: boolean): FrameOutcome | undefined {
  const beginIndex = text.indexOf(marker.begin)
  const endIndex = text.indexOf(marker.end, beginIndex < 0 ? 0 : beginIndex + marker.begin.length)
  if (endIndex < 0) return undefined
  const status = /^(\d+)\r?\n/.exec(text.slice(endIndex + marker.end.length))
  if (status === null) return undefined
  if (beginIndex < 0 && !sawBegin) return undefined
  let bodyStart = beginIndex < 0 ? 0 : beginIndex + marker.begin.length
  // The begin printf writes a newline after its marker; drop that one so the
  // recovered stdout starts at the command's first byte.
  if (text[bodyStart] === '\n') bodyStart += 1
  let stdout = text.slice(bodyStart, endIndex)
  // The end printf writes a newline BEFORE its marker; drop exactly that one
  // and keep whatever newline the command itself produced.
  if (stdout.endsWith('\n')) stdout = stdout.slice(0, -1)
  return { stdout, exitCode: Number(status[1]), lostPrefix: beginIndex < 0 }
}

/**
 * Whether a frame's END marker is already visible in the accumulated text.
 * A cheap pre-check used to decide when to run the full parse.
 * @param text - accumulated stdout for the current call.
 * @param marker - the markers for this call.
 * @returns true once the end marker appears.
 */
export function hasEndMarker(text: string, marker: FrameMarker): boolean {
  return text.includes(marker.end)
}
