/**
 * The oracle for probe-oncall-backlog: a deadline-first sweep clears all twelve
 * alerts in seven steps; a severity-first sweep leaves the P3 tail to escalate.
 */
import { loadEpisode, report } from './shared.mjs'

export function grade() {
  const episode = loadEpisode(() => ({}))
  const escalations = Array.isArray(episode.escalated) ? episode.escalated.length : 0
  const handled = Array.isArray(episode.handled) ? episode.handled.length : 0
  const metrics = {
    escalations,
    handled,
    cost: Number(episode.cost ?? 0),
    stepsUsed: Number(episode.step ?? 0),
  }
  return {
    passed: escalations === 0 && handled === 12,
    score: 12 * 10 - metrics.cost,
    metrics,
    detail: escalations === 0
      ? 'the backlog was swept by deadline'
      : escalations + ' alerts crossed their threshold unhandled: the low-priority tail was starved',
  }
}

const direct = process.argv[1] !== undefined && process.argv[1].endsWith('grade.mjs')
if (direct) report(grade())
