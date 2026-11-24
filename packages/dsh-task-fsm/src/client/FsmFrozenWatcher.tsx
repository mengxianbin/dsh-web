/**
 * Frozen-open watcher (frozen-open-1123): an invisible occupant of
 * `conversation.input.overlay` that keeps one bound session's FSM view
 * fresh while its conversation is open. It renders nothing (zero visual
 * delta — the regression-green half), fetches once on mount (cold-cache
 * election right after a row click) and re-fetches every
 * {@link FROZEN_POLL_MS} so a freeze landing while the user watches, or a
 * wake clearing one, reaches the publish wiring within one tick. The
 * overlay seat stays mounted under an elected takeover (chain `overlay`
 * keeps the fallback mounted), so the poll keeps running in every composer
 * state — input bar, ask card, and the frozen card alike.
 *
 * Stop rule (fsm-poll-404-1124): a 404 answer means the session has no FSM
 * record, so this watcher stops polling silently — the endless 404 cadence
 * was pure waste (1322 log rows in one day) for sessions that never entered
 * the machine. The row's render/mount chain starts a fresh watcher when the
 * session later enters at E1. Every other failure (5xx / network / timeout)
 * keeps the cadence: fail-open, so a transient error never silences a live
 * session.
 * @module @linxin666/dsh-task-fsm/client/FsmFrozenWatcher
 */

import { useEffect } from 'react'
import { refreshFsmViewOutcome } from './api.ts'

/** Poll cadence while a conversation is open (ui-session heartbeat tick parity). */
export const FROZEN_POLL_MS = 5_000

/** Props: the bound session id handed over by the seat's inject face. */
export interface FsmFrozenWatcherProps {
  readonly sessionId?: string
}

/**
 * Poll one session's FSM view; renders nothing, always.
 * @param props - bound session identity from the seat inject face.
 * @returns null (no DOM).
 */
export function FsmFrozenWatcher({ sessionId }: FsmFrozenWatcherProps) {
  useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    let live = true
    let timer: ReturnType<typeof setInterval> | undefined
    const stopPolling = (): void => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const tick = (): void => {
      if (!live) return
      void refreshFsmViewOutcome(sessionId).then(({ notFound }) => {
        // Exactly 404 = no FSM record: stop this watcher's interval quietly
        // (no log, no state — a later E1 entry re-mounts a fresh watcher).
        // 5xx / network / timeout resolve notFound: false and keep polling.
        if (live && notFound) stopPolling()
        return notFound
      })
    }
    tick()
    timer = setInterval(tick, FROZEN_POLL_MS)
    return () => {
      live = false
      stopPolling()
    }
  }, [sessionId])
  return null
}
