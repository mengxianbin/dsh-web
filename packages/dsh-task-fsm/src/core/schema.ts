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

/** One history entry appended by every accepted transition (§2.6). */
export interface HistoryEntry {
  event: EventId
  from: State
  to: State
  at: string
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
const EventSchema = z.union(EVENTS.map((e) => z.const(e)) as [ReturnType<typeof z.const>, ...ReturnType<typeof z.const>[]])
const QueueSchema = z.union([z.const('none'), z.const('red'), z.const('yellow')])
const ModeSchema = z.union([z.const('active'), z.const('frozen'), z.const('locked')])

const HistorySchema = z.object({
  event: EventSchema,
  from: StateSchema,
  to: StateSchema,
  at: z.string(),
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
 * one of the six, and history events must be E1–E21. The structural layer
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
          if (typeof event !== 'string' || !EVENTS.includes(event as EventId)) {
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
