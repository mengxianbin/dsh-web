#!/usr/bin/env node
/**
 * Restart-signal build stamp for this repository: `run -- <command>` captures
 * the source state before the command (S_start) and writes
 * `.dsh-build/restart-stamp.json` (kind: dsh-web) when the command succeeds;
 * a failed command leaves the previous manifest untouched. The whole
 * repository is the host face (the harness host process loads these plugin
 * libs), and it combines this manifest with its own tree's manifest into the
 * R stamp at process start.
 *
 * With DSH_BUILD_STAMP_ACTIVE already set the invocation is nested inside an
 * outer stamped chain and becomes a pure passthrough, so exactly one
 * opening/closing pair owns each build.
 *
 * Mirror of harness `scripts/restart-signal/build-stamp.ts`: the two
 * repositories cannot share one module, so the manifest schema (version 1,
 * time/sStartTime/builtFaces/midBuildDirty/hostFaceHash/sStart/sEnd) and the
 * nested marker protocol must stay in step with that file.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STAMP_DIR = '.dsh-build'
const MANIFEST_FILE = 'restart-stamp.json'
const START_FILE = 'restart-stamp.start.json'
const STAMP_ACTIVE_ENV = 'DSH_BUILD_STAMP_ACTIVE'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 256 * 1024 * 1024 })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function diskIdentity(path) {
  try {
    return `disk:${sha256(readFileSync(join(ROOT, path)))}`
  } catch {
    return 'disk:DELETED'
  }
}

// Runtime data rather than sources: never part of the source stamp.
const RUNTIME_SEGMENTS = ['node_modules', '.dsh-build', 'dist', '.wrangler', '.pnpm-store']

function isRuntimeData(path) {
  if (path.endsWith('.log')) return true
  return path.split('/').some((segment) => RUNTIME_SEGMENTS.includes(segment))
}

function untrackedPaths() {
  return git(['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '')
    .sort()
}

/** Repo-level source stamp: HEAD, `git diff HEAD`, porcelain, untracked path/content. */
function repoStateStamp() {
  const porcelain = git(['status', '--porcelain'])
  const hash = createHash('sha256')
  hash.update('HEAD ')
  hash.update(git(['rev-parse', 'HEAD']))
  hash.update('\nPORCELAIN\n')
  hash.update(porcelain)
  if (porcelain.toString('utf8').trim() !== '') {
    hash.update('\nDIFF\n')
    hash.update(git(['diff', 'HEAD']))
    hash.update('\nUNTRACKED\n')
    for (const path of untrackedPaths()) {
      if (isRuntimeData(path)) continue
      hash.update(path)
      hash.update('\0')
      hash.update(diskIdentity(path))
      hash.update('\n')
    }
  }
  return hash.digest('hex')
}

/**
 * Whole-repository content state: index blobs for files whose working tree
 * matches the index, disk hashes for modified and untracked files, deleted
 * markers for removals.
 */
function faceContentStamp() {
  const raw = git(['ls-files', '-s', '-z']).toString('utf8')
  const lines = []
  for (const token of raw.split('\0')) {
    if (token === '') continue
    const tab = token.indexOf('\t')
    if (tab < 0) continue
    const header = token.slice(0, tab).split(' ')
    if (header[2] === '0' || header.length === 2) lines.push(`${token.slice(tab + 1)}\t${header[1]}`)
  }
  const dirty = new Set(untrackedPaths())
  for (const token of git(['status', '--porcelain', '-z']).toString('utf8').split('\0')) {
    if (token === '' || token.slice(1, 2) === ' ') continue
    dirty.add(token.slice(3))
  }
  for (const path of dirty) lines.push(`${path}\t${diskIdentity(path)}`)
  lines.sort()
  const hash = createHash('sha256')
  for (const line of lines) {
    hash.update(line)
    hash.update('\n')
  }
  return hash.digest('hex')
}

function stampPath(file) {
  return join(ROOT, STAMP_DIR, file)
}

function capture() {
  return { repo: repoStateStamp(), host: faceContentStamp(), client: 'ABSENT' }
}

function beginBuild() {
  mkdirSync(STAMP_DIR, { recursive: true })
  writeFileSync(
    stampPath(START_FILE),
    `${JSON.stringify({ version: 1, kind: 'harness-start', time: new Date().toISOString(), faces: ['host'], sStart: capture() }, undefined, 2)}\n`,
  )
}

function endBuild() {
  let start
  try {
    start = JSON.parse(readFileSync(stampPath(START_FILE), 'utf8'))
  } catch {
    throw new Error('build-stamp: closing step found no build-start record; the opening mount did not run')
  }
  const sEnd = capture()
  const manifest = {
    version: 1,
    kind: 'dsh-web',
    time: new Date().toISOString(),
    sStartTime: start.time,
    builtFaces: ['host'],
    midBuildDirty: sEnd.host !== start.sStart.host,
    hostFaceHash: start.sStart.host,
    clientFaceHash: null,
    sStart: start.sStart,
    sEnd,
  }
  mkdirSync(STAMP_DIR, { recursive: true })
  const temporary = stampPath(`${MANIFEST_FILE}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(manifest, undefined, 2)}\n`)
  renameSync(temporary, stampPath(MANIFEST_FILE))
  rmSync(stampPath(START_FILE), { force: true })
  process.stderr.write(
    `build-stamp: manifest written (host face, midBuildDirty=${String(manifest.midBuildDirty)}) ${join(STAMP_DIR, MANIFEST_FILE)}\n`,
  )
}

function stampActive() {
  const value = process.env[STAMP_ACTIVE_ENV]
  return value !== undefined && value !== '' && value !== '0'
}

function main(args) {
  const separator = args.indexOf('--')
  if (args[0] !== 'run' || separator < 0) {
    throw new Error('build-stamp: usage: node scripts/build-stamp.mjs run -- <command>')
  }
  const command = args.slice(separator + 1).join(' ')
  if (command === '') throw new Error('build-stamp: run requires a command after `--`')
  if (stampActive()) {
    const nested = spawnSync(command, { shell: true, stdio: 'inherit', cwd: ROOT })
    return nested.status ?? 1
  }
  beginBuild()
  const child = spawnSync(command, { shell: true, stdio: 'inherit', cwd: ROOT, env: { ...process.env, [STAMP_ACTIVE_ENV]: '1' } })
  const code = child.status ?? 1
  if (code !== 0) return code
  endBuild()
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`build-stamp: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
