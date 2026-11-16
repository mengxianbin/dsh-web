/**
 * Seal (收口) read layer — the single six-value grouping implementation of
 * this plugin (contract C1: 分组实现全插件仅此一份). The REST hard gate and
 * the native dialog consume the same judgement: the dialog reads it through
 * `POST /seal-check`, the gate calls it directly, so the two channels can
 * never disagree.
 *
 * Criteria and vocabulary are copied 1:1 from the m-note preflight scanner
 * `scripts/dsh/session-sentinel-scan.mjs` (main tree, 入册 2026-10-26):
 * `SAVE_STATUS` three values, the LEGACY cut (2026-10-26), the save-trace
 * regex, "stale = a sentinel in an earlier turn while the last turn
 * continues the conversation", and the last-turn gate (seal-lastturn-1113,
 * 2026-11-14, extending the last-line gate seal-judge-lastline-1106): the
 * sentinel only ever counts in a **last non-empty trimmed line** of an
 * assistant message inside the last turn (turn = the events after the
 * transcript's last `user/message`), scanned newest-first so the newest
 * signal-bearing line decides — the endorsement-line form, isomorphic to
 * the save SKILL's "sentinel line = the completion report's last line".
 * The decode method follows
 * `content/tech/ai/session-forensics.md` 场景十六: magic-scan the zstd frame
 * headers and decompress frame by frame with `node:zlib`
 * (`zstdDecompressSync`) — transcripts are append-only multi-frame files.
 *
 * Transcript location reuses the sessions-root directory index of
 * `host/session-files.ts`; inside the session dir the numerically highest
 * generation file (`session.vN.jsonl[.zstd]`, generation 0 = `session.jsonl`)
 * is the current transcript — harness migrations rewrite the newest
 * generation with the inherited history, so it alone carries the full event
 * sequence. Anything unlocvable or undecodable degrades to `UNKNOWN`
 * (fail-closed: the gate never green-lights what it cannot read).
 * @module @linxin666/dsh-session-archive/host/seal
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SealCheckResult, SealVerdict } from '../core/types.ts'

// ---- Vocabulary copied from scripts/dsh/session-sentinel-scan.mjs ----

/** Save-flow traces anywhere in a message. */
export const SAVE_TRACE = /SAVE_STATUS=|commit 验证|## \u2705 执行完成|### 候选 #|保存状态/
/** The sentinel itself: SAVE_STATUS=DONE / PENDING(n) / N_A. */
export const SENTINEL = /SAVE_STATUS=(DONE|PENDING\((\d+)\)|N_A)/
/** Sentinel cut-in date; save sessions last touched before it read as LEGACY. */
export const SENTINEL_ERA_START = Date.parse('2026-10-26T00:00:00+08:00')

/**
 * Work traces anywhere in the transcript (补法, decision-log 2026-11-04T16:27
 * Effect(1), landed 2026-11-05): a backticked commit hash (same heuristic as
 * the scanner's HASH_RE, board-row落点头 style — bare hex would collide with
 * epoch-ms timestamps) or board-backfill features (taskRef / 随注 / 落点头 /
 * tasks.md# anchor). Present with no sentinel and no save trace = real work
 * without a save, so it must not fall into the default-pass NEUTRAL tier.
 * Mirrors `WORK_TRACE` in scripts/dsh/session-sentinel-scan.mjs (contract C1).
 */
export const WORK_TRACE = /`[0-9a-f]{7,40}`|taskRef|随注|落点头|tasks\.md#/

/** Detail code of the degraded pass-through tier (裁定① stale 分两档). */
export const STALE_DETAIL = 'sentinel-stale'

/** Machine detail codes, matching the scanner's vocabulary (annotations stripped for the wire). */
const DETAIL = {
  sentinelOk: 'sentinel-ok',
  noArtifacts: 'no-artifacts-by-design',
  pending: 'sentinel-pending',
  saveTail: 'save-tail-no-sentinel',
  saveTrace: 'save-trace-no-sentinel',
  stale: STALE_DETAIL,
  noSaveTrace: 'no-save-trace',
  workTrace: 'work-trace-no-sentinel',
  noEndorsement: 'no-endorsement',
  legacy: 'legacy-save-no-sentinel',
  transcriptNotFound: 'transcript-not-found',
  decodeFail: 'decode-fail',
  emptyTranscript: 'empty-transcript',
} as const

/** Green verdicts archive without friction (contract C2 绿组). */
const GREEN_VERDICTS: ReadonlySet<SealVerdict> = new Set<SealVerdict>(['DONE', 'N_A', 'NEUTRAL', 'LEGACY'])

/** True when a verdict belongs to the green tier (archives as usual). */
export function isGreenSeal(verdict: SealVerdict): boolean {
  return GREEN_VERDICTS.has(verdict)
}

/** True for the stale tier: unsealed-but-pass-through (sentinel earlier, conversation continued). */
export function isStaleSeal(result: { readonly verdict: SealVerdict; readonly detail: string }): boolean {
  return result.verdict === 'UNSEALED' && result.detail === STALE_DETAIL
}

/**
 * Ledger marker for one seal result (contracts C2/C4): the stale tier keeps
 * the pinned `"stale"` marker, every other verdict records `"<VERDICT>:<detail>"`
 * so one string carries the whole judgement.
 */
export function sealMarker(result: { readonly verdict: SealVerdict; readonly detail: string }): string {
  return isStaleSeal(result) ? 'stale' : `${result.verdict}:${result.detail}`
}

// ---- Multi-frame zstd decoding (session-forensics.md 场景十六) ----

/** Offsets of every zstd magic number; each frame runs to the next magic or EOF. */
function frames(buffer: Buffer): Array<[number, number]> {
  const magic: number[] = []
  for (let index = 0; index + 4 <= buffer.length; index++) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xB5 && buffer[index + 2] === 0x2F && buffer[index + 3] === 0xFD) {
      magic.push(index)
    }
  }
  return magic.map((start, frame) => [start, frame + 1 < magic.length ? magic[frame + 1] : buffer.length])
}

function decodeBuffer(file: string, buffer: Buffer): string {
  if (!file.endsWith('.zstd')) return buffer.toString('utf8')
  let text = ''
  for (const [start, end] of frames(buffer)) {
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch {
      // A torn tail frame (append in flight) is skipped, as by the scanner.
    }
  }
  return text
}

// ---- Transcript location ----

const TRANSCRIPT_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/**
 * The current transcript inside one session dir: numerically highest
 * generation, `.jsonl.zstd` preferred over plain `.jsonl` at the same
 * generation. Anything else in the dir is ignored.
 */
export function latestTranscriptPath(dir: string): string | undefined {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  let best: { path: string; version: number; zstd: boolean } | undefined
  for (const name of names) {
    const match = TRANSCRIPT_NAME.exec(name)
    if (match === null) continue
    const version = match[1] === undefined ? 0 : Number.parseInt(match[1], 10)
    const candidate = { path: join(dir, name), version, zstd: match[2] !== undefined }
    if (
      best === undefined
      || candidate.version > best.version
      || (candidate.version === best.version && candidate.zstd && !best.zstd)
    ) {
      best = candidate
    }
  }
  return best?.path
}

// ---- Message extraction (copied from the scanner's assistantText) ----

function messageText(event: { data?: unknown }): string {
  const blocks = (event.data as { message?: { content?: unknown } } | undefined)?.message?.content
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (typeof block === 'string') out += block + '\n'
    else if ((block as { type?: unknown; text?: unknown })?.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      out += (block as { text: string }).text + '\n'
    }
  }
  return out
}

/**
 * 末行闸 (seal-judge-lastline-1106, 2026-11-06): a message's **last line** =
 * its last non-empty trimmed line (the endorsement-line form; isomorphic to
 * the save SKILL's "sentinel line = the completion report's last line").
 */
function lastLineOf(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line !== '') return line
  }
  return ''
}

/**
 * One direct judgement: the verdict, its detail, and the message whose last
 * line carried the signal (the endorsement recheck reads that message, not
 * whatever happens to be last in the turn).
 */
interface JudgeHit {
  readonly verdict: SealVerdict
  readonly detail: string
  readonly message: string
}

/**
 * Judge the last turn's assistant messages, newest first; null = no direct
 * signal (caller consults the whole transcript).
 *
 * Last-turn gate (seal-lastturn-1113, 2026-11-14, extends the last-line gate
 * seal-judge-lastline-1106): the search scope is each assistant message's
 * **last non-empty trimmed line** inside the last turn (turn = the events
 * after the transcript's last `user/message`), scanned newest-first so the
 * newest signal-bearing line decides — a save completed earlier in the same
 * turn stays DONE when a trailing message follows (the repeat step the gate
 * used to demand), while a sentinel before the last turn still reads stale.
 * The endorsement-line form, the three-value judgement, the SAVE_TRACE
 * fallback and the caller's WORK_TRACE/LEGACY split keep their logic
 * unchanged, so prose quotes of `SAVE_STATUS=` in a body still never read
 * green (verbatim-same as the scanner's `judge()`, contract C1).
 */
function judge(messages: readonly string[]): JudgeHit | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const line = lastLineOf(messages[index])
    const lastMatch = [...line.matchAll(new RegExp(SENTINEL, 'g'))].pop()
    if (lastMatch) {
      const value = lastMatch[1]
      if (value === 'DONE') return { verdict: 'DONE', detail: DETAIL.sentinelOk, message: messages[index] }
      if (value === 'N_A') return { verdict: 'N_A', detail: DETAIL.noArtifacts, message: messages[index] }
      return { verdict: 'UNSEALED', detail: DETAIL.pending, message: messages[index] }
    }
    if (SAVE_TRACE.test(line)) return { verdict: 'UNSEALED', detail: DETAIL.saveTail, message: messages[index] }
  }
  return null
}

// ---- Analysis ----

/**
 * One memoized verdict for one transcript file (seal-analyzeseal-cache-1110):
 * the stamp that was observed **before** the read pairs with the result the
 * read produced, so an append that lands mid-read can only cause the next
 * call to miss and recompute — never to serve pre-append content under a
 * post-append stamp.
 */
interface SealMemoEntry {
  readonly mtimeMs: number
  readonly size: number
  readonly result: SealCheckResult
}

/**
 * Transcript path -> last verdict for that file, bounded LRU (insertion
 * order, a hit is re-inserted, the oldest entry drops at the cap). The cap
 * sits above the live session count (~1900) so ordinary traffic never
 * evicts, while a churn of ids cannot grow the map without bound.
 */
const sealMemo = new Map<string, SealMemoEntry>()
const SEAL_MEMO_MAX = 4096
let sealMemoHits = 0
let sealMemoMisses = 0

/** Drop every memoized verdict and zero the counters (a full reset for tests). */
export function clearSealMemo(): void {
  sealMemo.clear()
  sealMemoHits = 0
  sealMemoMisses = 0
}

/** Memo counters (hits/misses count stamp-eligible calls only); diagnostics for tests. */
export function sealMemoStats(): { hits: number; misses: number; size: number } {
  return { hits: sealMemoHits, misses: sealMemoMisses, size: sealMemo.size }
}

function memoPut(file: string, stamp: { readonly mtimeMs: number; readonly size: number }, result: SealCheckResult): void {
  sealMemo.delete(file)
  sealMemo.set(file, { mtimeMs: stamp.mtimeMs, size: stamp.size, result })
  if (sealMemo.size > SEAL_MEMO_MAX) {
    const oldest = sealMemo.keys().next()
    if (!oldest.done) sealMemo.delete(oldest.value)
  }
}

/** Caller options for one seal analysis (archive-seal-falsered-1116 段2). */
export interface AnalyzeSealOptions {
  /**
   * Re-probe the endorsement even when the memo holds a `no-endorsement` red
   * (点击门重探): that verdict is a git state, not a transcript state, so the
   * click-time channels (seal-check with `recheck`, the REST archive gate, the
   * override write-back) never serve it frozen to the transcript stamp — one
   * transient probe failure used to stick until the next append (2026-11-16
   * false red). Every other memoized verdict keeps its window; lamp pulls omit
   * the flag.
   */
  readonly recheck?: boolean
}

/**
 * Run the six-value grouping for one session. `dir` comes from the sessions-root
 * directory index (`host/session-files.ts`); `undefined` (no dir) and every
 * read/decode failure degrade to `UNKNOWN`.
 *
 * `followUpCount` (stale rows only) counts the chat messages — `user/message`
 * plus `assistant/message` events — that occur after the last sentinel-bearing
 * assistant message: "save 后续聊 N 条" for the one-line pass-through notice.
 *
 * Result memo (seal-analyzeseal-cache-1110): both channels of contract C1 call
 * this one function — the `POST /seal-check` endpoint through
 * `service.sealCheck` and the archive gate directly — so a memo here is
 * automatically shared by the whole endpoint face (板行动作③). The key is the
 * transcript's absolute path plus its `mtime + size` observed **before** the
 * read; an append changes both, so the next call recomputes with zero explicit
 * invalidation (same invalidation rule as the seal-light per-session cache:
 * 转录 append 即作废重算). Read/decode failures are never memoized — they are
 * transient (lock, torn open) and must retry on the next call.
 *
 * The endorsement recheck's git verdict and the stamp window
 * (archive-seal-falsered-1116 段2): a memoized `no-endorsement` is a **git
 * state**, not a transcript state, and one transient probe failure used to
 * freeze that red until the next append (the 2026-11-16 false red). Callers
 * that decide at click time — the seal-check endpoint with `recheck`, the
 * REST archive gate, the override write-back — pass {@link AnalyzeSealOptions.recheck}
 * and never serve that red from the memo: it is re-derived, git re-probed.
 * Lamp pulls omit the flag and keep the memo window (板行四问②：重探只在判红
 * 时触发、灯查频度不变); the conservative direction is unchanged — a red can
 * only become fresher, never a false green.
 */
export function analyzeSeal(id: string, dir: string | undefined, options?: AnalyzeSealOptions): SealCheckResult {
  if (dir === undefined) return { id, verdict: 'UNKNOWN', detail: DETAIL.transcriptNotFound }
  const file = latestTranscriptPath(dir)
  if (file === undefined) return { id, verdict: 'UNKNOWN', detail: DETAIL.transcriptNotFound }

  // Stamp before read, on purpose: a stamp taken after the read could pair a
  // post-append key with pre-append content and serve that stale verdict
  // forever; a pre-append key with post-append content only forces the next
  // call to recompute (the safe direction).
  let stamp: { readonly mtimeMs: number; readonly size: number } | undefined
  try {
    const stat = statSync(file)
    stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    // No stamp -> no memo: a stat failure must never pin a verdict.
  }

  if (stamp !== undefined) {
    const hit = sealMemo.get(file)
    // 段2 点击门重探: a memoized no-endorsement is git-derived; a recheck
    // caller treats that hit as a miss and re-derives (git re-probe), so the
    // red never sticks to the transcript stamp on a decision channel.
    const staleGitRed = options?.recheck === true && hit?.result.detail === DETAIL.noEndorsement
    if (hit !== undefined && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size && !staleGitRed) {
      sealMemoHits += 1
      // Refresh the LRU position; the id is re-stamped so one file can never
      // answer under another session's id.
      sealMemo.delete(file)
      sealMemo.set(file, hit)
      return { ...hit.result, id }
    }
    sealMemoMisses += 1
  }

  const result = deriveSeal(id, file, stamp)
  if (stamp !== undefined && result.detail !== DETAIL.decodeFail) memoPut(file, stamp, result)
  return result
}

/** The uncached derivation: full read + decode + grouping for one transcript file. */
function deriveSeal(
  id: string,
  file: string,
  stamp: { readonly mtimeMs: number; readonly size: number } | undefined,
): SealCheckResult {
  let text: string
  try {
    text = decodeBuffer(file, readFileSync(file))
  } catch {
    return { id, verdict: 'UNKNOWN', detail: DETAIL.decodeFail }
  }
  if (!text) return { id, verdict: 'UNKNOWN', detail: DETAIL.emptyTranscript }

  // One pass: the last turn's assistant texts (a `user/message` restarts the
  // turn), save traces anywhere, earlier sentinels, and the chat-message count
  // at the last sentinel (for followUpCount).
  const turnMessages: string[] = []
  let saveTraceAnywhere = false
  let earlierSentinel = false
  let chatCount = 0
  let chatAtSentinel = 0
  let eventCount = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: { type?: unknown; data?: unknown }
    try {
      event = JSON.parse(trimmed) as { type?: unknown; data?: unknown }
    } catch {
      continue
    }
    eventCount += 1
    if (event.type === 'assistant/message') {
      chatCount += 1
      const t = messageText(event)
      if (t.trim()) {
        if (SAVE_TRACE.test(t)) saveTraceAnywhere = true
        if (SENTINEL.test(t)) {
          earlierSentinel = true
          chatAtSentinel = chatCount
        }
        turnMessages.push(t)
      }
    } else if (event.type === 'user/message') {
      chatCount += 1
      if (SAVE_TRACE.test(messageText(event))) saveTraceAnywhere = true
      // Every user message starts a new turn; the last-turn gate judges only
      // what accumulated after the final one (seal-lastturn-1113).
      turnMessages.length = 0
    }
  }
  // Text that parses to no events at all is "解不出" (contract: 解不出/找不到
  // = UNKNOWN), never a silent NEUTRAL pass; real transcripts always open with
  // a `session` root event.
  if (eventCount === 0) return { id, verdict: 'UNKNOWN', detail: DETAIL.emptyTranscript }

  // LEGACY cut: the file's last write before the sentinel era makes any
  // unsealed read a legacy save session (default-pass, no verdict asserted).
  // The stamp was taken before the read (analyzeSeal); a missing stamp reads
  // 0 -> judged by the strict modern rules (conservative), same as a stat
  // failure did before the memo existed.
  const lastTs = stamp?.mtimeMs ?? 0
  const legacy = lastTs > 0 && lastTs < SENTINEL_ERA_START
  const legacyRow = (): SealCheckResult => ({ id, verdict: 'LEGACY', detail: DETAIL.legacy })

  const direct = judge(turnMessages)
  if (direct !== null) {
    if (direct.verdict === 'UNSEALED' && legacy && !direct.detail.startsWith(DETAIL.pending)) return legacyRow()
    // Post-verdict endorsement downgrade (seal-noendorse-green-1106): a DONE
    // verdict whose endorsement recheck fails leaves the green tier, so a bare
    // `SAVE_STATUS=DONE` (AI self-assessment without save-status.py backing)
    // goes dark at the light and turns the archive gate into a confirmation.
    // N_A never runs the recheck (zero-output exemption, scanner --recheck 同口径).
    // The recheck reads the message that carried the signal — under the
    // last-turn gate it may sit earlier in the turn than the final message.
    if (direct.verdict === 'DONE') {
      let endorsement = checkEndorsement(direct.message, text)
      // archive-seal-falsered-1116 段2b (当场重试一次再判红): a git probe that
      // failed (timeout / spawn / non-zero exit, each logged by gitRun) is not
      // an answer, so the whole recheck reruns once on the spot before the red
      // is judged. Parse-level refusals (no `commits=`, a self-inconsistent
      // declared list) ran no probe and keep their single fail-closed pass;
      // the retry costs one extra probe round on the failure path only
      // (板行四问①预批：仅失败路径多一轮 git 探针).
      if (!endorsement.holds && endorsement.probeFailed) {
        endorsement = checkEndorsement(direct.message, text)
      }
      if (!endorsement.holds) {
        return { id, verdict: 'UNSEALED', detail: DETAIL.noEndorsement }
      }
    }
    return { id, verdict: direct.verdict, detail: direct.detail }
  }
  if (saveTraceAnywhere || earlierSentinel) {
    if (legacy) return legacyRow()
    if (earlierSentinel) {
      // Stale tier: a save completed earlier, the conversation continued after it.
      return { id, verdict: 'UNSEALED', detail: DETAIL.stale, followUpCount: chatCount - chatAtSentinel }
    }
    return { id, verdict: 'UNSEALED', detail: DETAIL.saveTrace }
  }
  // 补法闸 (2026-11-05): no sentinel, no save trace, but the transcript shows
  // real work (commit hash / board backfill) — UNSEALED instead of the
  // default-pass NEUTRAL, so the gate never silently swallows it.
  if (WORK_TRACE.test(text)) return { id, verdict: 'UNSEALED', detail: DETAIL.workTrace }
  return { id, verdict: 'NEUTRAL', detail: DETAIL.noSaveTrace }
}

// ---- Endorsement recheck (seal-noendorse-green-1106, save 可靠性批3 ②) ----

/**
 * Backticked commit hashes anywhere in a message — the scanner's `HASH_RE`
 * heuristic (board-row 落点头 style; bare hex would collide with epoch-ms
 * timestamps). `matchAll` clones the regex, so the shared /g pattern is safe.
 */
const HASH_RE = /`([0-9a-f]{7,40})`/g

/** The DONE sentinel's own line: the script endorsement tail rides on it. */
const DONE_TAIL_RE = /SAVE_STATUS=DONE([^\r\n]*)/g

/** One git probe's outcome; a failure carries a distinguishable cause (archive-seal-falsered-1116 段1). */
export type GitRunResult =
  | { readonly ok: true; readonly out: string }
  | { readonly ok: false; readonly cause: GitRunCause; readonly detail: string }

/** The causes the log distinguishes; `error` is the catch-all, never a bare swallow. */
export type GitRunCause = 'timeout' | 'spawn' | 'exit' | 'error'

/**
 * Classify one `execFileSync` failure into a loggable cause, per the shapes
 * this machine's node actually throws (2026-11-17 实测 via
 * `.tmp/gitrun-error-shape.mjs`): a non-zero exit carries
 * `status: <number>` plus stderr; a spawn failure carries a string `code`
 * (ENOENT…) with `status: null` and no stderr; a timeout kills the child
 * with SIGTERM under `code: 'ETIMEDOUT'` (also `status: null`). The stderr
 * tail travels with every cause so a fake `no-endorsement` red and a real
 * one are distinguishable from the log alone (archive-seal-falsered-1116 段1).
 * @param error - the caught execFileSync error.
 * @returns the cause plus a short detail carrying the stderr tail.
 */
export function classifyGitRunError(error: unknown): { cause: GitRunCause; detail: string } {
  const err = error as { code?: unknown; status?: unknown; signal?: unknown; stderr?: unknown; message?: unknown }
  const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : ''
  const lines = stderr === '' ? [] : stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const tail = lines.length > 0
    ? lines.slice(-3).join(' | ')
    : (typeof err.message === 'string' ? (err.message.split('\n')[0] ?? '') : String(error))
  if (typeof err.status === 'number') return { cause: 'exit', detail: `exit ${String(err.status)} — ${tail}` }
  if (err.code === 'ETIMEDOUT' || (err.code === undefined && err.signal === 'SIGTERM')) {
    return { cause: 'timeout', detail: `killed by ${typeof err.signal === 'string' ? err.signal : 'SIGTERM'} — ${tail}` }
  }
  if (typeof err.code === 'string') return { cause: 'spawn', detail: `${err.code} — ${tail}` }
  return { cause: 'error', detail: tail }
}

/**
 * Git probe with a logged, classified failure (archive-seal-falsered-1116 段1):
 * the old catch swallowed timeout / spawn failure / non-zero exit into a bare
 * `undefined` with zero logging, so a fake red was indistinguishable from a
 * real one. Every failure now warns once — `[seal-git]`, the cause, the exact
 * command, the repo, and the stderr tail — and success still reads the plain
 * output string (callers only ever needed "did it answer / what did it say").
 */
function gitRun(repo: string, args: readonly string[]): GitRunResult {
  try {
    return {
      ok: true,
      out: execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    const { cause, detail } = classifyGitRunError(error)
    console.warn(`[seal-git] ${cause}: git ${args.join(' ')} (repo=${repo}) — ${detail}`)
    return { ok: false, cause, detail }
  }
}

/**
 * The session's working directory from the transcript root event (real
 * transcripts open with a `session` root carrying `cwd`), so a save in
 * m-note-sized repos resolves to its own repo first.
 */
function sessionCwd(transcript: string): string | undefined {
  const newline = transcript.indexOf('\n')
  const first = transcript.slice(0, newline === -1 ? undefined : newline).trim()
  if (!first.startsWith('{')) return undefined
  try {
    const event = JSON.parse(first) as { type?: unknown; cwd?: unknown; data?: { cwd?: unknown } }
    if (event.type !== 'session') return undefined
    const cwd = typeof event.cwd === 'string' ? event.cwd : event.data?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/** Repo candidates, mirroring the scanner's `recheckDone`: session cwd → harness root → dsh-web root. */
function repoCandidates(transcript: string): string[] {
  const roots = [
    sessionCwd(transcript),
    process.env.HARNESS_ROOT ?? 'D:\\tech\\deepseek-harness',
    process.env.DSHWEB_ROOT ?? 'D:\\tech\\dsh-web',
  ]
  return [...new Set(roots.filter((repo): repo is string => repo !== undefined && repo !== ''))]
}

/**
 * One endorsement recheck's verdict (archive-seal-falsered-1116 段2b):
 * `holds` is the fail-closed verdict; `probeFailed` records whether any git
 * probe failed (timeout / spawn / non-zero exit) instead of answering — the
 * caller reruns the whole check once on that signal before judging red.
 */
interface EndorsementCheck {
  readonly holds: boolean
  readonly probeFailed: boolean
}

/**
 * DONE endorsement recheck — the two existing pieces only (照抄 the m-note
 * scanner's `recheckDone` 口径; the six-dim fields belong to save-done5-1106):
 * 1. the sentinel's own line carries a script backing `commits=n/n`;
 * 2. every **declared** hash exists in a candidate repo (`cat-file -e`)
 *    with a remote-tracking ref containing it (`branch -r --contains`).
 * 声明-核验同源 (seal-declare-verify-1107, C1 1:1 with the scanner): when the
 * judgment tail carries `hashes=<h1,h2,…>` (save-status.py's declared list),
 * only that list is verified — prose hashes outside every declared list are
 * ignored (弃用/引用/他仓 hash 一概不核). Each declaring tail must also be
 * self-consistent (`commits=n/n` length == list length), else fail-closed.
 * A judgment tail without `hashes=` (legacy format) keeps the old
 * message-wide scan, so pre-existing sessions behave exactly as before.
 * Fail-closed throughout: any missing piece reads false, so an unbacked
 * DONE never stays green.
 *
 * Probe accounting (段2b): a candidate repo that rejects `cat-file -e` and a
 * `branch -r --contains` that errors both count as `probeFailed` — they are
 * git refusing to answer, not a clean "nobody contains this hash" (an empty
 * exit-0 `--contains` list is the clean negative and sets no flag). A red
 * whose probes all failed is retried once by {@link deriveSeal} before the
 * `no-endorsement` verdict is judged.
 */
function checkEndorsement(message: string, transcript: string): EndorsementCheck {
  const tails = [...message.matchAll(DONE_TAIL_RE)].map((match) => match[1])
  const tail = tails[tails.length - 1] ?? ''
  if (!/commits=\d+\/\d+/.test(tail)) return { holds: false, probeFailed: false }
  let hashes: string[]
  if (/\bhashes=/.test(tail)) {
    // Declared mode: verify the declared lists only; each list must match its
    // own commits=n/n (防伪：commits 与清单长度不符仍红).
    const declared: string[] = []
    for (const candidate of tails) {
      const hit = /\bhashes=([^\s]*)/.exec(candidate)
      if (hit === null) continue
      // Lexical-decoration stripping (seal-hash-backtick-1108 leading/trailing
      // → seal-backtick-miditem-1108 in-item truncation): first strip leading
      // backticks/whitespace (item-level wrapping), then truncate at the first
      // non-hex character (mid-item sticking: a closing backtick followed by
      // prose like 「（`save-status`」 or 「（贴行闸」 — edge stripping cannot
      // reach the middle). Tolerance is formatting-only, never content: the
      // truncated item must still match ^[0-9a-f]{7,40}$ before it reaches
      // git, and any non-hex/too-short item fails closed (never silently
      // dropped). Prefix truncation ≠ loose hex-substring extraction — no
      // picking hex fragments out of arbitrary positions (防伪不降级).
      const list = hit[1].split(',').filter(Boolean).map((item) => (item.replace(/^[`\s]+/, '').match(/^[0-9a-f]*/) ?? [''])[0])
      if (list.some((item) => !/^[0-9a-f]{7,40}$/.test(item))) return { holds: false, probeFailed: false }
      const commits = /\bcommits=(\d+)\/(\d+)/.exec(candidate)
      if (commits === null || commits[1] !== commits[2] || Number(commits[2]) !== list.length) return { holds: false, probeFailed: false }
      declared.push(...list)
    }
    hashes = [...new Set(declared)]
    if (hashes.length === 0) return { holds: false, probeFailed: false }
  } else {
    // Legacy tail (no hashes=): full message scan, unchanged from before.
    hashes = [...new Set([...message.matchAll(HASH_RE)].map((match) => match[1]))]
    if (hashes.length === 0) return { holds: false, probeFailed: false }
  }
  const repos = repoCandidates(transcript)
  let probeFailed = false
  for (const hash of hashes) {
    let home: string | undefined
    for (const repo of repos) {
      const probe = gitRun(repo, ['cat-file', '-e', `${hash}^{commit}`])
      if (probe.ok) {
        home = repo
        break
      }
      probeFailed = true
    }
    if (home === undefined) return { holds: false, probeFailed }
    const refsProbe = gitRun(home, ['branch', '-r', '--contains', hash])
    if (!refsProbe.ok) return { holds: false, probeFailed: true }
    const refs = refsProbe.out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.includes('->'))
    // Clean negative: the probe answered (exit 0) and no remote ref carries
    // the hash — deterministic, nothing to retry.
    if (refs.length === 0) return { holds: false, probeFailed }
  }
  return { holds: true, probeFailed }
}
