/**
 * The archive-readiness four-tuple (lamp-wiring-1126, taskchain-governance-1125 §8.4):
 *
 *   可归档 = 回合约态 ∧ 验收E8 ∧ 产出入仓 ∧ 欠账显式化
 *
 * This module is the SINGLE structured computation behind both lamp legs
 * (contract C1's `sealCheck` pull leg and the turn/end Host push leg) and the
 * REST archive gate — replacing the transcript-text `analyzeSeal` read that
 * made the lamp and the save sentinel line同源 (the "fake independence" §8.4
 * diagnoses). Same inputs ⇒ same output on every leg
 * (先例 seal-lamp-consistency-1114).
 *
 * Fail-closed by construction: an unreadable dimension never green-lights —
 * it folds to `UNKNOWN` (gate refuses, lamp renders the unreadable ring); a
 * definitively red dimension folds to `UNSEALED` (gate refuses with the
 * failing dim named). The verdict is always recomputed from live sources on
 * the request path; this module never reads the m-note verdict cache
 * (`~/.dsh/task-verdict-cache.json`) — 门 = 现算, the cache is a render
 * accelerator for the m-note side only.
 *
 * Dimension sources (structured, injectable — tests replace the whole
 * {@link VerdictSources}; production wires {@link createVerdictSources}):
 * 1. 回合约态 — the alive binding from `GET /api/session-dispatch/bindings`
 *    (m-note `task-status.py:554 alive_of` semantics: a session bound to a
 *    live taskRef). The activity half of 回合约态（无 active turn/job）stays
 *    on its existing legs, which the task book lists as this dimension's
 *    sources too: the `janitor.ts:913-918` running skip (auto cycles), the
 *    C′ activity waterfall + harness `archiveOne` 活动性拒 (archive time),
 *    and the lamp's client-side running short-circuit — folding `running`
 *    into the verdict here would preempt that waterfall and dead-leg it.
 * 2. 验收E8 — `GET /api/task-fsm/state`: record `state === 'done'` ∧
 *    `history` contains the `E8` event (Q4 粒度; readings 不落账另立单).
 * 3. 产出入仓 — m-note `scripts/git/save-status.py` stdout, parsed at the
 *    machine `repos=` cell (§2.1 机器可读形态 = stdout 解析, chosen over a
 *    new `--json` flag so save-status.py itself stays untouched — rationale
 *    in progress.md). Cell `n/n` green, `0/0` vacuous green (no changed
 *    repo ⇒ nothing unpushed), `n/a…` unreadable.
 * 4. 欠账显式化 — m-note `scripts/dsh/debt-scan.py --json`: `count === 0`
 *    pass; `count > 0` fail (markers hidden in prose); the script's fail-open
 *    `error` shape maps `diff 为空` → pass (nothing to scan) and any git
 *    error → unreadable (the gate never inherits the save chain's fail-open).
 *
 * Both python legs run with the workspace root as cwd (the session's
 * registry path); a missing script or an unresolvable root reads
 * unreadable — fail-closed, never a silent pass.
 * @module @linxin666/dsh-session-archive/host/archive-verdict
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SealCheckResult, SealRef, SealVerdict } from '../core/types.ts'
import { canonicalSessionId } from './session-files.ts'

/** Machine state of one dimension. */
export type DimState = 'pass' | 'fail' | 'unreadable'

/** One dimension's reading: fold state + the structured source it came from + a machine note. */
export interface DimReading {
  readonly state: DimState
  /** Structured source anchor (endpoint / script) this reading came from. */
  readonly source: string
  /** Machine note (`alive-binding`, `task-not-done`, `not-reached-1of2`, …). */
  readonly note: string
}

/** The four dimensions, folded in order contract → e8 → pushed → debt. */
export interface FourTuple {
  readonly contract: DimReading
  readonly e8: DimReading
  readonly pushed: DimReading
  readonly debt: DimReading
}

/** Dimension names in fold order. */
export type DimName = keyof FourTuple

/** The session's alive binding: the taskRef + workspace the other dims key on. */
export interface AliveBinding {
  readonly taskRef: string
  readonly workspaceId: string
}

/** Structural view of one FSM task record (only the fields the E8 dim reads). */
export interface FsmTaskLike {
  readonly state?: unknown
  readonly history?: readonly { readonly event?: unknown }[]
}

/**
 * The injectable source surface of the four-tuple. Production wires
 * {@link createVerdictSources}; tests replace the whole object so any
 * dimension can be driven pass / fail / unreadable independently.
 *
 * Read-failure conventions: `null` = the source could not be read
 * (unreadable → fail-closed); `undefined` from {@link VerdictSources.binding}
 * = read fine, no alive binding (a definitive fail, not a read failure).
 */
export interface VerdictSources {
  /** Alive binding for a session: `null` unreadable, `undefined` none alive. */
  binding(sessionId: string): Promise<AliveBinding | undefined | null>
  /** Filesystem root of a workspace (registry path) for the script legs. */
  workspaceRoot(workspaceId: string): string | undefined
  /** FSM task records keyed by taskRef; `null` unreadable. */
  fsmTasks(): Promise<Readonly<Record<string, FsmTaskLike>> | null>
  /** `save-status.py` stdout for one (root, taskRef, session); `null` unreadable. */
  saveStatus(root: string, taskRef: string, sessionId: string): Promise<string | null>
  /** `debt-scan.py --json` reading: normal `{count}`, script fail-open `{error}`, or `null` unreadable. */
  debtScan(root: string): Promise<{ readonly count: number } | { readonly error: string } | null>
}

/** One session's four-tuple verdict: the C1 row plus the per-dim readings. */
export interface ArchiveVerdict extends SealCheckResult {
  readonly readings: FourTuple
}

/**
 * Per-operation dedup map shared across the ids of ONE request (a lamp pull
 * or an archive batch): bindings/fsm fetch once, one debt scan per root, one
 * save-status run per distinct (root, taskRef, session). Never crosses a
 * request — every request recomputes from live sources (门 = 现算, no
 * cross-request cache, zero timers).
 */
export type VerdictMemo = Map<string, Promise<unknown>>

const DIM_ORDER: readonly DimName[] = ['contract', 'e8', 'pushed', 'debt']

function dim(state: DimState, source: string, note: string): DimReading {
  return { state, source, note }
}

const SRC_BINDINGS = 'GET /api/session-dispatch/bindings'
const SRC_FSM = 'GET /api/task-fsm/state'
const SRC_SAVE = 'scripts/git/save-status.py (repos= cell)'
const SRC_DEBT = 'scripts/dsh/debt-scan.py --json'

/** Memoize one source load for the duration of one request; failures stay inside the promise. */
function memoized<T>(memo: VerdictMemo | undefined, key: string, load: () => Promise<T>): Promise<T> {
  if (memo === undefined) return load()
  const hit = memo.get(key)
  if (hit !== undefined) return hit as Promise<T>
  const pending = load()
  memo.set(key, pending as Promise<unknown>)
  return pending
}

/** Await a source without letting a rejection escape as an exception (reads degrade to `null`). */
async function guarded<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch {
    return null
  }
}

/**
 * Fold four readings into the six-value verdict vocabulary:
 * any `fail` ⇒ `UNSEALED` (a definitive red answers even beside an
 * unreadable dim — the AND is already false); else any `unreadable` ⇒
 * `UNKNOWN` (查不清即拦); else `DONE`. The detail names the deciding dim so
 * the receipt's缺因归因 stays one grep away.
 */
export function foldFourTuple(readings: FourTuple): { verdict: SealVerdict; detail: string } {
  for (const name of DIM_ORDER) {
    if (readings[name].state === 'fail') return { verdict: 'UNSEALED', detail: `4t-red-${name}` }
  }
  for (const name of DIM_ORDER) {
    if (readings[name].state === 'unreadable') return { verdict: 'UNKNOWN', detail: `4t-unreadable-${name}` }
  }
  return { verdict: 'DONE', detail: '4t-pass' }
}

/**
 * Compute the four-tuple for one session.
 * @param id - canonical session id.
 * @param sources - the injectable dimension sources.
 * @param memo - optional per-request dedup map (see {@link VerdictMemo}).
 * @returns the verdict with all four readings attached (fail-closed fold).
 */
export async function computeFourTuple(
  id: string,
  sources: VerdictSources,
  memo?: VerdictMemo,
): Promise<ArchiveVerdict> {
  // -- dim 1: 回合约态 — the alive binding (activity legs stay external) ---
  let binding: AliveBinding | undefined | null
  binding = await guarded(() => memoized(memo, `binding:${id}`, () => sources.binding(id)))
  let contract: DimReading
  let taskRef: string | undefined
  let workspaceId: string | undefined
  if (binding === null) {
    contract = dim('unreadable', SRC_BINDINGS, 'bindings-unreadable')
  } else if (binding === undefined) {
    contract = dim('fail', SRC_BINDINGS, 'no-alive-binding')
  } else {
    taskRef = binding.taskRef
    workspaceId = binding.workspaceId
    contract = dim('pass', SRC_BINDINGS, 'alive-binding')
  }

  // -- dim 2: 验收E8 — FSM done ∧ history contains E8 ----------------------
  let e8: DimReading
  if (taskRef === undefined) {
    e8 = dim('unreadable', SRC_FSM, 'no-taskref')
  } else {
    const tasks = await guarded(() => memoized(memo, 'fsm', () => sources.fsmTasks()))
    if (tasks === null) {
      e8 = dim('unreadable', SRC_FSM, 'fsm-unreadable')
    } else {
      const record = tasks[taskRef]
      if (record === undefined) {
        e8 = dim('fail', SRC_FSM, 'task-missing')
      } else if (record.state !== 'done') {
        e8 = dim('fail', SRC_FSM, 'task-not-done')
      } else if (!(record.history ?? []).some((entry) => entry.event === 'E8')) {
        e8 = dim('fail', SRC_FSM, 'no-e8-event')
      } else {
        e8 = dim('pass', SRC_FSM, 'e8-done')
      }
    }
  }

  // -- shared root for the two m-note script legs --------------------------
  let root: string | undefined
  if (workspaceId !== undefined) {
    try {
      root = sources.workspaceRoot(workspaceId)
    } catch {
      root = undefined
    }
  }

  // -- dim 3: 产出入仓 — save-status repos= cell ---------------------------
  let pushed: DimReading
  if (taskRef === undefined) {
    pushed = dim('unreadable', SRC_SAVE, 'no-taskref')
  } else if (root === undefined) {
    pushed = dim('unreadable', SRC_SAVE, 'no-root')
  } else {
    const line = await guarded(() =>
      memoized(memo, `save:${root as string}|${taskRef as string}|${id}`, () => sources.saveStatus(root as string, taskRef as string, id)))
    if (line === null || line === '') {
      pushed = dim('unreadable', SRC_SAVE, 'save-status-unreadable')
    } else {
      const cell = /(?:^|\s)repos=([^\s]+)/.exec(line)?.[1]
      if (cell === undefined) {
        pushed = dim('unreadable', SRC_SAVE, 'save-status-unparseable')
      } else if (cell === '0/0') {
        // No changed repo on either axis ⇒ nothing that could be unpushed.
        pushed = dim('pass', SRC_SAVE, 'no-changed-repos')
      } else if (/^\d+\/\d+$/.test(cell)) {
        const [reached, changed] = cell.split('/').map(Number)
        pushed = changed > 0 && reached === changed
          ? dim('pass', SRC_SAVE, 'reached-push-lines')
          : dim('fail', SRC_SAVE, `not-reached-${reached}of${changed}`)
      } else {
        // `n/a`, `n/a:registry-unavailable`, `n/a:cannot-derive` — the script
        // could not judge; the gate never inherits that as a pass.
        pushed = dim('unreadable', SRC_SAVE, 'registry-unavailable')
      }
    }
  }

  // -- dim 4: 欠账显式化 — debt-scan count --------------------------------
  let debt: DimReading
  if (root === undefined) {
    debt = dim('unreadable', SRC_DEBT, 'no-root')
  } else {
    const reading = await guarded(() => memoized(memo, `debt:${root as string}`, () => sources.debtScan(root as string)))
    if (reading === null) {
      debt = dim('unreadable', SRC_DEBT, 'debt-scan-unreadable')
    } else if ('error' in reading) {
      // debt-scan is fail-open by contract (exit 0 never blocks the save
      // chain); the gate reads its error shape narrowly: an empty diff is a
      // legitimate "nothing to scan" (pass), anything else could not be read.
      debt = reading.error.includes('diff 为空')
        ? dim('pass', SRC_DEBT, 'no-diff-to-scan')
        : dim('unreadable', SRC_DEBT, 'git-error')
    } else {
      debt = reading.count === 0
        ? dim('pass', SRC_DEBT, 'no-debt-markers')
        : dim('fail', SRC_DEBT, `debt-markers-${reading.count}`)
    }
  }

  const readings: FourTuple = { contract, e8, pushed, debt }
  return { id, ...foldFourTuple(readings), readings }
}

/** All-unreadable readings for a session the lookup itself could not resolve. */
export function unresolvedReadings(id: string): FourTuple {
  return {
    contract: dim('unreadable', 'session lookup', `session-not-found:${id}`),
    e8: dim('unreadable', SRC_FSM, 'not-computed'),
    pushed: dim('unreadable', SRC_SAVE, 'not-computed'),
    debt: dim('unreadable', SRC_DEBT, 'not-computed'),
  }
}

/** Per-dim action remedies for a red receipt (§8.4 缺因归因); UNKNOWN rows carry none. */
const TUPLE_REMEDIES: Readonly<Record<string, string>> = {
  '4t-red-contract': '回合约态不满足（会话无活绑定）：恢复任务绑定后重试归档；确需强归走 force+reason。',
  '4t-red-e8': '验收未过（FSM 任务非 done 或 history 无 E8）：完成验收使任务到终态后重试；确需强归走 force+reason。',
  '4t-red-pushed': '产出未入仓（改动仓未全达 push_lines）：push/merge 后重试；确需强归走 force+reason。',
  '4t-red-debt': '欠账未显式化（debt-scan 命中标记词）：走 ask 三选把欠账落板后重试；确需强归走 force+reason。',
}

/**
 * The `seal-required` receipt for a four-tuple verdict (replaces the
 * transcript paste-line remedy, which §8.4 retires with the护送文本 layer):
 * grouping + an actionable per-dim remedy on red; `UNKNOWN` carries only the
 * grouping (an unreadable source is not fixed by an action).
 */
export function fourTupleRefOf(result: { readonly verdict: SealVerdict; readonly detail: string }): SealRef {
  const remedy = TUPLE_REMEDIES[result.detail]
  return { verdict: result.verdict, detail: result.detail, ...(remedy === undefined ? {} : { remedy }) }
}

// ---------------------------------------------------------------------------
// Production sources
// ---------------------------------------------------------------------------

/** Collaborators the production sources read through (wired by the archive service). */
export interface VerdictSourceOptions {
  /** Loopback origin of this host (`webServer.getOrigin`); `undefined` = unreadable. */
  origin(): string | undefined
  /** Registry path of a workspace id; `undefined` = unresolvable. */
  workspacePath(workspaceId: string): string | undefined
}

/** Subprocess budget: longer than the measured ~2.9 s save-status run, short enough to fail visible. */
const RUN_TIMEOUT_MS = 20_000
const FETCH_TIMEOUT_MS = 5_000

/**
 * Run one command for its stdout. A non-zero exit still yields the stdout
 * (`save-status.py` exits 1 on PENDING while its line carries the cell the
 * gate parses); only a spawn failure, timeout or empty output reads `null`.
 */
function run(cmd: string, args: readonly string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, [...args], {
        cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, RUN_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { out += chunk })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * The production {@link VerdictSources}: loopback fetches for the binding
 * and FSM legs, the workspace registry for the script roots, and two python
 * subprocesses for the m-note legs. Every read failure returns `null`
 * (unreadable → fail-closed fold); nothing here writes anything.
 */
export function createVerdictSources(options: VerdictSourceOptions): VerdictSources {
  return {
    async binding(sessionId: string): Promise<AliveBinding | undefined | null> {
      const origin = options.origin()
      if (origin === undefined) return null
      const body = await fetchJson(`${origin}/api/session-dispatch/bindings`)
      if (typeof body !== 'object' || body === null) return null
      const record = body as { ok?: unknown; bindings?: unknown }
      if (record.ok !== true || !Array.isArray(record.bindings)) return null
      const wanted = canonicalSessionId(sessionId)
      for (const raw of record.bindings) {
        const entry = raw as { sessionId?: unknown; alive?: unknown; taskRef?: unknown; workspaceId?: unknown }
        if (entry.alive !== true || typeof entry.sessionId !== 'string') continue
        if (canonicalSessionId(entry.sessionId) !== wanted) continue
        if (typeof entry.taskRef !== 'string' || entry.taskRef === '' || typeof entry.workspaceId !== 'string') continue
        return { taskRef: entry.taskRef, workspaceId: entry.workspaceId }
      }
      return undefined
    },

    workspaceRoot(workspaceId: string): string | undefined {
      try {
        return options.workspacePath(workspaceId)
      } catch {
        return undefined
      }
    },

    async fsmTasks(): Promise<Readonly<Record<string, FsmTaskLike>> | null> {
      const origin = options.origin()
      if (origin === undefined) return null
      const body = await fetchJson(`${origin}/api/task-fsm/state`)
      if (typeof body !== 'object' || body === null) return null
      const record = body as { ok?: unknown; file?: { tasks?: unknown } | null }
      const tasks = record.ok === true && typeof record.file === 'object' && record.file !== null
        ? record.file.tasks
        : undefined
      if (typeof tasks !== 'object' || tasks === null) return null
      return tasks as Readonly<Record<string, FsmTaskLike>>
    },

    async saveStatus(root: string, taskRef: string, sessionId: string): Promise<string | null> {
      const script = join(root, 'scripts', 'git', 'save-status.py')
      if (!existsSync(script)) return null
      // The output tip: the workspace's HEAD travels as the hash axis, so the
      // current repo's `pushedMain` reading answers "is this task's tip at a
      // push line" (§8.4 会话 hash 可达 push_lines) without the gate having
      // to know the session's batch hashes.
      const head = await run('git', ['-C', root, 'rev-parse', 'HEAD'], root)
      const hash = head?.trim()
      if (hash === undefined || hash === '' || !/^[0-9a-f]{7,64}$/i.test(hash)) return null
      const out = await run('python', [script, '--taskref', taskRef, '--session', sessionId, '--hashes', hash], root)
      return out === null || out.trim() === '' ? null : out
    },

    async debtScan(root: string): Promise<{ readonly count: number } | { readonly error: string } | null> {
      const script = join(root, 'scripts', 'dsh', 'debt-scan.py')
      if (!existsSync(script)) return null
      const out = await run('python', [script, '--json', '--root', root], root)
      if (out === null || out.trim() === '') return null
      try {
        const parsed = JSON.parse(out) as { count?: unknown; error?: unknown }
        if (typeof parsed.error === 'string') return { error: parsed.error }
        if (typeof parsed.count === 'number') return { count: parsed.count }
        return null
      } catch {
        return null
      }
    },
  }
}
