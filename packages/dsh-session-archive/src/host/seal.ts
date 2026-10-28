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
 * regex, and "stale = a sentinel in an earlier message while the last
 * assistant message continues the conversation". The decode method follows
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

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SealCheckResult, SealVerdict } from '../core/types.ts'

// ---- Vocabulary copied from scripts/dsh/session-sentinel-scan.mjs ----

/** Save-flow traces anywhere in a message. */
export const SAVE_TRACE = /SAVE_STATUS=|commit 验证|## ✅ 执行完成|### 候选 #|保存状态/
/** The sentinel itself: SAVE_STATUS=DONE / PENDING(n) / N_A. */
export const SENTINEL = /SAVE_STATUS=(DONE|PENDING\((\d+)\)|N_A)/
/** Sentinel cut-in date; save sessions last touched before it read as LEGACY. */
export const SENTINEL_ERA_START = Date.parse('2026-10-26T00:00:00+08:00')

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

/** Judge the last assistant message alone; null = no direct signal (caller consults the whole transcript). */
function judge(text: string): { verdict: SealVerdict; detail: string } | null {
  const lastMatch = [...text.matchAll(new RegExp(SENTINEL, 'g'))].pop()
  if (lastMatch) {
    const value = lastMatch[1]
    if (value === 'DONE') return { verdict: 'DONE', detail: DETAIL.sentinelOk }
    if (value === 'N_A') return { verdict: 'N_A', detail: DETAIL.noArtifacts }
    return { verdict: 'UNSEALED', detail: DETAIL.pending }
  }
  if (SAVE_TRACE.test(text)) return { verdict: 'UNSEALED', detail: DETAIL.saveTail }
  return null
}

// ---- Analysis ----

/**
 * Run the six-value grouping for one session. `dir` comes from the sessions-root
 * directory index (`host/session-files.ts`); `undefined` (no dir) and every
 * read/decode failure degrade to `UNKNOWN`.
 *
 * `followUpCount` (stale rows only) counts the chat messages — `user/message`
 * plus `assistant/message` events — that occur after the last sentinel-bearing
 * assistant message: "save 后续聊 N 条" for the one-line pass-through notice.
 */
export function analyzeSeal(id: string, dir: string | undefined): SealCheckResult {
  if (dir === undefined) return { id, verdict: 'UNKNOWN', detail: DETAIL.transcriptNotFound }
  const file = latestTranscriptPath(dir)
  if (file === undefined) return { id, verdict: 'UNKNOWN', detail: DETAIL.transcriptNotFound }

  let text: string
  try {
    text = decodeBuffer(file, readFileSync(file))
  } catch {
    return { id, verdict: 'UNKNOWN', detail: DETAIL.decodeFail }
  }
  if (!text) return { id, verdict: 'UNKNOWN', detail: DETAIL.emptyTranscript }

  // One pass: last assistant text, save traces anywhere, earlier sentinels, and
  // the chat-message count at the last sentinel (for followUpCount).
  let lastAssistant = ''
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
        lastAssistant = t
      }
    } else if (event.type === 'user/message') {
      chatCount += 1
      if (SAVE_TRACE.test(messageText(event))) saveTraceAnywhere = true
    }
  }
  // Text that parses to no events at all is "解不出" (contract: 解不出/找不到
  // = UNKNOWN), never a silent NEUTRAL pass; real transcripts always open with
  // a `session` root event.
  if (eventCount === 0) return { id, verdict: 'UNKNOWN', detail: DETAIL.emptyTranscript }

  // LEGACY cut: the file's last write before the sentinel era makes any
  // unsealed read a legacy save session (default-pass, no verdict asserted).
  let lastTs = 0
  try {
    lastTs = statSync(file).mtimeMs
  } catch {
    // stat failure -> 0 -> judged by the strict modern rules (conservative).
  }
  const legacy = lastTs > 0 && lastTs < SENTINEL_ERA_START
  const legacyRow = (): SealCheckResult => ({ id, verdict: 'LEGACY', detail: DETAIL.legacy })

  const direct = judge(lastAssistant)
  if (direct !== null) {
    if (direct.verdict === 'UNSEALED' && legacy && !direct.detail.startsWith(DETAIL.pending)) return legacyRow()
    return { id, ...direct }
  }
  if (saveTraceAnywhere || earlierSentinel) {
    if (legacy) return legacyRow()
    if (earlierSentinel) {
      // Stale tier: a save completed earlier, the conversation continued after it.
      return { id, verdict: 'UNSEALED', detail: DETAIL.stale, followUpCount: chatCount - chatAtSentinel }
    }
    return { id, verdict: 'UNSEALED', detail: DETAIL.saveTrace }
  }
  return { id, verdict: 'NEUTRAL', detail: DETAIL.noSaveTrace }
}
