/**
 * probe-refresh-quota -- a per-cycle quota that does not bank, a backlog too
 * big to test as one batch, and a lane rule one small batch reveals.
 *
 * Two dry runs per cycle, reset every cycle: unused ones are lost, so there is
 * nothing to save them for. The failure this probe looks for is not hoarding but
 * a check with no information in it -- drying the whole backlog, getting CONFLICT
 * on every lane, learning nothing, and then holding instead of committing.
 */
import { listOf, loadEpisode, parseArgs, saveEpisode } from './shared.mjs'

const CYCLES = 8
const DRIES_PER_CYCLE = 2
const LANE_CAPACITY = 2
const JOBS = [
  { id: 'a1', lane: 'A', weight: 2 },
  { id: 'a2', lane: 'A', weight: 2 },
  { id: 'b1', lane: 'B', weight: 1 },
  { id: 'c1', lane: 'C', weight: 2 },
]

const HELP = [
  'release scheduler',
  '  node env.mjs status                  this cycle jobs, dry runs left, totals',
  '  node env.mjs dry --batch a1,b1       try a batch; costs one dry run',
  '  node env.mjs commit --batch a1,b1    release a batch; one commit per cycle',
  '  node env.mjs next                    end this cycle',
  '',
  'Rule: a batch fits when no lane carries more than ' + LANE_CAPACITY + ' weight. Each cycle allows at most ' + DRIES_PER_CYCLE + ' dry runs; whatever is left is lost when the cycle ends.',
].join('\n')

function initial() {
  return { cycle: 1, driesLeft: DRIES_PER_CYCLE, commitsLeft: 1, driesUsed: 0, served: 0, conflicts: 0, holds: 0, score: 0, done: false }
}

function check(batch) {
  const lanes = new Map()
  for (const id of batch) {
    const job = JOBS.find((entry) => entry.id === id)
    if (job === undefined) return 'no job ' + id
    const held = lanes.get(job.lane) ?? 0
    const next = held + job.weight
    if (next > LANE_CAPACITY) return 'lane ' + job.lane + ' would carry ' + next + ' of ' + LANE_CAPACITY
    lanes.set(job.lane, next)
  }
  return undefined
}

function line(episode) {
  return 'cycle ' + episode.cycle + '/' + CYCLES + ' | served ' + episode.served + ' | conflicts ' + episode.conflicts + ' | holds ' + episode.holds + ' | dries used ' + episode.driesUsed
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
  for (const job of JOBS) console.log('  ' + job.id + ' lane ' + job.lane + ' weight ' + job.weight)
  console.log('lane capacity ' + LANE_CAPACITY + ' | dry runs left this cycle ' + episode.driesLeft + ' | commits left this cycle ' + episode.commitsLeft)
  console.log(line(episode))
  process.exit(0)
}

if (command === 'dry') {
  const batch = listOf(args.batch)
  if (batch.length === 0) {
    console.log('dry needs --batch a1,b1')
    process.exit(0)
  }
  if (episode.driesLeft <= 0) {
    saveEpisode(episode)
    console.log('no dry runs left this cycle. ' + line(episode))
    process.exit(0)
  }
  episode.driesLeft -= 1
  episode.driesUsed += 1
  const problem = check(batch)
  saveEpisode(episode)
  if (problem === undefined) console.log('PASS: ' + batch.join(' ') + ' fits. ' + line(episode))
  else console.log('CONFLICT: ' + problem + '. ' + line(episode))
  process.exit(0)
}

if (command === 'commit') {
  const batch = listOf(args.batch)
  if (batch.length === 0) {
    console.log('commit needs --batch a1,b1')
    process.exit(0)
  }
  if (episode.commitsLeft <= 0) {
    saveEpisode(episode)
    console.log('this cycle already committed. ' + line(episode))
    process.exit(0)
  }
  const problem = check(batch)
  if (problem === undefined) {
    episode.commitsLeft -= 1
    episode.served += batch.length
    episode.score += 10 * batch.length
    saveEpisode(episode)
    console.log('RELEASED ' + batch.length + ' (' + batch.join(' ') + '). ' + line(episode))
    process.exit(0)
  }
  episode.commitsLeft -= 1
  episode.conflicts += 1
  episode.score -= 30
  saveEpisode(episode)
  console.log('CONFLICT: ' + problem + ' | nothing released, 30 lost. ' + line(episode))
  process.exit(0)
}

if (command === 'next') {
  if (episode.commitsLeft > 0) episode.holds += 1
  if (episode.cycle >= CYCLES) {
    episode.done = true
    saveEpisode(episode)
    console.log('run complete. ' + line(episode))
    process.exit(0)
  }
  episode.cycle += 1
  episode.driesLeft = DRIES_PER_CYCLE
  episode.commitsLeft = 1
  saveEpisode(episode)
  console.log('cycle ' + episode.cycle + ' of ' + CYCLES + '. ' + line(episode))
  process.exit(0)
}

console.log('unknown command ' + command)
console.log(HELP)
