/**
 * 分期2 验收夹具（freeze-reclaim-phase2-1127, §6.5 施工序①）:
 * E1 拆冻结副作用 —— 排队位迁移零冻结副作用、冻结改由新驱动面可达、
 * 存量 frozen 行为不回退。
 *
 * 判据（dispatch 固定，生产方不可改）:
 *  ① 构造 E1 迁移 → 无 mode 变化到 frozen / 无 freeze 副作用（reason 不落排队位）；
 *  ② 冻结仍可从新驱动面到达（watcher 的 E7 cell + E5 缺前置）；
 *  ③ 存量 frozen 行（排队位 reason）wake 路径不回退（E4 quota-free 解冻照旧）。
 *
 * test-standards-allow: dsh-task-fsm machine-behavior fixture — no user role
 * exists for a transition-table cell (bdd-title would be fiction, the script
 * header says so itself); bodies are seed -> act -> assert (corpus style).
 */
import { describe, expect, it } from 'vitest'
import { applyTransition, type TransitionPayload } from '../src/core/fsm.ts'
import { cellFor } from '../src/core/table.ts'
import type { GuardDeps } from '../src/core/guards.ts'
import type { TaskRecord } from '../src/core/schema.ts'

function deps(overrides: Partial<GuardDeps> = {}): GuardDeps {
  return {
    taskbookHasWorktreePlan: () => true,
    liveTaskSessions: () => 0,
    scopeRegistered: () => true,
    acceptanceReadings: () => [{ name: 'vitest', ok: true }],
    heartbeat: () => ({ stalled: false, redisp: 0, maxRedisp: 3 }),
    writer: () => 'acceptance-gate',
    ...overrides,
  }
}

function backlogRecord(extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    taskRef: 'content/tech/ai/dsh/tasks.md#e1-split',
    scope: 'content/tech/ai/dsh',
    state: 'backlog',
    queue: 'none',
    attempts: { redisp: 0, autofix: 0 },
    history: [],
    ...extra,
  }
}

const payload: TransitionPayload = { at: '2026-11-27T00:00:00.000Z' }

describe('E1 拆冻结副作用（§6.5 施工序①）', () => {
  it('① E1 binds the id and births the session active — zero freeze side-effect', () => {
    const result = applyTransition(backlogRecord(), 'E1', deps(), { ...payload, sessionId: 'session-new' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 无 mode 变化到 frozen、无排队位 reason、无 cause 落盘。
    expect(result.record.session).toEqual({ id: 'session-new', mode: 'active', reason: '' })
    expect(result.record.cause).toBeUndefined()
    expect(JSON.stringify(result.record)).not.toContain('frozen')
    expect(JSON.stringify(result.record)).not.toContain('排队位')
    expect(result.record.history.map((h) => h.event)).toEqual(['E1'])
  })

  it('① E1 without a payload still never freezes (nothing to bind → no D-axis write)', () => {
    const result = applyTransition(backlogRecord(), 'E1', deps(), payload)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 无 payload ∧ 无既有节点 → 零绑定零冻结（路由侧 parse 物化节点的形态
    // 由 session-attach 夹具覆盖：生而 active、id 空待补绑）。
    expect(result.record.session).toBeUndefined()
    expect(JSON.stringify(result.record)).not.toContain('frozen')
  })

  it('② freeze stays reachable through the new driver faces (watcher E7 + E5)', () => {
    // watcher 驱动面：active × E7 仍带冻结效果（双阈值只改触发线，不改冻结语义）。
    const e7 = cellFor('active', 'E7')
    expect(e7?.kind).toBe('transfer')
    if (e7?.kind !== 'transfer') return
    expect(e7.effects?.sessionMode).toBe('frozen')

    const active = backlogRecord({
      state: 'active',
      session: { id: 'session-run', mode: 'active', reason: '' },
    })
    const frozen = applyTransition(active, 'E7', deps(), { ...payload, reason: '内存地板' })
    expect(frozen.ok).toBe(true)
    if (!frozen.ok) return
    expect(frozen.record.session?.mode).toBe('frozen')
    expect(frozen.record.session?.reason).toBe('内存地板')
    expect(frozen.record.cause).toBe('quota-wait')

    // 宣告面（缺前置）：active × E5 同样落冻结。
    const e5 = applyTransition(active, 'E5', deps(), payload)
    expect(e5.ok).toBe(true)
    if (e5.ok) expect(e5.record.session?.mode).toBe('frozen')
  })

  it('③ legacy frozen rows keep their wake path (存量排队位不回退)', () => {
    // 存量形态：watcher/旧 E1 落下的 frozen + 排队位 reason + quota-wait cause。
    const legacy = backlogRecord({
      state: 'active',
      session: { id: 'session-legacy', mode: 'frozen', reason: '排队位：等待开工核验' },
      cause: 'quota-wait',
      history: [{ event: 'E1', from: 'backlog', to: 'active', at: '2026-11-26T00:00:00.000Z' }],
    })
    const woke = applyTransition(legacy, 'E4', deps(), payload)
    expect(woke.ok).toBe(true)
    if (!woke.ok) return
    expect(woke.record.session).toEqual({ id: 'session-legacy', mode: 'active', reason: '' })
    expect(woke.record.state).toBe('active')
    // 存量留痕原样保留（只追加 E4，不改写既有历史行）。
    expect(woke.record.history.map((h) => h.event)).toEqual(['E1', 'E4'])
    expect(woke.record.history[0]).toEqual(legacy.history[0])
  })
})
