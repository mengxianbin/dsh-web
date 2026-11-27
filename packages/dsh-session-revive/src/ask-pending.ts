/**
 * revive 唤醒前的 ask 卡态谓词 (revive-askcard-skip-1127): a session whose
 * tail still holds an unsettled ask card must not be nudged. The nudge burns
 * quota and breaks the waiting-on-human state (2026-11-26 crash-resume
 * evidence: "一旦有 revive 信息, 甚至轮尾 nudge, 都会打破【等人】状态"); the
 * card's answer or explicit skip settles it and the next re-check releases
 * the parked decision through the normal chain.
 *
 * Design notes:
 *   - data source = the harness's own user-questions projection, read from
 *     its durable mirror `<dsh-home>/storages/session_projcache/sessions/
 *     <id>.json` at `record.rows.userQuestions.val.questions.active` — the
 *     same projection the host-side A+ gate reads, so both gates share one
 *     predicate ("active, open/continued 任一" = `active.length > 0`; the
 *     projection's own schema only ever puts `open` / `continued` entries
 *     into `active`, and a legacy non-timed session never folds one in);
 *   - synchronous on purpose: the v2 machine's gates are sync, so the reader
 *     is pulled at gate time behind a short TTL cache — one read per TTL
 *     window, zero new timers, zero polling;
 *   - fail-closed, deliberately the OPPOSITE of `fsm-frozen.ts`: an
 *     unreadable / absent / shapeless projection reads as "cannot prove
 *     there is no card" (`unknown`) and parks the decision, because
 *     卡投影读不到 ≠ 无卡 — "no unsettled card opens a turn" is a
 *     correctness property, while the frozen gate trades on availability;
 *   - residual, documented the same way the boot sweep documents its own:
 *     the projection cache is write-behind (`writeIntervalMs` /
 *     `writeEveryEvents`; mandatory only at creation, `turn/end` and
 *     disposal), so a card opened inside that window may not be on disk yet
 *     and reads `clear`. A miss falls back to the host-side A+ gate (board
 *     note: 漏拦 → 退回 A+ 闸兜底不劣化); a hit is always honoured here.
 * @module dsh-session-revive/ask-pending
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'

/** Gate-time re-read ceiling: a burst of gate calls shares one file read. */
const TTL_MS = 1_000

/** What the reader could prove about one session's ask-card tail. */
export type AskPendingState =
  /** An unsettled card (`active` non-empty): the session waits for a human. */
  | 'pending'
  /** The projection is readable and proves there is no unsettled card. */
  | 'clear'
  /** The projection could not be read: fail-closed, treated as `pending`. */
  | 'unknown'

/** Structural view of one projection-cache file (version and shape drift tolerated). */
interface ProjectionCacheFile {
  readonly record?: { readonly rows?: ProjectionRows }
  readonly rows?: ProjectionRows
}

interface ProjectionRows {
  readonly userQuestions?: {
    readonly val?: { readonly questions?: { readonly active?: unknown } }
  }
}

/**
 * The id spellings one session's cache may live under: a canonical
 * `session-<uuid>` first (what every revive id already is, so a cache written
 * under it costs exactly one read), then the bare uuid. Mirrors the archive
 * inventory's `projcacheSpellings`.
 * @param id - the session id the gate is evaluating.
 * @returns file-name spellings to try, in order.
 */
function spellings(id: string): readonly string[] {
  const canonical = id.startsWith('session-') ? id : `session-${id}`
  const bare = canonical.slice('session-'.length)
  return bare === canonical ? [canonical] : [canonical, bare]
}

/**
 * Read one session's ask-card state straight off disk.
 * @param dir - the projection-cache sessions directory.
 * @param sessionId - the session the gate is evaluating.
 * @returns `pending` / `clear` when a file proves one, else `unknown`.
 */
function readState(dir: string, sessionId: string): AskPendingState {
  for (const spelling of spellings(sessionId)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(dir, `${spelling}.json`), 'utf8'))
    } catch {
      // Unreadable under this spelling: try the other one, else fail closed.
      continue
    }
    const root = parsed as ProjectionCacheFile
    const active = (root.record ?? root).rows?.userQuestions?.val?.questions?.active
    // Shapeless for this predicate (no cache yet, no projection row, drift):
    // keep trying the other spelling, then fail closed.
    if (!Array.isArray(active)) continue
    // `active` holds only `open` / `continued` entries by schema, so non-empty
    // = an unsettled card at the tail. An entry whose state we do not
    // recognise still counts as unsettled — the fail-closed side wins.
    return active.length > 0 ? 'pending' : 'clear'
  }
  return 'unknown'
}

/**
 * Build the ask-card reader the machine gates call.
 * @param options - test seams: explicit cache directory and clock.
 * @returns a sync source of one session's ask-card state.
 */
export function makeAskPendingReader(
  options: { dir?: string; now?: () => number } = {},
): (sessionId: string) => AskPendingState {
  const dir = options.dir ?? join(dshHome(), 'storages', 'session_projcache', 'sessions')
  const now = options.now ?? (() => Date.now())
  const cache = new Map<string, { at: number; state: AskPendingState }>()
  return (sessionId: string): AskPendingState => {
    // No id to resolve a cache file from: fail closed, never "no card".
    if (typeof sessionId !== 'string' || sessionId === '') return 'unknown'
    const at = now()
    const hit = cache.get(sessionId)
    if (hit !== undefined && at - hit.at < TTL_MS) return hit.state
    const state = readState(dir, sessionId)
    cache.set(sessionId, { at, state })
    return state
  }
}
