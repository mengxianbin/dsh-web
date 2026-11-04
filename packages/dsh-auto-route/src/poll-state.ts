/**
 * Poll-health state file (2026-11-04 ruling: sustained meter-poll failure is
 * an availability fact for the 安康盾). The controller writes ONE small JSON
 * to `<dsh-home>/auto-route-poll-state.json` after EVERY tick — success or
 * failure — because the reader judges writer liveness by mtime: a write per
 * tick (≤60 s cadence) is what proves the loop is still running.
 *
 * Cross-repo contract, duty-file style (m-note duty-inventory-state.json is
 * the precedent): this package only publishes facts (`ok`, `failingSince`,
 * the error text); the sustained threshold and every alarm verdict live in
 * the harness reader (`session-controller/src/auto-route.ts`), so the shield
 * policy sits next to its consumer. The reader counterpart documents the
 * same file name — keep the two constants in sync.
 *
 * Best-effort by design: a failed write is swallowed (returns quietly) — the
 * reader then reads the file absent/stale and drops the plane, never a false
 * red. A state-file hiccup must never bubble into the poll loop.
 * @module dsh-auto-route/poll-state
 */

import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'

/** Ledger filename under the DSH home; mirrored by the harness reader. */
export const POLL_STATE_FILE = 'auto-route-poll-state.json'

/** One tick's verdict, verbatim from the controller's `lastPoll`. */
export interface PollStateSnapshot {
  /** Epoch ms of this poll attempt (controller clock). */
  readonly at: number
  /** Whether the meter poll produced a reading. */
  readonly ok: boolean
  /** Failure detail (already bounded by the controller); absent while ok. */
  readonly error?: string
  /** First failure of the current consecutive streak; absent while ok. */
  readonly failingSince?: number
}

/**
 * Publish one tick's poll verdict (atomic replace: write temp, then rename,
 * so the reader never observes a half-written document).
 * @param state - the controller's latest `lastPoll`, facts only.
 */
export function writePollState(state: PollStateSnapshot): void {
  try {
    const path = join(dshHome(), POLL_STATE_FILE)
    const temp = `${path}.tmp`
    writeFileSync(temp, `${JSON.stringify(state)}\n`, 'utf8')
    renameSync(temp, path)
  } catch {
    // Best-effort: see module doc. The reader degrades to an absent plane.
  }
}

/**
 * Remove the ledger (plugin disabled or unloaded). Force-ignores absence;
 * errors are swallowed for the same best-effort reason — a leftover file
 * simply ages past the reader's freshness bound and drops out anyway.
 */
export function removePollState(): void {
  try {
    rmSync(join(dshHome(), POLL_STATE_FILE), { force: true })
  } catch {
    // Best-effort: see module doc.
  }
}
