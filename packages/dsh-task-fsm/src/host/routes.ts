/**
 * HTTP routes for dsh-task-fsm. All loopback-fenced; bodies bounded JSON.
 * Surface (host machine authority, §2.1):
 *   GET  /api/task-fsm/state            — full fsm file (ledger debug face)
 *   GET  /api/task-fsm/session?id=…     — one session's queue/reason/four-piece
 *   GET  /api/task-fsm/notify           — `[x] 待查收` root terminals (E18 list)
 *   GET  /api/task-fsm/archive-plan?taskRef= — §5 archive layering verdict
 *   POST /api/task-fsm/scope            — human-opened scope declaration (§8.2)
 *   POST /api/task-fsm/create           — pre-establish a task record (E1 预立)
 *   POST /api/task-fsm/transition       — apply E1–E21 through the guard table
 *   POST /api/task-fsm/wake             — the two wake triggers (§3.3)
 *   POST /api/task-fsm/ack              — E19 human receipt
 * @module dsh-task-fsm/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { applyTransition, type TransitionPayload, type TransitionRefusal } from '../core/fsm.ts'
import { deriveQueue } from '../core/queue.ts'
import { deriveSubReasons } from '../core/subreason.ts'
import { archivePlan, pendingReceipts } from '../core/archive.ts'
import type { FsmFile, ScopeDecl, TaskRecord } from '../core/schema.ts'
import { EVENTS, type EventId } from '../core/table.ts'
import { FsmStore } from './store.ts'
import { makeHostDeps, type TransitionEvidence } from './sources.ts'
import { readBoundedJson, writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'

export const TASK_FSM_API_PREFIX = '/api/task-fsm'

/** Transition bodies carry evidence blocks; 64 KiB is ample. */
const BODY_MAX_BYTES = 64 * 1024

export interface FsmRouteServices {
  store: FsmStore
  dshHome: string
  /** G5 redisp breaker cap (design §6.1 N 建议初值 3, 判据归人). */
  maxRedisp: number
}

/** Discriminated result of one read-modify-write transition attempt. */
type UpdateOutcome =
  | { status: 404; error: string }
  | { status: 409; error: string }
  | { status: 409; refusal: TransitionRefusal }
  | { status: 200; record: TaskRecord }

function fenced(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'loopback only' })
    return false
  }
  return true
}

function isEventId(value: unknown): value is EventId {
  return typeof value === 'string' && (EVENTS as readonly string[]).includes(value)
}

function isObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Build the per-request deps: record-derived G1/G5 inputs + caller evidence. */
function depsFor(services: FsmRouteServices, file: FsmFile, record: TaskRecord, evidence: TransitionEvidence) {
  return makeHostDeps({
    dshHome: services.dshHome,
    file,
    evidence: {
      ...evidence,
      worktreePlan: evidence.worktreePlan ?? (record.worktreePlan !== undefined && record.worktreePlan !== ''),
    },
    maxRedisp: services.maxRedisp,
    redisp: record.attempts.redisp,
  })
}

/** The hover projection of one record (queue verdict + four-piece, §4.1/§4.2). */
export function sessionView(record: TaskRecord) {
  const verdict = deriveQueue(record)
  return {
    taskRef: record.taskRef,
    title: record.title,
    state: record.state,
    queue: verdict,
    session: record.session,
    subreasons: deriveSubReasons(record),
    pendingAck: record.pendingAck === true,
  }
}

export function makeTaskFsmRoutes(services: FsmRouteServices): WebRoute[] {
  const { store } = services

  const state: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/state`,
    handler: (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' }); return }
      try {
        writeJson(res, 200, { ok: true, file: store.load() })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const session: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/session`,
    handler: (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' }); return }
      const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('id') ?? ''
      try {
        const file = store.load()
        const record = Object.values(file.tasks).find((r) => r.session?.id === id)
        if (record === undefined) { writeJson(res, 404, { ok: false, found: false }); return }
        writeJson(res, 200, { ok: true, found: true, view: sessionView(record) })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const notify: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/notify`,
    handler: (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' }); return }
      try {
        const file = store.load()
        writeJson(res, 200, { ok: true, pending: pendingReceipts(file).map(sessionView) })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const archive: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/archive-plan`,
    handler: (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' }); return }
      const taskRef = new URL(req.url ?? '', 'http://localhost').searchParams.get('taskRef') ?? ''
      if (taskRef === '') { writeJson(res, 400, { ok: false, error: 'taskRef query required' }); return }
      try {
        const file = store.load()
        if (file.tasks[taskRef] === undefined) { writeJson(res, 404, { ok: false, error: 'unknown taskRef' }); return }
        writeJson(res, 200, { ok: true, plan: archivePlan(file, taskRef) })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const scope: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/scope`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' }); return }
      let body: Record<string, unknown> | undefined
      try { body = isObject(await readBoundedJson(req, BODY_MAX_BYTES)) } catch { /* fallthrough */ }
      const key = typeof body?.key === 'string' ? body.key : ''
      const prio = body?.prio === 'red' || body?.prio === 'yellow' ? body.prio : undefined
      if (body === undefined || key === '' || prio === undefined) {
        writeJson(res, 400, { ok: false, error: 'body needs { key, prio: red|yellow, intent?, wake? }' }); return
      }
      try {
        const result = store.update((file) => {
          if (file.scopes[key] !== undefined) return { conflict: true }
          const decl: ScopeDecl = {
            intent: typeof body.intent === 'string' ? body.intent : '',
            prio,
            ...(body.wake === 'quota-first' || body.wake === 'prereq-first' ? { wake: body.wake } : {}),
            declaredAt: new Date().toISOString(),
          }
          file.scopes[key] = decl
          return { conflict: false, decl }
        })
        if (result.conflict) { writeJson(res, 409, { ok: false, error: `scope already declared: ${key}` }); return }
        writeJson(res, 200, { ok: true, scope: result.decl })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const create: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/create`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' }); return }
      let body: Record<string, unknown> | undefined
      try { body = isObject(await readBoundedJson(req, BODY_MAX_BYTES)) } catch { /* fallthrough */ }
      const taskRef = typeof body?.taskRef === 'string' ? body.taskRef : ''
      const worktreePlan = typeof body?.worktreePlan === 'string' ? body.worktreePlan : ''
      if (body === undefined || taskRef === '' || worktreePlan === '') {
        // G1 fail-closed at the door: a record without a worktree 预案 can
        // never pass E1 anyway — refuse early with the same reason.
        writeJson(res, 400, { ok: false, error: 'body needs { taskRef, worktreePlan, scope?, title?, root?, parent? }' }); return
      }
      try {
        const result = store.update((file) => {
          if (file.tasks[taskRef] !== undefined) return { conflict: true }
          const record: TaskRecord = {
            version: 1,
            taskRef,
            scope: typeof body.scope === 'string' ? body.scope : '',
            state: 'backlog',
            queue: 'none',
            worktreePlan,
            ...(typeof body.title === 'string' ? { title: body.title } : {}),
            ...(body.root === true ? { root: true } : {}),
            ...(typeof body.parent === 'string' ? { parent: body.parent } : {}),
            attempts: { redisp: 0, autofix: 0 },
            history: [],
          }
          file.tasks[taskRef] = record
          return { conflict: false, record }
        })
        if (result.conflict) { writeJson(res, 409, { ok: false, error: `task already exists: ${taskRef}` }); return }
        writeJson(res, 200, { ok: true, record: result.record })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const transition: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/transition`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' }); return }
      let body: Record<string, unknown> | undefined
      try { body = isObject(await readBoundedJson(req, BODY_MAX_BYTES)) } catch { /* fallthrough */ }
      const taskRef = typeof body?.taskRef === 'string' ? body.taskRef : ''
      const event = isEventId(body?.event) ? body.event : undefined
      if (body === undefined || taskRef === '' || event === undefined) {
        writeJson(res, 400, { ok: false, error: 'body needs { taskRef, event: E1..E21, evidence?, payload? }' }); return
      }
      const evidence = (isObject(body.evidence) ?? {}) as TransitionEvidence
      const rawPayload = isObject(body.payload) ?? {}
      const payload: TransitionPayload = {
        ...(typeof rawPayload.at === 'string' ? { at: rawPayload.at } : {}),
        ...(rawPayload.to !== undefined && ['backlog', 'active', 'deferred', 'blocked', 'done', 'cancelled'].includes(String(rawPayload.to))
          ? { to: rawPayload.to as TransitionPayload['to'] } : {}),
        ...(typeof rawPayload.reason === 'string' ? { reason: rawPayload.reason } : {}),
        ...(rawPayload.rulingReceipt === true ? { rulingReceipt: true } : {}),
        ...(typeof rawPayload.sessionId === 'string' ? { sessionId: rawPayload.sessionId } : {}),
      }
      try {
        const outcome = store.update<UpdateOutcome>((file) => {
          const record = file.tasks[taskRef]
          if (record === undefined) return { status: 404 as const, error: 'unknown taskRef' }
          const result = applyTransition(record, event, depsFor(services, file, record, evidence), payload)
          if (!result.ok) return { status: 409 as const, refusal: result }
          file.tasks[taskRef] = result.record
          return { status: 200 as const, record: result.record }
        })
        if ('error' in outcome) { writeJson(res, outcome.status, { ok: false, error: outcome.error }); return }
        if ('refusal' in outcome) {
          writeJson(res, outcome.status, { ok: false, kind: outcome.refusal.kind, detail: outcome.refusal.detail, ...(outcome.refusal.guard !== undefined ? { guard: outcome.refusal.guard } : {}) })
          return
        }
        writeJson(res, 200, { ok: true, record: outcome.record, queue: deriveQueue(outcome.record) })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const wake: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/wake`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' }); return }
      let body: Record<string, unknown> | undefined
      try { body = isObject(await readBoundedJson(req, BODY_MAX_BYTES)) } catch { /* fallthrough */ }
      const taskRef = typeof body?.taskRef === 'string' ? body.taskRef : ''
      const trigger = body?.trigger
      if (body === undefined || taskRef === '' || (trigger !== 'prereq-terminal' && trigger !== 'quota-free')) {
        writeJson(res, 400, { ok: false, error: 'body needs { taskRef, trigger: prereq-terminal|quota-free }' }); return
      }
      try {
        const outcome = store.update<UpdateOutcome>((file) => {
          const record = file.tasks[taskRef]
          if (record === undefined) return { status: 404 as const, error: 'unknown taskRef' }
          if (record.session?.mode !== 'frozen' && record.session?.mode !== 'locked') {
            return { status: 409 as const, error: 'not frozen (nothing to wake)' }
          }
          // §3.3 唤醒两触发，事件集不扩（轴封闭）：
          //   prereq-terminal → E6（前置行 [x]/[-] 机械读 → 解冻续跑）
          //   quota-free      → E4 步进（配额闸放行 → 解除排队位冻结）
          const event: EventId = trigger === 'prereq-terminal' ? 'E6' : 'E4'
          const result = applyTransition(record, event, depsFor(services, file, record, { writer: 'human' }), {})
          if (!result.ok) return { status: 409 as const, refusal: result }
          file.tasks[taskRef] = result.record
          return { status: 200 as const, record: result.record }
        })
        if ('error' in outcome) { writeJson(res, outcome.status, { ok: false, error: outcome.error }); return }
        if ('refusal' in outcome) { writeJson(res, outcome.status, { ok: false, kind: outcome.refusal.kind, detail: outcome.refusal.detail }); return }
        writeJson(res, 200, { ok: true, woke: true, sessionId: outcome.record.session?.id, record: outcome.record })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const ack: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/ack`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' }); return }
      let body: Record<string, unknown> | undefined
      try { body = isObject(await readBoundedJson(req, BODY_MAX_BYTES)) } catch { /* fallthrough */ }
      const taskRef = typeof body?.taskRef === 'string' ? body.taskRef : ''
      if (body === undefined || taskRef === '') { writeJson(res, 400, { ok: false, error: 'body needs { taskRef }' }); return }
      try {
        const outcome = store.update<UpdateOutcome>((file) => {
          const record = file.tasks[taskRef]
          if (record === undefined) return { status: 404 as const, error: 'unknown taskRef' }
          // E19 人查收回执 — writer恒 human（G6 权限账 §6.2）。
          const result = applyTransition(record, 'E19', depsFor(services, file, record, { writer: 'human' }), {})
          if (!result.ok) return { status: 409 as const, refusal: result }
          file.tasks[taskRef] = result.record
          return { status: 200 as const, record: result.record }
        })
        if ('error' in outcome) { writeJson(res, outcome.status, { ok: false, error: outcome.error }); return }
        if ('refusal' in outcome) { writeJson(res, outcome.status, { ok: false, kind: outcome.refusal.kind, detail: outcome.refusal.detail }); return }
        writeJson(res, 200, { ok: true, record: outcome.record })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  return [state, session, notify, archive, scope, create, transition, wake, ack]
}
