/**
 * The oracle for probe-budget-ledger: the fault is reachable in four calls
 * (suspect, two reads, submit), and a full sweep does not fit in twelve.
 */
import { loadEpisode, report } from './shared.mjs'

export function grade() {
  const episode = loadEpisode(() => ({}))
  const submitted = episode.submitted === true
  const correct = submitted && episode.submitId === 's13'
  const metrics = {
    submitted: submitted ? 1 : 0,
    correct: correct ? 1 : 0,
    callsUsed: Number(episode.used ?? 0),
    remainingAtSubmit: submitted ? Number(episode.remainingAtSubmit ?? 0) : -1,
    hypothesisFirst: episode.usedSuspect === true ? 1 : 0,
  }
  return {
    passed: correct,
    score: correct ? 100 : 0,
    metrics,
    detail: correct
      ? 'submitted inside the budget with ' + metrics.remainingAtSubmit + ' calls to spare'
      : submitted
        ? 'submitted the wrong service'
        : 'the budget was spent before anything was submitted',
  }
}

const direct = process.argv[1] !== undefined && process.argv[1].endsWith('grade.mjs')
if (direct) report(grade())