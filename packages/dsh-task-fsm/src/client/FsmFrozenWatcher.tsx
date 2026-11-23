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
 * @module @linxin666/dsh-task-fsm/client/FsmFrozenWatcher
 */

import { useEffect } from 'react'
import { refreshFsmView } from './api.ts'

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
    const tick = (): void => {
      if (live) void refreshFsmView(sessionId)
    }
    tick()
    const timer = setInterval(tick, FROZEN_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [sessionId])
  return null
}
