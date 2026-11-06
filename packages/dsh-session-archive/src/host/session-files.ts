/**
 * Session storage file layer: legacy jsonl.zstd directory discovery, segment
 * matching, path-safety checks, size accounting, and session-rdb sqlite row
 * deletion. The physical-delete boundary — every path removal here is
 * validated to stay inside the sessions root and never follows symlinks out.
 * @module @linxin666/dsh-session-archive/host/session-files
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/**
 * Canonical session id for one segment dir name. DSH persistence keys the
 * segment off the session id: a `session-<uuid>` id lands as segment
 * `<uuid>` (and some layouts keep the prefix). One dir maps to exactly one
 * canonical id — the `session-`-prefixed form used everywhere else — so the
 * inventory never produces phantom duplicate rows.
 */
export function canonicalSessionId(segment: string): string {
  return segment.startsWith('session-') ? segment : `session-${segment}`
}

export interface SessionDirIndex {
  /** session id (as used in the archive set) -> absolute dir path. */
  byId: Map<string, string>
  /** Summed file sizes per session id, when the dir exists. */
  sizes: Map<string, number>
  /** Segment dirs that could not be read at all. */
  unreadable: string[]
}

async function dirSize(path: string): Promise<number> {
  let total = 0
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch {
    return 0
  }
  for (const entry of entries) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one stat per entry, sequential by design: the walk must yield to the event loop between syscalls, never fan out.
      const info = await stat(join(path, entry))
      // oxlint-disable-next-line eslint/no-await-in-loop -- recursive descent stays sequential for the same yield-per-entry reason.
      if (info.isDirectory()) total += await dirSize(join(path, entry))
      else total += info.size
    } catch {
      // A vanished entry contributes nothing.
    }
  }
  return total
}

/** True when `child` is `root` itself or lies under it (realpath-ed, lexical). */
export function isInside(root: string, child: string): boolean {
  const relative = relativeWithin(root, child)
  return relative !== undefined
}

/** Lexical relative path of `child` under `root`, or undefined when outside. */
function relativeWithin(root: string, child: string): string | undefined {
  const rootAbs = resolve(root)
  const childAbs = resolve(child)
  if (childAbs === rootAbs) return ''
  if (!childAbs.startsWith(rootAbs + sep)) return undefined
  return childAbs.slice(rootAbs.length + 1)
}

/**
 * Scan the sessions root once and index every session dir. A session dir is
 * any directory under `<sessionsRoot>/<project>/` (the project key dirs are
 * the cwd-encoded ones). Symlinks are never followed into the index: a link
 * under the sessions root pointing outside is recorded as unreadable instead.
 *
 * Async by design (seal-scan-async-1106): every filesystem call is awaited
 * off the event loop, and the walk yields back to the loop every
 * {@link SCAN_YIELD_EVERY} session dirs so concurrent HTTP requests on the
 * same process are never blocked behind a full-tree scan.
 */
export async function indexSessionDirs(sessionsRoot: string): Promise<SessionDirIndex> {
  const index: SessionDirIndex = { byId: new Map(), sizes: new Map(), unreadable: [] }
  if (!existsSync(sessionsRoot)) return index
  let rootReal: string
  try {
    rootReal = await realpath(sessionsRoot)
  } catch {
    return index
  }
  let projectDirs: string[]
  try {
    projectDirs = await readdir(sessionsRoot)
  } catch {
    return index
  }
  let seen = 0
  for (const project of projectDirs) {
    const projectPath = join(sessionsRoot, project)
    let entries: string[]
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- project dirs are walked one at a time so a big tree never monopolises the loop.
      entries = await readdir(projectPath)
    } catch {
      continue
    }
    for (const segment of entries) {
      const dirPath = join(projectPath, segment)
      let info
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- per-dir stat: sequential pacing is the whole point of the async scan.
        info = await stat(dirPath)
      } catch {
        continue
      }
      if (!info.isDirectory()) continue
      let real: string
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- realpath stays in the sequential walk for the same pacing reason.
        real = await realpath(dirPath)
      } catch {
        index.unreadable.push(dirPath)
        continue
      }
      if (!isInside(rootReal, real)) {
        // A symlink escaping the sessions root is never managed here.
        index.unreadable.push(dirPath)
        continue
      }
      if (!index.byId.has(canonicalSessionId(segment))) {
        const id = canonicalSessionId(segment)
        index.byId.set(id, dirPath)
        // oxlint-disable-next-line eslint/no-await-in-loop -- size accounting belongs to the same sequential walk.
        index.sizes.set(id, await dirSize(dirPath))
      }
      seen += 1
      // oxlint-disable-next-line eslint/no-await-in-loop -- this await IS the yield: every 32 dirs the walk hands the loop back to pending HTTP requests.
      if (seen % SCAN_YIELD_EVERY === 0) await yieldToEventLoop()
    }
  }
  return index
}

/**
 * Session dirs processed between explicit yields back to the event loop.
 * The awaits above already interleave I/O, but a burst of cached stats can
 * still run as one long microtask chain; the periodic macrotask yield bounds
 * worst-case latency of concurrent requests to one small chunk.
 */
const SCAN_YIELD_EVERY = 32

/** Hand control back to the event loop (macrotask), letting pending I/O run. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((done) => {
    setImmediate(done)
  })
}

/**
 * Resolve one session's storage dir against an index. Returns undefined when
 * the session has no legacy directory (rdb-stored or foreign).
 */
export function findSessionDir(index: SessionDirIndex, id: string): string | undefined {
  return index.byId.get(id)
}

/** The session-rdb sqlite locations DSH/dsh-perf use, most likely first. */
export function rdbDbPaths(dshHome: string): string[] {
  return [join(dshHome, 'sessions', 'sessions.sqlite'), join(dshHome, 'sessions.sqlite')]
}

/** The session-rdb fingerprint: application_id + user_version (dsh-perf contract). */
export function isSessionRdb(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const appId = db.prepare('pragma application_id').get() as { application_id?: number } | undefined
      const userVersion = db.prepare('pragma user_version').get() as { user_version?: number } | undefined
      return appId?.application_id === 1146308688 && userVersion?.user_version === 1
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

/**
 * Delete one session's rows from a session-rdb store. FK cascades remove the
 * event tables; returns true when a row was deleted, false when the session
 * was absent. Throws on storage errors (the caller converts to a failure).
 */
export function deleteRdbSession(dbPath: string, id: string): boolean {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('begin')
    try {
      const result = db.prepare('delete from t_sessions where f_session_id = ?').run(id)
      const removed = Number(result.changes) > 0
      db.exec('commit')
      return removed
    } catch (error) {
      try {
        db.exec('rollback')
      } catch {
        // Rollback after a hard failure is best-effort.
      }
      throw error
    }
  } finally {
    db.close()
  }
}

/**
 * Physically remove one session directory. The dir must already be resolved
 * from the index (which never follows escaping symlinks); this re-validates
 * the realpath against the sessions root before the recursive removal, so no
 * caller-supplied path can delete anything outside session storage.
 */
export function removeSessionDir(dirPath: string, sessionsRoot: string): void {
  const rootReal = realpathSync(sessionsRoot)
  const real = realpathSync(dirPath)
  if (!isInside(rootReal, real)) {
    throw new Error(`refusing to remove '${dirPath}': outside the sessions root`)
  }
  rmSync(real, { recursive: true, force: false })
}
