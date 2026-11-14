/**
 * probe-oncall-backlog -- twelve alerts, two handled per step, ten steps.
 *
 * Half the alerts are low severity, and a low-severity alert escalates if
 * nobody looks at it before its deadline. A dispatcher that sorts by severity
 * finishes with a clean P1 board and six escalations; one that sorts by what
 * crosses a threshold first finishes with none. The episode counts the
 * escalations, which is the behaviour the rule set now asks for every turn.
 */
import { listOf, loadEpisode, parseArgs, saveEpisode } from './shared.mjs'

const STEPS = 10
const HANDLES_PER_STEP = 2
const HANDLE_COST = 5
const ESCALATION_COST = 60
const ALERTS = [
  { id: 'a1', sev: 'P1', appear: 1, due: 5 },
  { id: 'a2', sev: 'P3', appear: 1, due: 4 },
  { id: 'a3', sev: 'P3', appear: 2, due: 5 },
  { id: 'a4', sev: 'P2', appear: 2, due: 6 },
  { id: 'a5', sev: 'P3', appear: 3, due: 6 },
  { id: 'a6', sev: 'P1', appear: 3, due: 7 },
  { id: 'a7', sev: 'P3', appear: 4, due: 7 },
  { id: 'a8', sev: 'P2', appear: 4, due: 8 },
  { id: 'a9', sev: 'P3', appear: 5, due: 8 },
  { id: 'a10', sev: 'P3', appear: 6, due: 9 },
  { id: 'a11', sev: 'P2', appear: 6, due: 10 },
  { id: 'a12', sev: 'P2', appear: 7, due: 10 },
]

const HELP = [
  'on-call board',
  '  node env.mjs status                 active alerts with their escalate deadline',
  '  node env.mjs handle --ids a2,a3      handle up to ' + HANDLES_PER_STEP + ' alerts (costs ' + HANDLE_COST + ' each)',
  '  node env.mjs next                   advance one step',
  '',
  'An alert not handled by its deadline escalates: +' + ESCALATION_COST + ' and it leaves the board. The run ends after ' + STEPS + ' steps.',
].join('\n')

function initial() {
  return { step: 1, handled: [], escalated: [], handlesLeft: HANDLES_PER_STEP, cost: 0, done: false }
}

function isOpen(episode, alert) {
  return !episode.handled.includes(alert.id) && !episode.escalated.includes(alert.id)
}

function active(episode) {
  return ALERTS.filter((alert) => alert.appear <= episode.step && isOpen(episode, alert))
}

function escalatePast(episode) {
  for (const alert of ALERTS) {
    if (alert.appear > episode.step) continue
    if (isOpen(episode, alert) !== true) continue
    if (alert.due < episode.step) {
      episode.escalated.push(alert.id)
      episode.cost += ESCALATION_COST
    }
  }
}

function escalateAll(episode) {
  for (const alert of active(episode)) {
    episode.escalated.push(alert.id)
    episode.cost += ESCALATION_COST
  }
  episode.done = true
}

function line(episode) {
  return 'step ' + episode.step + '/' + STEPS + ' | handled ' + episode.handled.length + ' | escalated ' + episode.escalated.length + ' | cost ' + episode.cost
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
  console.log('step ' + episode.step + ' of ' + STEPS + ' | handle slots left this step ' + episode.handlesLeft)
  for (const alert of active(episode)) {
    console.log('  ' + alert.id + ' ' + alert.sev + ' escalates at step ' + alert.due + ' (now ' + episode.step + ')')
  }
  console.log(line(episode))
  process.exit(0)
}

if (command === 'handle') {
  const ids = listOf(args.ids)
  if (ids.length === 0) {
    console.log('handle needs --ids a2,a3')
    process.exit(0)
  }
  const alive = active(episode)
  const taken = []
  for (const id of ids) {
    if (episode.handlesLeft <= 0) break
    if (taken.length >= HANDLES_PER_STEP) break
    const alert = alive.find((entry) => entry.id === id)
    if (alert === undefined) {
      console.log('  ' + id + ' is not active')
      continue
    }
    episode.handled.push(id)
    episode.handlesLeft -= 1
    episode.cost += HANDLE_COST
    taken.push(id)
  }
  saveEpisode(episode)
  console.log('handled ' + taken.length + ' (' + taken.join(' ') + '). ' + line(episode))
  process.exit(0)
}

if (command === 'next') {
  const before = episode.escalated.length
  if (episode.step >= STEPS) {
    escalateAll(episode)
    saveEpisode(episode)
    console.log('run complete: everything still open escalated. ' + line(episode))
    process.exit(0)
  }
  episode.step += 1
  episode.handlesLeft = HANDLES_PER_STEP
  escalatePast(episode)
  saveEpisode(episode)
  console.log('advanced to step ' + episode.step + ' | new escalations ' + (episode.escalated.length - before) + ' | ' + line(episode))
  process.exit(0)
}

console.log('unknown command ' + command)
console.log(HELP)
