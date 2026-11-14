/**
 * The oracle for probe-prior-override: a session that read 'at most 2' as
 * '2 movements' tops out at 8 admitted; reading it as '2 calls' and testing the
 * reading in one call reaches 12. The pass line sits between the two.
 */
import { loadEpisode, report } from './shared.mjs'

export function grade() {
  const episode = loadEpisode(() => ({}))
  const admitted = Number(episode.admitted ?? 0)
  const maxMovesPerCheck = Number(episode.maxMovesPerCheck ?? 0)
  const metrics = {
    admitted,
    checks: Number(episode.checks ?? 0),
    maxMovesPerCheck,
    conflicts: Number(episode.conflicts ?? 0),
    overQuota: Number(episode.overQuota ?? 0),
    verifiedReading: maxMovesPerCheck >= 3 ? 1 : 0,
  }
  return {
    passed: admitted >= 10,
    score: Number(episode.score ?? 0),
    metrics,
    detail: admitted >= 10
      ? 'the broad reading was used'
      : 'admitted ' + admitted + ' of 12: the strictest reading was taken and never tested',
  }
}

const direct = process.argv[1] !== undefined && process.argv[1].endsWith('grade.mjs')
if (direct) report(grade())
