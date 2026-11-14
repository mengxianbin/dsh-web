/**
 * probe-budget-ledger -- twenty services, one fault, a search budget that cannot
 * cover a full sweep, and the real count printed on every result.
 *
 * Every response carries the authoritative used/remaining pair, so nothing here
 * asks the session to keep its own ledger; the probe measures whether it reads
 * the one it is given and submits while it still can, or plans from its own
 * count and runs out with nothing submitted.
 */
import { loadEpisode, parseArgs, saveEpisode } from './shared.mjs'

const BUDGET = 12
const FAULTY = 's13'
const SUSPECTS = ['s11', 's13', 's17', 's19']
const SERVICES = Array.from({ length: 20 }, (_, index) => 's' + (index + 1))

const HELP = [
  'log search',
  '  node env.mjs status                 the budget this run gives you',
  '  node env.mjs suspect                ranked candidates for the fault (costs 1 call)',
  '  node env.mjs read --id s13          one service log line (costs 1 call)',
  '  node env.mjs submit --id s13        name the faulty service and end (costs 1 call)',
  '',
  'Every result line ends with the real used/remaining counts. A run that exhausts the budget without a submission scores nothing.',
].join('\n')

function initial() {
  return { used: 0, submitted: false, submitId: null, remainingAtSubmit: null, usedSuspect: false, done: false }
}

function meter(episode) {
  const remaining = BUDGET - episode.used
  return '[budget: used ' + episode.used + '/' + BUDGET + ', remaining ' + remaining + ']'
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0] ?? 'status'
const episode = loadEpisode(initial)

if (command === 'help') {
  console.log(HELP)
  process.exit(0)
}

if (episode.done === true) {
  console.log('run over. ' + (episode.submitted ? 'submitted ' + episode.submitId : 'nothing submitted') + '. ' + meter(episode))
  process.exit(0)
}

if (command === 'status') {
  console.log('services ' + SERVICES.length + ', exactly one faulty')
  console.log(meter(episode))
  process.exit(0)
}

if (episode.used >= BUDGET) {
  episode.done = true
  saveEpisode(episode)
  console.log('budget exhausted, nothing submitted. ' + meter(episode))
  process.exit(0)
}

if (command === 'suspect') {
  episode.used += 1
  episode.usedSuspect = true
  saveEpisode(episode)
  console.log('ranked candidates: ' + SUSPECTS.join(' '))
  console.log(meter(episode))
  process.exit(0)
}

if (command === 'read') {
  const id = typeof args.id === 'string' ? args.id : ''
  if (!SERVICES.includes(id)) {
    console.log('read needs --id s1 through s20')
    process.exit(0)
  }
  episode.used += 1
  saveEpisode(episode)
  const marker = id === FAULTY ? 'fault yes' : 'fault no'
  console.log('service ' + id + ' | one error line in its log | ' + marker)
  console.log(meter(episode))
  process.exit(0)
}

if (command === 'submit') {
  const id = typeof args.id === 'string' ? args.id : ''
  if (!SERVICES.includes(id)) {
    console.log('submit needs --id s1 through s20')
    process.exit(0)
  }
  episode.used += 1
  episode.submitted = true
  episode.submitId = id
  episode.remainingAtSubmit = BUDGET - episode.used
  episode.done = true
  saveEpisode(episode)
  console.log('submitted ' + id + ' | ' + (id === FAULTY ? 'correct' : 'wrong') + ' | ' + meter(episode))
  process.exit(0)
}

console.log('unknown command ' + command)
console.log(HELP)