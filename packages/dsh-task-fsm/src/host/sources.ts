/**
 * Host wiring for G1–G3/G5 sources: the fsm file itself for G2 (「活」口径 =
 * 设计 §1P2 纯 FSM, fsm-rebind-1126) and G3 scope, and the evidence fields
 * the caller supplied for G1/G4/G6. The quick-ledger reads retired here
 * (`countLiveBindings` → `countLiveTaskSessions`): G2 no longer touches
 * dispatch-bindings.json / workspace.json — 防撞直接走 FSM state
 * (2026-11-25 拍 `fsm-dispatch-direction`)。
 * @module @linxin666/dsh-task-fsm/host/sources
 */

import type { AcceptanceReading, GuardDeps } from '../core/guards.ts'
import type { FsmFile } from '../core/schema.ts'
import { STATES } from '../core/table.ts'

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

/**
 * Live session count for one taskRef — the G2 source. 设计 §1P2 拍定「活」=
 * 纯 FSM：`state ∉ {done, cancelled}` ∧ `session.id 非空`（⛔ 不读
 * workspace.json archived 佐证）。An unreadable state fails CLOSED (returns
 * NaN; the guard refuses on NaN — 照现形): a corrupt record must not wave a
 * duplicate dispatch through the FSM gate.
 * @param file - the current fsm file (already parsed; the store fails closed on corrupt JSON).
 * @param taskRef - the task to count live sessions for.
 * @returns 0 / 1 for a readable record (NaN = state unreadable → fail-closed).
 */
export function countLiveTaskSessions(file: FsmFile, taskRef: string): number {
  const record = file.tasks[taskRef]
  if (record === undefined) return 0
  const state = record.state
  if (typeof state !== 'string' || !STATES.includes(state)) return Number.NaN
  if (state === 'done' || state === 'cancelled') return 0
  const id = record.session?.id
  return typeof id === 'string' && id !== '' ? 1 : 0
}

/**
 * Build the per-transition guard deps.
 * @param opts - dsh home (retained for caller wiring; G2 no longer reads it after fsm-rebind-1126), current file (G2 live sessions + G3 scope registry), evidence, redisp cap (G5).
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
    liveTaskSessions: (taskRef) => countLiveTaskSessions(opts.file, taskRef),
    scopeRegistered: (scope) => opts.file.scopes[scope] !== undefined,
    acceptanceReadings: () => opts.evidence.readings ?? [],
    heartbeat: () => ({ stalled: opts.evidence.stalled === true, redisp: opts.redisp, maxRedisp: opts.maxRedisp }),
    writer: () => opts.evidence.writer ?? 'other',
  }
}
