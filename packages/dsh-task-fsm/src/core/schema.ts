/**
 * `~/.dsh/task-fsm-state.json` schema — the machine-authoritative store of
 * the pure-worker design (§2.6, 回执 `state-file-name` selected 2026-11-23:
 * flat single file with a `task-` prefix, taskbot-state 同构, never a
 * directory). The file is host-owned; the board row stays the human ledger
 * face (§3.4 双面分工). This module is pure: no filesystem, no clock.
 * @module @linxin666/dsh-task-fsm/core/schema
 */

import z from 'schemastery'
import type { EventId, State } from './table.ts'
import { EVENTS, STATES } from './table.ts'

/** Queue tier (C 轴, derived field §2.2). */
export type QueueTier = 'none' | 'red' | 'yellow'

/** D 机看态 (§2.2): active / ❄️ frozen / 🔒 locked. */
export type SessionMode = 'active' | 'frozen' | 'locked'

/**
 * 冻结控制态（§6.4 三态，裁定 #16）: per-record machine-authority pin.
 *   · `auto`（缺省 = 自动托管）— 机器按 §6.2 权限表 + 双阈值该冻冻该醒醒;
 *   · `human-freeze`（人工冻结）— 人冻的，机器自动醒一律跳过（只有人能解）;
 *   · `human-thaw`（人工解冻）— 人保的豁免期，机器自动冻一律跳过（可撤回 auto）.
 * 落 TaskRecord 顶层（⛔ 不落 session 节点 — E4/E7 会整节点重建，附加字段会丢）。
 */
export type FreezeControl = 'auto' | 'human-freeze' | 'human-thaw'

/**
 * Rebind pseudo-events (fsm-rebind-1126, 设计 §3.1 换绑原子事件): history-only
 * marks — NOT transition-table events. The six-state matrix stays
 * closed (⛔ 非 E22), and these never join `EVENTS` / `EVENT_LABELS`.
 */
export type RebindEvent = 'rebind-in' | 'rebind-out'

/** The two rebind history events (schema validation face). */
export const REBIND_EVENTS: readonly RebindEvent[] = ['rebind-in', 'rebind-out']

/**
 * Retired transition events (freeze-reclaim-phase2-1127 分期4, 裁定 #19):
 * E2「开工核验过」lost its premise (核验前置到派发, 设计 §6.5) and was deleted
 * from the transition table — but existing ledgers still carry E2 history
 * entries and `parseFsmFile` fail-closes on unknown events, so the READ face
 * keeps tolerating them exactly like the rebind marks: history-only, never
 * in `EVENTS` / `EVENT_LABELS`, and unfirable (the transition route rejects
 * them through `isEventId`).
 */
export type RetiredEvent = 'E2'

/** The retired history events (schema validation face). */
export const RETIRED_EVENTS: readonly RetiredEvent[] = ['E2']

/**
 * `session-attach` pseudo-event (event-axis-attach-1127, 设计 §2 案B): the
 * attach handler's structural write (session.id backfill) leaves this audit
 * trail entry — history-face only, same pattern as the rebind marks. NOT a
 * transition-table event: from = to = current state, it never joins `EVENTS`
 * / `EVENT_LABELS`, and it carries no `cellFor` cell (⛔ 非 E22).
 */
export type SessionAttachEvent = 'session-attach'

/** The session-attach history event (schema validation face). */
export const ATTACH_EVENTS: readonly SessionAttachEvent[] = ['session-attach']

/** One history entry appended by every accepted transition (§2.6). */
export interface HistoryEntry {
  event: EventId | RebindEvent | RetiredEvent | SessionAttachEvent
  from: State
  to: State
  at: string
  /** rebind 强制切留痕（§3.2 force 分支）：`kind:'forced'` 时 `forceReason` 非空。 */
  kind?: 'forced'
  forceReason?: string
}

/** Session node of one task record (D axis + hover freeze reason source). */
export interface SessionNode {
  id: string
  mode: SessionMode
  /** 冻结原因（hover 源, §3.1）；空串 = 无原因。 */
  reason: string
}

/** One task's FSM record (§2.6 shape + two derived-queue inputs). */
export interface TaskRecord {
  version: 1
  taskRef: string
  scope: string
  state: State
  /** 派生字段（C 轴）：written by `deriveQueue` on every transition. */
  queue: QueueTier
  /** 任务标题（会话行预立用, §3.1 名字 = 任务标题）。 */
  title?: string
  /** G1 证据：任务书 worktree 预案（create 时落，E1 过闸读此字段）。 */
  worktreePlan?: string
  /** 根 worker 标记（§5 归档分层：只有根做终态通知）。 */
  root?: boolean
  /** 父任务 taskRef（§5 子 worker 父归）。 */
  parent?: string
  /** B/C 轴机器原因 id — deriveQueue 的输入（如 prereq-unruled / autofix-blowout）。 */
  cause?: string
  /** `[x] 待查收` 子注（E18/E19, §5）。 */
  pendingAck?: boolean
  /**
   * 冻结控制态（§6.4 三态，裁定 #16）；缺省 = 自动托管。人面写入 =
   * `POST /api/task-fsm/freeze-control`（结构字段，不写 history）。
   */
  freezeControl?: FreezeControl
  session?: SessionNode
  attempts: { redisp: number; autofix: number }
  history: HistoryEntry[]
}

/** 人开 scope 声明（§8.2 必填项的机器载体）。 */
export interface ScopeDecl {
  intent: string
  prio: 'red' | 'yellow'
  wake?: 'quota-first' | 'prereq-first'
  declaredAt: string
}

/** The whole file (flat: one JSON document, keyed maps inside). */
export interface FsmFile {
  version: 1
  scopes: Record<string, ScopeDecl>
  tasks: Record<string, TaskRecord>
}

const StateSchema = z.union(STATES.map((s) => z.const(s)) as [ReturnType<typeof z.const>, ...ReturnType<typeof z.const>[]])
const QueueSchema = z.union([z.const('none'), z.const('red'), z.const('yellow')])
const ModeSchema = z.union([z.const('active'), z.const('frozen'), z.const('locked')])

/** E1, E3–E21 plus the rebind / session-attach pseudo-events and retired E2 (history face only). */
const HistoryEventSchema = z.union([
  ...EVENTS.map((e) => z.const(e)),
  ...REBIND_EVENTS.map((e) => z.const(e)),
  ...ATTACH_EVENTS.map((e) => z.const(e)),
  ...RETIRED_EVENTS.map((e) => z.const(e)),
] as [ReturnType<typeof z.const>, ...ReturnType<typeof z.const>[]])

const HistorySchema = z.object({
  event: HistoryEventSchema,
  from: StateSchema,
  to: StateSchema,
  at: z.string(),
  kind: z.const('forced'),
  forceReason: z.string(),
})

const SessionSchema = z.object({
  id: z.string(),
  mode: ModeSchema,
  reason: z.string().default(''),
})

const RecordSchema = z.object({
  version: z.const(1),
  taskRef: z.string(),
  scope: z.string().default(''),
  state: StateSchema,
  queue: QueueSchema,
  title: z.string(),
  worktreePlan: z.string(),
  root: z.boolean(),
  parent: z.string(),
  cause: z.string(),
  pendingAck: z.boolean(),
  // §6.4 三态（裁定 #16）：缺省缺位 = 自动托管；在位则必须是三值之一（fail-closed）。
  freezeControl: z.union([z.const('auto'), z.const('human-freeze'), z.const('human-thaw')]),
  session: SessionSchema,
  attempts: z.object({ redisp: z.number().default(0), autofix: z.number().default(0) }),
  history: z.array(HistorySchema).default([]),
})

const ScopeSchema = z.object({
  intent: z.string().default(''),
  prio: z.union([z.const('red'), z.const('yellow')]),
  wake: z.union([z.const('quota-first'), z.const('prereq-first')]),
  declaredAt: z.string(),
})

/**
 * Nameable output shape of the file schema — an explicit annotation keeps
 * declaration emit portable (TS2883: the inferred type would otherwise name
 * cosmokit's `Dict` through the dict schema).
 */
export interface FsmFileShape {
  version: 1
  scopes: Record<string, ScopeDecl>
  tasks: Record<string, TaskRecord>
}

/** Schema-level parse (structure + enum domains). Throws on violation. */
export const FsmFileSchema: z<FsmFileShape> = z.object({
  version: z.const(1),
  scopes: z.dict(ScopeSchema, z.string()).default({}),
  tasks: z.dict(RecordSchema, z.string()).default({}),
}) as z<FsmFileShape>

/**
 * Semantic checks first (loud, specific messages), then the structural
 * schema: a record must live under its own taskRef key, its state must be
 * one of the six, and history events must be E1, E3–E21 (plus rebind marks
 * and retired E2 — read-face tolerance, see `RETIRED_EVENTS`). The structural layer
 * is permissive about missing keys (schemastery object semantics), so this
 * layer carries the invariants the machine depends on.
 * @param raw - unknown JSON value.
 * @returns the validated file.
 * @throws Error / ValidationError when checks fail.
 */
export function parseFsmFile(raw: unknown): FsmFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('task-fsm-state: document must be an object')
  }
  const tasks = (raw as { tasks?: unknown }).tasks
  if (typeof tasks === 'object' && tasks !== null && !Array.isArray(tasks)) {
    for (const [key, value] of Object.entries(tasks as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`task-fsm-state: task "${key}" is not an object`)
      }
      const record = value as { taskRef?: unknown; state?: unknown; history?: unknown }
      if (record.taskRef !== key) {
        throw new Error(`task-fsm-state: task "${key}" holds taskRef "${String(record.taskRef)}" (key/record mismatch)`)
      }
      if (typeof record.state !== 'string' || !STATES.includes(record.state as State)) {
        throw new Error(`task-fsm-state: task "${key}" has unknown state "${String(record.state)}"`)
      }
      if (Array.isArray(record.history)) {
        for (const entry of record.history) {
          const event = (entry as { event?: unknown } | null)?.event
          const known = typeof event === 'string'
            && ((EVENTS as readonly string[]).includes(event)
              || (REBIND_EVENTS as readonly string[]).includes(event)
              || (ATTACH_EVENTS as readonly string[]).includes(event)
              || (RETIRED_EVENTS as readonly string[]).includes(event))
          if (!known) {
            throw new Error(`task-fsm-state: task "${key}" history holds unknown event "${String(event)}"`)
          }
        }
      }
    }
  }
  // Input cast: the schema still validates every field at runtime (its call
  // signature is the nameable FsmFileShape for declaration-emit portability).
  return FsmFileSchema(raw as FsmFileShape) as FsmFile
}

/**
 * An empty file document (store creation default).
 * @returns `{ version: 1, scopes: {}, tasks: {} }`.
 */
export function emptyFsmFile(): FsmFile {
  return { version: 1, scopes: {}, tasks: {} }
}
