/**
 * §6.3 唤醒对账 (freeze-reclaim-design-1127 Phase 1): the revive gate's
 * synchronous view of the task FSM's frozen sessions. A frozen/locked
 * session must never be auto-woken — the observed failure this seals is the
 * revive-vs-E7 conflict (evidence 4: a frozen row kept running).
 *
 * Design notes:
 *   - synchronous on purpose: the v2 machine's gates are sync, so the view
 *     reads `task-fsm-state.json` directly (the same raw-persistence seam the
 *     boot sweep already reads for transcripts) behind a short TTL cache;
 *   - fail-open: an unreadable/absent authority reads as "nothing frozen" —
 *     availability first, mirroring the task-fsm watcher's own fail-open;
 *   - zero new timers: the reader is pulled at gate time only.
 * @module dsh-session-revive/fsm-frozen
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'

/** Gate-time re-read ceiling: a burst of gate calls shares one file read. */
const TTL_MS = 1_000

interface FsmSessionView {
  readonly id?: unknown
  readonly mode?: unknown
}

interface FsmRecord {
  readonly session?: FsmSessionView
}

interface FsmStateFile {
  readonly tasks?: Record<string, FsmRecord>
}

/**
 * Build the frozen-set reader the machine gates call.
 * @param options - test seams: explicit state path and clock.
 * @returns a sync source of the session ids currently frozen or locked.
 */
export function makeFrozenSetReader(
  options: { path?: string; now?: () => number } = {},
): () => ReadonlySet<string> {
  const file = options.path ?? join(dshHome(), 'task-fsm-state.json')
  const now = options.now ?? (() => Date.now())
  let cache: { at: number; set: ReadonlySet<string> } | undefined
  return () => {
    const at = now()
    if (cache !== undefined && at - cache.at < TTL_MS) return cache.set
    const set = new Set<string>()
    try {
      const state = JSON.parse(readFileSync(file, 'utf8')) as FsmStateFile
      for (const record of Object.values(state.tasks ?? {})) {
        const id = record.session?.id
        const mode = record.session?.mode
        // Both freeze modes gate: frozen (event wait / queue position) and
        // locked (long wait) — neither may be auto-woken. Session-less rows
        // (empty id) cannot match any revive session and are skipped.
        if (typeof id === 'string' && id !== '' && (mode === 'frozen' || mode === 'locked')) set.add(id)
      }
    } catch {
      // fail-open: no readable authority = nothing frozen (availability first).
    }
    cache = { at, set }
    return set
  }
}
