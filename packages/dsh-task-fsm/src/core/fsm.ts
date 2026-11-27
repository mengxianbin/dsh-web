/**
 * Transition applier — the runtime half of design §2.3: look the (state,
 * event) cell up in the table, run its guards, apply its effects, append
 * history, re-derive the queue tier. Refusals are structured (never thrown
 * surprises): forbidden / not-applicable / guard-refused / token-refused.
 * Complete matrix coverage is a TEST-time assertion (§2.3), not runtime work.
 * @module @linxin666/dsh-task-fsm/core/fsm
 */

import { cellFor, type EventId, type State, type TransferCell } from './table.ts'
import { runGuard, type GuardDeps } from './guards.ts'
import type { TaskRecord } from './schema.ts'
import { deriveQueue } from './queue.ts'

/** Event payload the caller supplies (ruling target, freeze reason, clock). */
export interface TransitionPayload {
  /** ISO timestamp for the history entry (test seam; defaults to now). */
  at?: string
  /** E21 dynamic target state (按裁定转移). */
  to?: State
  /** Human freeze/wait reason mirrored into session.reason (hover 源 §3.1). */
  reason?: string
  /** E21 token: the ruling receipt landed on the board (设计行守卫列). */
  rulingReceipt?: boolean
  /** Session id to attach at pre-establish (E1 预立行, §3.1). */
  sessionId?: string
}

export type RefusalKind = 'no-cell' | 'forbidden' | 'not-applicable' | 'guard-refused' | 'token-refused'

export interface TransitionRefusal {
  ok: false
  kind: RefusalKind
  detail: string
  guard?: string
}

export interface TransitionSuccess {
  ok: true
  record: TaskRecord
  cell: TransferCell
}

export type TransitionResult = TransitionSuccess | TransitionRefusal

const refuse = (kind: RefusalKind, detail: string, guard?: string): TransitionRefusal => ({
  ok: false, kind, detail, ...(guard !== undefined ? { guard } : {}),
})

/**
 * Apply one event to one record.
 * @param record - current record (not mutated).
 * @param event - E1, E3–E21 (the former 开工核验过 event retired, freeze-reclaim-phase2-1127 分期4).
 * @param deps - injected guard sources (fail-closed inside each guard).
 * @param payload - event payload (clock, ruling target, freeze reason).
 * @returns the new record or a structured refusal.
 */
export function applyTransition(
  record: TaskRecord,
  event: EventId,
  deps: GuardDeps,
  payload: TransitionPayload = {},
): TransitionResult {
  const cell = cellFor(record.state, event)
  if (cell === undefined) return refuse('no-cell', `completeness hole: ${record.state} × ${event} (test-time assertion broken)`)
  if (cell.kind === 'forbid') return refuse('forbidden', cell.why)
  if (cell.kind === 'na') return refuse('not-applicable', cell.why)

  // Guards, in table order: G1–G6 run against deps; the two cell-local
  // tokens (ack-pending / ruling-receipt) are record/payload preconditions.
  for (const guardId of cell.guards) {
    if (guardId === 'ack-pending') {
      if (record.pendingAck !== true) return refuse('token-refused', 'E19 需要待查收子注在场（E18 先行）', guardId)
      continue
    }
    if (guardId === 'ruling-receipt') {
      if (payload.rulingReceipt !== true) return refuse('token-refused', 'E21 需要裁定回执落板行随注（设计行守卫列）', guardId)
      continue
    }
    const result = runGuard(guardId, deps, { taskRef: record.taskRef, scope: record.scope, event })
    if (!result.ok) return refuse('guard-refused', result.detail, result.guard)
  }

  let to: State
  if (cell.to === 'dynamic') {
    if (payload.to === undefined) return refuse('token-refused', 'E21 按裁定转移：缺 payload.to（裁定目标态）', 'ruling-receipt')
    to = payload.to
  } else {
    to = cell.to
  }

  const effects = cell.effects
  const next: TaskRecord = {
    ...record,
    state: to,
    attempts: { ...record.attempts },
    history: [...record.history, { event, from: record.state, to, at: payload.at ?? new Date().toISOString() }],
  }

  // D 机看态 (§2.2/§3.1): freeze mark, release, or clear.
  if (effects?.sessionMode !== undefined && effects.sessionMode !== 'cleared') {
    const sessionId = payload.sessionId ?? record.session?.id ?? ''
    if (effects.sessionMode === 'frozen') {
      next.session = {
        id: sessionId,
        mode: 'frozen',
        reason: payload.reason ?? effects.reason ?? record.session?.reason ?? '',
      }
    } else if (sessionId !== '' || record.session !== undefined) {
      next.session = { id: sessionId, mode: 'active', reason: '' }
    }
  } else if (effects?.sessionMode === 'cleared' && record.session !== undefined) {
    next.session = { id: record.session.id, mode: 'active', reason: '' }
  }

  // B/C 轴 cause (derived-queue input).
  if (effects?.cause !== undefined) next.cause = effects.cause
  if (effects?.clearCause === true) delete next.cause

  // §2.6 attempts counters.
  for (const counter of effects?.counters ?? []) {
    next.attempts[counter] = (next.attempts[counter] ?? 0) + 1
  }

  // §5 终态通知子注.
  if (effects?.pendingAck !== undefined) next.pendingAck = effects.pendingAck

  // C 轴 is derived (§2.2): recompute on every accepted transition.
  next.queue = deriveQueue(next).tier
  return { ok: true, record: next, cell }
}
