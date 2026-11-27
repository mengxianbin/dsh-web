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
 *   POST /api/task-fsm/rebind           — 换绑原子事件 (fsm-rebind-1126 §3.1)
 *   POST /api/task-fsm/parent           — 板 → FSM parent 镜像最小写入口 (fsm-turnend-wire-1126)
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
import { ArchiveLeg } from './archive-leg.ts'
import { makeHostDeps, type TransitionEvidence } from './sources.ts'
import { readBoundedJson, writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'

export const TASK_FSM_API_PREFIX = '/api/task-fsm'

/** Transition bodies carry evidence blocks; 64 KiB is ample. */
const BODY_MAX_BYTES = 64 * 1024

/**
 * 404 body hint (S3, fsm-seam-archive-build-1125): 404 语义不变、只加字段——
 * 「查无」与「该走哪」一次说清（E1 缝落地后此形态应绝迹）。
 */
const HINT_UNKNOWN_TASKREF = 'task not registered — dispatch bypassed the E1 seam? run POST /api/task-fsm/create + transition E1 first (fsm-seam-archive-1125 方案A)'

export interface FsmRouteServices {
  store: FsmStore
  dshHome: string
  /** G5 redisp breaker cap (design §6.1 N 建议初值 3, 判据归人). */
  maxRedisp: number
  /**
   * S2 归档执行腿 (fsm-seam-archive-build-1125 §3.2): when absent, no E18
   * auto-notice and no archive POST ever fires — pre-leg deployments and
   * tests stay byte-identical.
   */
  leg?: ArchiveLeg
  /**
   * §3.2 切单硬拦的 seal-check 通路 (fsm-rebind-1126): absent = the default
   * loopback call to `POST /api/dsh-session-archive/seal-check` (现成端点,
   * ⛔ 不重造哨兵判读). Tests inject a fake verdict source (archive-leg
   * fetchImpl 同形).
   */
  sealCheck?: (input: { ids: readonly string[]; origin: string }) => Promise<SealCheckVerdict>
}

/** One seal-check verdict (the archive route's `{results:[{id,verdict,detail}]}` face). */
export interface SealCheckVerdict {
  verdict: string
  detail: string
}

/** §3.2 判读口径: `DONE|N_A` 放行, 其余一律拦（查不清即拦, fail-closed）。 */
const SEAL_PASS_VERDICTS: ReadonlySet<string> = new Set(['DONE', 'N_A'])

/** Discriminated result of one read-modify-write transition attempt. */
type UpdateOutcome =
  | { status: 404; error: string }
  | { status: 409; error: string }
  | { status: 409; refusal: TransitionRefusal }
  | { status: 200; record: TaskRecord }

/** Rebind request body (§3.1): A = from, B = to, 本会话 = sessionId. */
interface RebindPayload {
  fromTaskRef: string
  toTaskRef: string
  sessionId: string
  force: boolean
  forceReason: string
}

/**
 * Structured rebind refusal — the `fsm.ts:29-44` 409+kind+detail shape;
 * a missing record answers 404 kind=not-found (判据①).
 */
export type RebindRefusal =
  | { status: 404; kind: 'not-found'; detail: string }
  | { status: 409; kind: 'a-terminal' | 'dual-bound' | 'seal-required'; detail: string; verdict?: string }

/** Result of one `checkRebind` pass: the two validated records, or a refusal. */
type RebindCheck = { refusal: RebindRefusal } | { from: TaskRecord; to: TaskRecord }

/** Discriminated result of the single-transaction rebind update. */
type RebindOutcome = { status: 200; from: TaskRecord; to: TaskRecord } | { refusal: RebindRefusal }

/**
 * §3.1 前置校验 — existence (404) / A 非终态 / 双向唯一. The session→task
 * reverse lookup is the linear scan of `GET /api/task-fsm/session?id=`
 * (routes.ts session route), inlined: any other non-terminal record holding
 * this session refuses. Pure — runs both before the seal-check (zero-write
 * refusals, §3.2 顺序 = 双向唯一 → seal-check) and again inside the update
 * (the file may have changed while seal-check awaited).
 * @param file - the fsm file under validation.
 * @param payload - the rebind request.
 * @returns the validated pair, or the structured refusal.
 */
function checkRebind(file: FsmFile, payload: RebindPayload): RebindCheck {
  const { fromTaskRef, toTaskRef, sessionId } = payload
  const from = file.tasks[fromTaskRef]
  if (from === undefined) return { refusal: { status: 404, kind: 'not-found', detail: `unknown taskRef: ${fromTaskRef} (fromTaskRef)` } }
  const to = file.tasks[toTaskRef]
  if (to === undefined) return { refusal: { status: 404, kind: 'not-found', detail: `unknown taskRef: ${toTaskRef} (toTaskRef)` } }
  if (from.state === 'done' || from.state === 'cancelled') {
    return { refusal: { status: 409, kind: 'a-terminal', detail: `A 已终态（${from.state}）无可解绑: ${fromTaskRef}` } }
  }
  // 双向唯一 ①: B must not already bind another session. (parse materializes a
  // bare `{reason:''}` node for unbound records, so liveness reads the id as a
  // NON-EMPTY STRING — the same 「活」口径 as G2/闸①.)
  const bound = typeof to.session?.id === 'string' && to.session.id !== '' ? to.session.id : undefined
  if (bound !== undefined && bound !== sessionId) {
    return { refusal: { status: 409, kind: 'dual-bound', detail: `B 记录已绑其他会话: ${toTaskRef} → ${bound}` } }
  }
  // 双向唯一 ②: 本会话无其他 active 任务（除 A 外任何非终态记录绑着本会话即拒）。
  for (const [ref, record] of Object.entries(file.tasks)) {
    if (ref === fromTaskRef) continue
    if (typeof record.session?.id !== 'string' || record.session.id !== sessionId) continue
    if (record.state === 'done' || record.state === 'cancelled') continue
    return { refusal: { status: 409, kind: 'dual-bound', detail: `本会话已有其他 active 任务: ${ref}` } }
  }
  return { from, to }
}

/**
 * §3.2 默认判读面: one loopback POST to the archive seal-check route.
 * Unreachable / non-200 / malformed body = `UNKNOWN`（查不清即拦, fail-closed）.
 */
async function sealCheckViaLoopback(ids: readonly string[], origin: string): Promise<SealCheckVerdict> {
  try {
    const response = await fetch(`${origin}/api/dsh-session-archive/seal-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [...ids] }),
      signal: AbortSignal.timeout(5_000),
    })
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    const first = Array.isArray(body.results) ? isObject(body.results[0]) : undefined
    if (response.status !== 200 || first === undefined || typeof first.verdict !== 'string') {
      return { verdict: 'UNKNOWN', detail: `seal-check status=${response.status} body=${JSON.stringify(body).slice(0, 200)}` }
    }
    return { verdict: first.verdict, detail: typeof first.detail === 'string' ? first.detail : '' }
  } catch (error) {
    return { verdict: 'UNKNOWN', detail: `seal-check unreachable: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` }
  }
}

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
      // Binding-gap read-side seal (freeze-bind-button-1126): an empty id
      // must never resolve, or it would match every session-less record and
      // hand the UI a phantom frozen view.
      if (id === '') { writeJson(res, 404, { ok: false, found: false }); return }
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
      // S2 触发②的出参通道：update 回调内算好的父归 ids，写盘成功后再发 POST
      // （回调内发 HTTP 会把网络延迟塞进读改写临界区）。
      let parentArchiveIds: readonly string[] = []
      const origin = typeof req.headers.host === 'string' && req.headers.host !== ''
        ? `http://${req.headers.host}`
        : undefined
      try {
        const outcome = store.update<UpdateOutcome>((file) => {
          const record = file.tasks[taskRef]
          if (record === undefined) return { status: 404 as const, error: 'unknown taskRef' }
          const result = applyTransition(record, event, depsFor(services, file, record, evidence), payload)
          if (!result.ok) return { status: 409 as const, refusal: result }
          let next = result.record
          // S2 事件驱动触发①② (fsm-seam-archive-build-1125 §3.2, 腿在场才生效)：
          // 「落 done」= from ≠ done（E17/E19 在已 done 记录上不再触发，防 E18 重发
          // 撤销已回执状态）。① 根终态 → E18 同笔原子补发（pendingAck + 黄档通知面
          // 接通，生产零调用方的断头根因）；② 父落 done → childSessions 交归档腿
          // （父收口即归子，§5；写盘后 fire-and-forget，失败留痕不回滚）。
          if (next.state === 'done' && record.state !== 'done' && services.leg !== undefined) {
            const isRoot = next.root === true || next.parent === undefined
            if (isRoot && next.pendingAck !== true) {
              const notice = applyTransition(next, 'E18', depsFor(services, file, next, {}), {})
              if (notice.ok) next = notice.record
            }
            parentArchiveIds = archivePlan(file, taskRef).childSessions
          }
          file.tasks[taskRef] = next
          return { status: 200 as const, record: next }
        })
        if ('error' in outcome) {
          // S3 可见性（仅 404/409 分支）：host 侧拒绝留痕，404 语义不变只加 hint。
          console.warn(`[task-fsm] transition REFUSED status=${outcome.status} taskRef=${taskRef} event=${event} detail=${outcome.error}`)
          writeJson(res, outcome.status, outcome.status === 404
            ? { ok: false, error: outcome.error, hint: HINT_UNKNOWN_TASKREF }
            : { ok: false, error: outcome.error })
          return
        }
        if ('refusal' in outcome) {
          console.warn(`[task-fsm] transition REFUSED status=409 taskRef=${taskRef} event=${event} kind=${outcome.refusal.kind} guard=${outcome.refusal.guard ?? '-'} detail=${outcome.refusal.detail}`)
          writeJson(res, outcome.status, { ok: false, kind: outcome.refusal.kind, detail: outcome.refusal.detail, ...(outcome.refusal.guard !== undefined ? { guard: outcome.refusal.guard } : {}) })
          return
        }
        // S2 触发②：父归 POST（fail-open —— 归档失败不碰已写好的 FSM 转移）。
        if (parentArchiveIds.length > 0 && services.leg !== undefined && origin !== undefined) {
          void services.leg.archive(taskRef, parentArchiveIds, origin)
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
        if ('error' in outcome) {
          // S3 可见性（仅 404/409 分支）：host 侧拒绝留痕，404 语义不变只加 hint。
          console.warn(`[task-fsm] wake REFUSED status=${outcome.status} taskRef=${taskRef} trigger=${trigger} detail=${outcome.error}`)
          writeJson(res, outcome.status, outcome.status === 404
            ? { ok: false, error: outcome.error, hint: HINT_UNKNOWN_TASKREF }
            : { ok: false, error: outcome.error })
          return
        }
        if ('refusal' in outcome) {
          console.warn(`[task-fsm] wake REFUSED status=409 taskRef=${taskRef} trigger=${trigger} kind=${outcome.refusal.kind} guard=${outcome.refusal.guard ?? '-'} detail=${outcome.refusal.detail}`)
          writeJson(res, outcome.status, { ok: false, kind: outcome.refusal.kind, detail: outcome.refusal.detail }); return
        }
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
      const origin = typeof req.headers.host === 'string' && req.headers.host !== ''
        ? `http://${req.headers.host}`
        : undefined
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
        if ('error' in outcome) {
          // S3 可见性（仅 404/409 分支）：404 语义不变、只加 hint 字段。
          console.warn(`[task-fsm] ack REFUSED status=${outcome.status} taskRef=${taskRef} event=E19 detail=${outcome.error}`)
          writeJson(res, outcome.status, outcome.status === 404
            ? { ok: false, error: outcome.error, hint: HINT_UNKNOWN_TASKREF }
            : { ok: false, error: outcome.error })
          return
        }
        if ('refusal' in outcome) {
          console.warn(`[task-fsm] ack REFUSED status=409 taskRef=${taskRef} event=E19 kind=${outcome.refusal.kind} guard=${outcome.refusal.guard ?? '-'} detail=${outcome.refusal.detail}`)
          writeJson(res, outcome.status, { ok: false, kind: outcome.refusal.kind, detail: outcome.refusal.detail, ...(outcome.refusal.guard !== undefined ? { guard: outcome.refusal.guard } : {}) })
          return
        }
        // S2 触发③：E19 人回执成功 → 归根会话自己（leaveToHuman：人查收即归档授权，
        // 宿主是机械执行手；fire-and-forget，失败留痕不回滚 FSM）。
        if (services.leg !== undefined && origin !== undefined) {
          const id = outcome.record.session?.id
          if (typeof id === 'string' && id !== '') void services.leg.archive(taskRef, [id], origin)
        }
        writeJson(res, 200, { ok: true, record: outcome.record })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  /**
   * 换绑原子事件 (fsm-rebind-1126, 设计 §3.1): 切单 = 解除旧关系 + 建立新关系
   * 的一个原子事件——B 绑定落库 ∧ A 转挂账, 单事务不留半态。三段式:
   *   Phase A 只读前置校验（存在 / A 非终态 / 双向唯一）→ 拒 = 零写入;
   *   Phase B §3.2 seal-check 硬拦（DONE|N_A 放行, 其余拒 + verdict/detail;
   *          force+forceReason = 强制切, 跳过判读且 forceReason 入 A history 留痕）;
   *   Phase C 一个 store.update() 内复校（TOCTOU）+ B 绑定 + A 解绑 + 两条 history。
   * 409+kind+detail 结构化 refusal 照 fsm.ts:29-44 形态; 记录缺失 = 404 not-found。
   */
  const rebind: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/rebind`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' }); return }
      let body: Record<string, unknown> | undefined
      try { body = isObject(await readBoundedJson(req, BODY_MAX_BYTES)) } catch { /* fallthrough */ }
      const fromTaskRef = typeof body?.fromTaskRef === 'string' ? body.fromTaskRef : ''
      const toTaskRef = typeof body?.toTaskRef === 'string' ? body.toTaskRef : ''
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      const forceReason = typeof body?.forceReason === 'string' ? body.forceReason.trim() : ''
      if (body === undefined || fromTaskRef === '' || toTaskRef === '' || sessionId === '') {
        writeJson(res, 400, { ok: false, error: 'body needs { fromTaskRef, toTaskRef, sessionId, force?, forceReason? }' }); return
      }
      if (fromTaskRef === toTaskRef) {
        writeJson(res, 400, { ok: false, error: 'fromTaskRef and toTaskRef must differ' }); return
      }
      const payload: RebindPayload = { fromTaskRef, toTaskRef, sessionId, force: body.force === true, forceReason }
      // force 只在 force+forceReason 同在时生效（force 无 reason = 照常走硬拦, 判据①）。
      const forced = payload.force && forceReason !== ''
      const origin = typeof req.headers.host === 'string' && req.headers.host !== ''
        ? `http://${req.headers.host}`
        : undefined
      const sealCheck = services.sealCheck ?? ((input) => sealCheckViaLoopback(input.ids, input.origin))
      const refuse = (refusal: RebindRefusal): void => {
        // S3 可见性: host 侧拒绝留痕（与 transition/wake/ack 同形）。
        console.warn(`[task-fsm] rebind REFUSED status=${refusal.status} from=${fromTaskRef} to=${toTaskRef} kind=${refusal.kind} detail=${refusal.detail}`)
        writeJson(res, refusal.status, {
          ok: false,
          kind: refusal.kind,
          detail: refusal.detail,
          ...('verdict' in refusal && refusal.verdict !== undefined ? { verdict: refusal.verdict } : {}),
        })
      }
      try {
        // Phase A — 只读前置校验（§3.2 顺序: 双向唯一在前; 拒 = 零写入 fail-closed）。
        const pre = checkRebind(store.load(), payload)
        if ('refusal' in pre) { refuse(pre.refusal); return }
        // Phase B — seal-check 硬拦（挂点 = store.update 之前的前置校验段, §3.2）。
        if (!forced) {
          if (origin === undefined) {
            refuse({ status: 409, kind: 'seal-required', detail: 'seal-check 读不到请求 Host origin（fail-closed）', verdict: 'UNKNOWN' })
            return
          }
          // seal 的会话 = A 记录绑定的会话（非空 id 才算绑）; A 无绑定时退回本会话（切单发起方）。
          const aId = typeof pre.from.session?.id === 'string' ? pre.from.session.id : ''
          const sealId = aId !== '' ? aId : sessionId
          const verdict = await sealCheck({ ids: [sealId], origin })
          if (!SEAL_PASS_VERDICTS.has(verdict.verdict)) {
            refuse({
              status: 409,
              kind: 'seal-required',
              detail: verdict.detail !== '' ? verdict.detail : `seal-check verdict=${verdict.verdict}（未存档, 查不清即拦）`,
              verdict: verdict.verdict,
            })
            return
          }
        }
        // Phase C — 单事务: 复校（TOCTOU）+ B 绑定 + A 解绑转挂账 + 两条 history。
        const outcome = store.update<RebindOutcome>((file) => {
          const check = checkRebind(file, payload)
          if ('refusal' in check) return { refusal: check.refusal }
          const { from, to } = check
          const at = new Date().toISOString()
          to.session = { id: sessionId, mode: 'active', reason: '' }
          to.history.push({ event: 'rebind-in', from: to.state, to: to.state, at })
          from.history.push({
            event: 'rebind-out',
            from: from.state,
            to: from.state,
            at,
            ...(forced ? { kind: 'forced' as const, forceReason: payload.forceReason } : {}),
          })
          // A 转挂账 = session 直写空值（⛔ 不复用 sessionMode:'cleared' 效果——
          // fsm.ts:112-114 那支不删 id; 本端点直删, G2「活」口径据此判无绑定）。
          delete from.session
          return { status: 200 as const, from, to }
        })
        if ('refusal' in outcome) { refuse(outcome.refusal); return }
        writeJson(res, 200, { ok: true, from: outcome.from, to: outcome.to })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  /**
   * POST /api/task-fsm/parent — 板 → FSM parent 镜像的最小写入口（#fsm-turnend-wire-1126）。
   *
   * parent 是**结构边字段**（archive.ts childrenOf / root 判据的输入），不是状态转移：
   * ⛔ 不写 history —— HistoryEventSchema 是白名单，未知事件会被 parseFsmFile fail-closed
   * 拒掉整份账；扩事件轴属另案。权威在板（fsm-dispatch-design-1126 §1「边权威在板」），
   * 本端点只被轮尾对账调用；幂等（同值重写 = 无变化），404 = 查无 taskRef。
   */
  const parent: WebRoute = {
    kind: 'exact',
    path: `${TASK_FSM_API_PREFIX}/parent`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' }); return }
      let body: Record<string, unknown> | undefined
      try { body = isObject(await readBoundedJson(req, BODY_MAX_BYTES)) } catch { /* fallthrough */ }
      const taskRef = typeof body?.taskRef === 'string' ? body.taskRef : ''
      const parentRef = typeof body?.parent === 'string' ? body.parent : ''
      if (body === undefined || taskRef === '' || parentRef === '') {
        writeJson(res, 400, { ok: false, error: 'body needs { taskRef, parent }' }); return
      }
      if (!parentRef.includes('#')) {
        writeJson(res, 400, { ok: false, error: 'parent must be a taskRef (<board path>#<anchor>)' }); return
      }
      try {
        const outcome = store.update<{ status: 200; record: TaskRecord } | { status: 404; error: string }>((file) => {
          const record = file.tasks[taskRef]
          if (record === undefined) return { status: 404 as const, error: 'unknown taskRef' }
          record.parent = parentRef
          return { status: 200 as const, record }
        })
        if ('error' in outcome) {
          // 本端点的失败分支只有 404（union 第二成员），hint 恒适用。
          console.warn(`[task-fsm] parent REFUSED status=${outcome.status} taskRef=${taskRef}`)
          writeJson(res, outcome.status, { ok: false, error: outcome.error, hint: HINT_UNKNOWN_TASKREF })
          return
        }
        writeJson(res, 200, { ok: true, record: outcome.record })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  return [state, session, notify, archive, scope, create, transition, wake, ack, rebind, parent]
}
