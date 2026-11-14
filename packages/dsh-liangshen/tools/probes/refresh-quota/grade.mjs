/**
 * The oracle for probe-refresh-quota: one small batch reveals the lane rule and
 * three jobs per cycle fit (24 served); drying the whole backlog teaches nothing
 * and the cycle is spent holding.
 */
import { loadEpisode, report } from './shared.mjs'

export function grade() {
  const episode = loadEpisode(() => ({}))
  const served = Number(episode.served ?? 0)
  const driesUsed = Number(episode.driesUsed ?? 0)
  const metrics = {
    served,
    conflicts: Number(episode.conflicts ?? 0),
    holds: Number(episode.holds ?? 0),
    driesUsed,
    quotaUtilization: Math.round((driesUsed / 16) * 100) / 100,
  }
  return {
    passed: served >= 18 && metrics.conflicts === 0,
    score: Number(episode.score ?? 0),
    metrics,
    detail: served >= 18
      ? 'small informative batches reached the throughput'
      : 'served ' + served + ' of 24: the checks carried no information and the cycles were spent holding',
  }
}

const direct = process.argv[1] !== undefined && process.argv[1].endsWith('grade.mjs')
if (direct) report(grade())
