/**
 * The off-loop seal analysis for the click-time channels (stall-rootcause-1123):
 * `POST /seal-check` used to run the whole judgement synchronously on the Host
 * main thread — a cold round is a multi-megabyte zstd decode plus a line scan
 * plus the git probe, measured at 0.5–2.8s per call on live transcripts, and
 * every one of those seconds is a stall the event-loop monitor sees as a
 * ~2s spike (取证: access-log 慢请求与卡顿窗重叠 8% 份额、其余 92% 为定时器面).
 *
 * The split keeps the cheap half cheap and moves only the expensive half:
 * {@link probeSeal} (dir/file resolve, pre-read stamp, memo hit) still runs
 * inline, so a memoized verdict answers at exactly its old latency; a MISS
 * hands the derive to the existing worker seam ({@link computeSealInWorker}),
 * whose isolation cell was built for this exact disease ("解压 = seal-check
 * 慢同款病"). The parent memoizes the worker's verdict under the PRE-read
 * stamp it took — the safe-direction pairing `analyzeSeal` documents — so the
 * next plain ask hits the memo as before.
 *
 * Infra failures (worker script missing / budget exceeded / crash) degrade to
 * `UNKNOWN` with the machine detail, the same fail-visible shape the turn/end
 * path stamps: a verdict is never fabricated, and the archive gate's
 * fail-closed refusal semantics are unchanged.
 * @module @linxin666/dsh-session-archive/host/seal-async
 */

import { computeSealInWorker, SealComputeError } from './seal-state.ts'
import { memoPutSeal, probeSeal, type AnalyzeSealOptions } from './seal.ts'
import type { SealCheckResult } from '../core/types.ts'

/**
 * Run one seal analysis with the derive off the main thread.
 * @param id - the session the verdict is for.
 * @param dir - its transcript directory from the sessions-root probe.
 * @param options - click-time options (`recheck` travels to the worker).
 * @returns the six-value grouping; memo hits and unlocatable ids answer
 *   inline, misses answer from the worker, infra failures degrade to
 *   `UNKNOWN` + machine detail (fail-visible, never a fabricated verdict).
 */
export async function analyzeSealAsync(
  id: string,
  dir: string | undefined,
  options?: AnalyzeSealOptions,
): Promise<SealCheckResult> {
  const probe = probeSeal(id, dir, options)
  if (probe.kind === 'answer') return probe.result
  let result: SealCheckResult
  try {
    result = await computeSealInWorker(id, dir, options)
  } catch (error) {
    const detail = error instanceof SealComputeError ? error.detail : 'worker-error'
    return { id, verdict: 'UNKNOWN', detail }
  }
  if (probe.stamp !== undefined) memoPutSeal(probe.file, probe.stamp, result)
  return result
}
