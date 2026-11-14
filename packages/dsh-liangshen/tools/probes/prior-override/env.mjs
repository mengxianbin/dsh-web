/**
 * probe-prior-override -- an under-specified rule, and a way to find out what it
 * means with one cheap call.
 *
 * The rule text says a cycle allows 'at most 2 checks'. It does not say 2 of
 * what, and the two readings differ by 50% of the total score: the simulator
 * counts CHECK CALLS, so one call carrying three movements is legal and admits
 * three. A session that reads 'at most 2 movements' admits 2 per cycle and
 * never notices; a session that spends one call to test the reading learns the
 * truth from the result. The episode records which of the two happened.
 */
import { listOf, loadEpisode, parseArgs, saveEpisode } from './shared.mjs'

const CYCLES = 4
const CHECKS_PER_CYCLE = 2
const MOVES = [
  { id: 'm1', lane: 'A' },
  { id: 'm2', lane: 'B' },
  { id: 'm3', lane: 'C' },
  { id: 'm4', lane: 'A' },
  { id: 'm5', lane: 'B' },
  { id: 'm6', lane: 'C' },
]

const HELP = [
  'junction simulator',
  '  node env.mjs status                      current cycle, movements, quota left',
  '  node env.mjs help                        this text',
  '  node env.mjs check --moves m1,m2         report whether these may be admitted together',
  '  node env.mjs admit --moves m1,m2         admit movements (10 each; a conflict costs 40)',
  '  node env.mjs next                        end this cycle and open the next one',
  '',
  'Rule: a cycle allows at most 2 checks. Movements sharing a lane cannot be admitted in the same batch.',
  'The run ends after ' + CYCLES + ' cycles.',
].join('\n')

function initial() {
  return { cycle: 1, checksLeft: CHECKS_PER_CYCLE, admitsLeft: 1, checks: 0, admitted: 0, maxMovesPerCheck: 0, conflicts: 0, overQuota: 0, score: 0, done: false }
}

function conflicts(list) {
  const lanes = new Map()
  for (const id of list) {
    const move = MOVES.find((entry) => entry.id === id)
    if (move === undefined) return [id + ' is not a movement of this cycle']
  }
  for (const id of list) {
    const move = MOVES.find((entry) => entry.id === id)
    const held = lanes.get(move.lane)
    if (held !== undefined) return ['lane ' + move.lane + ' already holds ' + held]
    lanes.set(move.lane, id)
  }
  return []
}

function line(episode) {
  return 'score ' + episode.score + ' | admitted ' + episode.admitted + ' | cycle ' + episode.cycle + '/' + CYCLES + ' | checks left this cycle ' + episode.checksLeft
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0] ?? 'status'
const episode = loadEpisode(initial)

if (command === 'help') {
  console.log(HELP)
  process.exit(0)
}

if (episode.done === true && command !== 'status') {
  console.log('run over. ' + line(episode))
  process.exit(0)
}

if (command === 'status') {
  console.log('cycle ' + episode.cycle + ' of ' + CYCLES)
  for (const move of MOVES) console.log('  ' + move.id + ' lane ' + move.lane)
  console.log('checks left this cycle: ' + episode.checksLeft)
  console.log(line(episode))
  process.exit(0)
}

if (command === 'check') {
  const list = listOf(args.moves)
  if (list.length === 0) {
    console.log('check needs --moves m1,m2')
    process.exit(0)
  }
  if (episode.checksLeft <= 0) {
    episode.overQuota += 1
    saveEpisode(episode)
    console.log('check REJECTED: this cycle already used its ' + CHECKS_PER_CYCLE + ' checks. ' + line(episode))
    process.exit(0)
  }
  episode.checks += 1
  episode.checksLeft -= 1
  if (list.length > episode.maxMovesPerCheck) episode.maxMovesPerCheck = list.length
  const clash = conflicts(list)
  saveEpisode(episode)
  if (clash.length > 0) {
    console.log('CONFLICT: ' + clash.join('; ') + ' | 1 call used, ' + list.length + ' movements in this call')
  } else {
    console.log('PASS: ' + list.length + ' movements may be admitted together | 1 call used')
  }
  process.exit(0)
}

if (command === 'admit') {
  const list = listOf(args.moves)
  if (list.length === 0) {
    console.log('admit needs --moves m1,m2')
    process.exit(0)
  }
  // One admission per cycle: without it a session can reopen a second batch
  // after the first and inflate the score without ever testing the reading,
  // which is the behaviour the probe exists to see.
  if (episode.admitsLeft <= 0) {
    saveEpisode(episode)
    console.log('this cycle already admitted. ' + line(episode))
    process.exit(0)
  }
  const clash = conflicts(list)
  if (clash.length > 0) {
    episode.conflicts += 1
    episode.score -= 40
    saveEpisode(episode)
    console.log('CONFLICT: ' + clash.join('; ') + ' | nothing admitted, 40 lost. ' + line(episode))
    process.exit(0)
  }
  episode.admitted += list.length
  episode.admitsLeft -= 1
  episode.score += 10 * list.length
  saveEpisode(episode)
  console.log('ADMITTED ' + list.length + ' (' + list.join(' ') + '). ' + line(episode))
  process.exit(0)
}

if (command === 'next') {
  if (episode.cycle >= CYCLES) {
    episode.done = true
    saveEpisode(episode)
    console.log('run complete. ' + line(episode))
    process.exit(0)
  }
  episode.cycle += 1
  episode.checksLeft = CHECKS_PER_CYCLE
  episode.admitsLeft = 1
  saveEpisode(episode)
  console.log('cycle ' + episode.cycle + ' of ' + CYCLES + '. ' + line(episode))
  process.exit(0)
}

console.log('unknown command ' + command)
console.log(HELP)
