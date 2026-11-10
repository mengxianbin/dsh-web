/**
 * Shared plumbing for the behaviour probes: episode persistence, a JSON result
 * channel, and argv parsing. Kept free of template literals so a probe file
 * stays readable in a diff and works under the same node the runner uses.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const EPISODE = 'episode.json'

/**
 * The episode lives beside the simulator, which is the process cwd for every
 * env call. A grader that runs in-process instead of in the workspace points
 * this at the workspace with DSH_PROBE_EPISODE, so one probe cannot read
 * another run's state by accident.
 */
export function episodePath() {
  return join(process.env.DSH_PROBE_EPISODE ?? '.', EPISODE)
}

export function loadEpisode(initial) {
  if (!existsSync(episodePath())) return initial()
  try {
    return JSON.parse(readFileSync(episodePath(), 'utf8'))
  } catch {
    return initial()
  }
}

export function saveEpisode(episode) {
  writeFileSync(episodePath(), JSON.stringify(episode, null, 2) + '\n', 'utf8')
}

/** Print one machine-readable line and keep human prose on its own lines. */
export function emit(line, payload) {
  if (payload !== undefined) console.log(JSON.stringify(payload))
  if (line !== undefined) console.log(line)
}

/** Parse '--flag a,b' and '--flag value' pairs into a flat object. */
export function parseArgs(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue }
    out[key] = next
    index += 1
  }
  return out
}

/** 'a,b, c' -> ['a','b','c'], dropping empties and duplicates. */
export function listOf(value) {
  if (typeof value !== 'string') return []
  const seen = new Set()
  for (const part of value.split(',')) {
    const item = part.trim()
    if (item !== '') seen.add(item)
  }
  return [...seen]
}

/** The grade program's one output shape: exit code carries pass/fail. */
export function report(result) {
  console.log(JSON.stringify({
    passed: result.passed === true,
    score: result.score ?? 0,
    metrics: result.metrics ?? {},
    detail: result.detail ?? null,
  }))
  process.exit(result.passed === true ? 0 : 1)
}
