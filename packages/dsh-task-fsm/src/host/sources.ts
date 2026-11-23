/**
 * Host wiring for G1–G3/G5 sources: structural (sync) reads of the dispatch
 * quick ledger + workspace store for G2, the fsm file itself for G3, and the
 * evidence fields the caller supplied for G1/G4/G6. The dispatch ledger
 * contract is mirrored structurally (taskRef/sessionId rows; aliveness =
 * sessionIds minus global.archivedSessionIds) — a read-only consumer of
 * another package's file, documented so a contract change fails loudly here.
 * @module @linxin666/dsh-task-fsm/host/sources
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AcceptanceReading, GuardDeps } from '../core/guards.ts'
import type { FsmFile } from '../core/schema.ts'

/** Evidence the transition caller supplies for the evidence-backed guards. */
export interface TransitionEvidence {
  /** G1: the taskbook carries a worktree 预案 (set at create time). */
  worktreePlan?: boolean
  /** G4: machine readings for the acceptance gate (E8 must carry them). */
  readings?: readonly AcceptanceReading[]
  /** G6: who is attempting the write (acceptance-gate / human / other). */
  writer?: 'acceptance-gate' | 'human' | 'other'
  /** G5: the host observed a dead chain this transition (E13/E14 evidence). */
  stalled?: boolean
}

/** Structural mirror of one dispatch binding row (see module doc). */
interface BindingRow { taskRef?: unknown; sessionId?: unknown }

/** Canonical session-id spelling (workspace store mixes bare uuids). */
function canonicalSessionId(id: string): string {
  return id.startsWith('session-') ? id : `session-${id}`
}

/**
 * Live binding count for one taskRef: a binding counts as live when its
 * session sits in some workspace's `sessionIds` and not in
 * `global.archivedSessionIds`. Unreadable inputs fail CLOSED for G2 here
 * (unlike dispatch's fail-open dedupe): a broken ledger must not wave a
 * duplicate dispatch through the FSM gate.
 */
export function countLiveBindings(dshHome: string, taskRef: string): number {
  const bindingsPath = join(dshHome, 'dispatch-bindings.json')
  const storePath = join(dshHome, 'storages', 'workspace.json')
  if (!existsSync(bindingsPath)) return 0
  let rows: BindingRow[] = []
  try {
    const doc = JSON.parse(readFileSync(bindingsPath, 'utf8')) as { bindings?: unknown }
    rows = Array.isArray(doc.bindings) ? (doc.bindings as BindingRow[]) : []
  } catch {
    return Number.NaN // fail-closed marker: caller's guard refuses on NaN
  }
  const mine = rows.filter((row) => row.taskRef === taskRef && typeof row.sessionId === 'string')
  if (mine.length === 0) return 0
  if (!existsSync(storePath)) return Number.NaN
  try {
    const store = JSON.parse(readFileSync(storePath, 'utf8')) as {
      global?: { archivedSessionIds?: unknown }
      tables?: { workspaces?: Record<string, { sessionIds?: unknown } | null> }
    }
    const archived = new Set<string>()
    if (Array.isArray(store.global?.archivedSessionIds)) {
      for (const id of store.global.archivedSessionIds) if (typeof id === 'string') archived.add(canonicalSessionId(id))
    }
    const alive = new Set<string>()
    for (const row of Object.values(store.tables?.workspaces ?? {})) {
      if (!Array.isArray(row?.sessionIds)) continue
      for (const id of row.sessionIds) {
        if (typeof id === 'string') {
          const canonical = canonicalSessionId(id)
          if (!archived.has(canonical)) alive.add(canonical)
        }
      }
    }
    return mine.filter((row) => alive.has(canonicalSessionId(String(row.sessionId)))).length
  } catch {
    return Number.NaN
  }
}

/**
 * Build the per-transition guard deps.
 * @param opts - dsh home, current file (G3 scope registry), evidence, redisp cap (G5).
 * @returns GuardDeps wired to real sources, fail-closed everywhere.
 */
export function makeHostDeps(opts: {
  dshHome: string
  file: FsmFile
  evidence: TransitionEvidence
  maxRedisp: number
  /** Current record's redisp counter (G5 breaker input). */
  redisp: number
}): GuardDeps {
  return {
    taskbookHasWorktreePlan: () => opts.evidence.worktreePlan === true,
    liveBindings: (taskRef) => countLiveBindings(opts.dshHome, taskRef),
    scopeRegistered: (scope) => opts.file.scopes[scope] !== undefined,
    acceptanceReadings: () => opts.evidence.readings ?? [],
    heartbeat: () => ({ stalled: opts.evidence.stalled === true, redisp: opts.redisp, maxRedisp: opts.maxRedisp }),
    writer: () => opts.evidence.writer ?? 'other',
  }
}
