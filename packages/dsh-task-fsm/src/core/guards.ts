/**
 * G1–G6 guard table (design §2.4) — pure predicates the host table-checks
 * before allowing a transition. Every guard is fail-closed: a throwing or
 * missing dependency refuses the transfer, never passes it (可用性评估 ④:
 * 拒新转移不静默). The runtime wires real sources; tests inject fakes.
 * @module @linxin666/dsh-task-fsm/core/guards
 */

import type { EventId } from './table.ts'

export type GuardId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6'

/** One acceptance reading of G4 (§6.1 机检读数). */
export interface AcceptanceReading { name: string; ok: boolean }

/** Injected sources every guard reads (host wiring / test fakes). */
export interface GuardDeps {
  /** G1: the taskbook for this taskRef carries a worktree 预案 (dispatch 前置断言). */
  taskbookHasWorktreePlan(taskRef: string): boolean
  /** G2: live FSM sessions for this taskRef (设计 §1P2「活」口径, 409 防双跑). */
  liveTaskSessions(taskRef: string): number
  /** G3: the task's scope is in a human-opened scope declaration (§8). */
  scopeRegistered(scope: string): boolean
  /** G4: machine readings for the acceptance gate (§6.1). */
  acceptanceReadings(): readonly AcceptanceReading[]
  /** G5: heartbeat liveness + redisp circuit breaker (revive 管线, §7.4). */
  heartbeat(): { stalled: boolean; redisp: number; maxRedisp: number }
  /** G6: who is attempting a terminal write (§6.2 权限账). */
  writer(): 'acceptance-gate' | 'human' | 'other'
}

export interface GuardResult {
  ok: boolean
  guard: GuardId
  detail: string
}

const pass = (id: GuardId, detail: string): GuardResult => ({ ok: true, guard: id, detail })
const deny = (id: GuardId, detail: string): GuardResult => ({ ok: false, guard: id, detail })

/** Guard the call runs inside — a throwing dep is a refusal, not a pass. */
function guard(guardId: GuardId, fn: () => GuardResult): GuardResult {
  try {
    return fn()
  } catch (error) {
    return deny(guardId, `dependency failed (fail-closed): ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** G1 worktree 预案闸 — 任务书必须含 worktree 预案，否则派 worker 被拦截. */
export function g1WorktreePlan(deps: GuardDeps, taskRef: string): GuardResult {
  return guard('G1', () => (deps.taskbookHasWorktreePlan(taskRef)
    ? pass('G1', 'worktree 预案在场')
    : deny('G1', '任务书缺 worktree 预案 → 拦截不开工')))
}

/**
 * G2 taskRef 409 — 同 taskRef FSM 活会话唯一（fsm-rebind-1126 改读 FSM
 * state，与派发口闸①同口径）. Fail-closed kept: an unreadable state (NaN)
 * denies, never passes.
 */
export function g2TaskRef409(deps: GuardDeps, taskRef: string): GuardResult {
  return guard('G2', () => {
    const live = deps.liveTaskSessions(taskRef)
    if (Number.isNaN(live)) return deny('G2', 'FSM state 读取失败（fail-closed）')
    return live === 0
      ? pass('G2', 'FSM 记录无 active 会话')
      : deny('G2', 'FSM 记录有 active 会话（409 防双跑）')
  })
}

/** G3 scope 在册 — taskRef 前缀 ∈ 人开 scope 声明（§8.1 结构闭集）. */
export function g3ScopeRegistered(deps: GuardDeps, scope: string): GuardResult {
  return guard('G3', () => (deps.scopeRegistered(scope)
    ? pass('G3', `scope 在册: ${scope || '(空)'}`)
    : deny('G3', `scope 未登记: ${scope || '(空)'}（开 scope 归人, §8.2）`)))
}

/** G4 验收闸 — 机检读数全绿才 E8（空读数 = 无证据 = 拒）. */
export function g4AcceptanceGate(deps: GuardDeps): GuardResult {
  return guard('G4', () => {
    const readings = deps.acceptanceReadings()
    if (readings.length === 0) return deny('G4', '零机检读数（无证据不放行）')
    const failed = readings.filter((r) => !r.ok).map((r) => r.name)
    return failed.length === 0
      ? pass('G4', `${readings.length} 项机检全绿`)
      : deny('G4', `机检红: ${failed.join(', ')}`)
  })
}

/** G5 心跳验活 — stalled 拒；redisp ≥ N 熔断拒（§7.4 机械重派计数）. */
export function g5Heartbeat(deps: GuardDeps): GuardResult {
  return guard('G5', () => {
    const hb = deps.heartbeat()
    if (hb.stalled) return deny('G5', '心跳超时（断链判死阈值在场）')
    if (hb.redisp >= hb.maxRedisp) return deny('G5', `重派 ${hb.redisp}/${hb.maxRedisp} 已熔断（停手人裁）`)
    return pass('G5', `心跳存活；重派 ${hb.redisp}/${hb.maxRedisp}`)
  })
}

/**
 * G6 终态写权限（§6.2 已裁 = 纳入 acceptance-gate 口径）:
 * `done` 终态写只许 acceptance-gate（机检全绿自动转）；`cancelled` 恒人触发；
 * 终态行上的 save/回执（E17/E19）两方皆可。判据本体仍 T2。
 */
export function g6TerminalWrite(deps: GuardDeps, event: EventId): GuardResult {
  return guard('G6', () => {
    const writer = deps.writer()
    if (writer === 'other') return deny('G6', '写入方不在权限账内（§6.2）')
    if (event === 'E8') {
      return writer === 'acceptance-gate'
        ? pass('G6', 'acceptance-gate 机检过 → 自动转 [x]')
        : deny('G6', '[x] 终态写只许 acceptance-gate（判据本体仍 T2）')
    }
    if (event === 'E15' || event === 'E16') {
      return writer === 'human'
        ? pass('G6', '人显式触发 [-]')
        : deny('G6', '[-] 恒人触发（自动的只有「验过」没有「放弃」）')
    }
    return writer === 'human' || writer === 'acceptance-gate'
      ? pass('G6', `终态行写入方 ${writer}`)
      : deny('G6', '终态行写入方不在权限账内')
  })
}

/** Run one guard by id (table consumption + the per-guard test seam). */
export function runGuard(
  id: GuardId,
  deps: GuardDeps,
  ctx: { taskRef: string; scope: string; event: EventId },
): GuardResult {
  switch (id) {
    case 'G1': return g1WorktreePlan(deps, ctx.taskRef)
    case 'G2': return g2TaskRef409(deps, ctx.taskRef)
    case 'G3': return g3ScopeRegistered(deps, ctx.scope)
    case 'G4': return g4AcceptanceGate(deps)
    case 'G5': return g5Heartbeat(deps)
    case 'G6': return g6TerminalWrite(deps, ctx.event)
  }
}
