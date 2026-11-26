/**
 * E1 dispatch seam — 方案 A (fsm-host-archive-1125 §2.2, fsm-seam-archive-build-1125 S1):
 * the dispatch route registers the task in the task FSM and fires E1 through
 * loopback HTTP self-calls BEFORE any session work happens, so every dispatch
 * channel (raw POST, dispatch-send, ad-hoc scripts) walks the same G1/G2/G3
 * gate `scripts/dsh/dispatch-send.mjs` implements — one choke point, same
 * semantics, zero cross-plugin import coupling (the loopback fence already
 * admits the self-call).
 *
 * Placement inside the route (施工取舍, §2.2 挂点的最小副作用形):
 *   planLine/scope 抽取 = proceed() 之前（纯函数、零副作用，缺 = 400 拒派）
 *   FSM create          = proceed() 内 409 活会话闸之后、session create 之前
 *                         （409 拒派不落 backlog 记录；G1 在 create 门 fail-closed）
 *   transition E1       = session create 之后（E1 payload 带 sessionId —— §3.2 决定⑤
 *                         的 session id 回写就走这条既有合并语义，schema 零改；
 *                         E1 后记录 = {id, mode:'frozen', reason:'排队位'} 设计正形）
 * 豁免（boss 合成锚）：taskRef 无 '#' 锚（taskbot-takeover-* 等）或
 * sessionClass=bot-boss → 不入 FSM（防 boss 轮换被 G1/G3 误拦，§2.3.2）。
 * 失败形态：任何一段失败 = 拒派 4xx 响亮（fail-closed，不回静默放行）；
 * task-fsm 路由不可达（fetch 失败 = status 0）同样拒派并写明 error。
 * @module dsh-session-dispatch/host/fsm-seam
 */

/** One loopback response from the task-fsm API (`status 0` = fetch failed). */
export interface FsmSeamResponse {
  readonly status: number
  readonly json: Record<string, unknown>
}

/**
 * Loopback HTTP face the seam calls (injectable so tests can point the
 * origin at a scratch server; production uses `makeLoopbackFsmSeam`).
 */
export interface DispatchFsmSeam {
  post(origin: string, path: string, body: unknown): Promise<FsmSeamResponse>
  get(origin: string, path: string): Promise<FsmSeamResponse>
}

/**
 * G1 worktree 预案 detectors — 同源 `scripts/dsh/dispatch-send.mjs` 的
 * PLAN_PATTERNS（两处字面必须保持一致；m-note 脚本与本包跨仓无法共享 import，
 * 改一处须同步另一处）。
 */
export const PLAN_PATTERNS: readonly RegExp[] = [
  /worktree\s*预案/,
  /开\s*worktree/,
  /EnterWorktree/,
  /\.wt\//,
  /worktree\.py\s+create/,
]

/**
 * First non-empty trimmed prompt line carrying a worktree 预案 (G1 input).
 * @param prompt - the dispatch prompt prose (in hand at the route).
 * @returns the line, or undefined when the task book has no 预案.
 */
export function extractPlanLine(prompt: string): string | undefined {
  return prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && PLAN_PATTERNS.some((pattern) => pattern.test(line)))
}

/**
 * Scope key of one taskRef — taskRef 前缀（去锚去文件名，§8.1 结构闭集），
 * 与 `dispatch-send.mjs` 的 scopeKey 计算同式。
 * @param taskRef - `<board path>#<anchor>` reference.
 * @returns the scope key (may be empty for anchor-only references).
 */
export function scopeKeyOf(taskRef: string): string {
  return taskRef.split('#')[0].replace(/\/[^/]*$/, '')
}

/** The seam verdict for one dispatch request (exemption first, then G1 input). */
export type SeamPlan =
  /** Exempt: no '#' anchor (synthetic/boss taskRefs) or bot-boss class → never enters the FSM. */
  | { readonly kind: 'skip' }
  /** Fail-closed before any side effect: 400-refusable G1/scope problems. */
  | { readonly kind: 'refuse'; readonly error: string }
  /** Registered path: scope + worktree 预案 in hand, create/E1 still to run. */
  | { readonly kind: 'run'; readonly scope: string; readonly worktreePlan: string }

/**
 * Decide what the E1 seam does for one dispatch — pure, zero side effects,
 * so the route can refuse before creating anything.
 * @param input - the validated dispatch fields (taskRef already trimmed).
 * @returns skip / refuse / run.
 */
export function planSeam(input: { taskRef: string; sessionClass: string; prompt: string }): SeamPlan {
  // Boss 合成锚豁免（§2.3.2）：无 '#' 锚（taskbot-takeover-* 等合成引用）
  // 与 bot-boss 轮换/接管班都不入 FSM —— 豁免在前，连 planLine 都不抽。
  if (!input.taskRef.includes('#')) return { kind: 'skip' }
  if (input.sessionClass === 'bot-boss') return { kind: 'skip' }
  const scope = scopeKeyOf(input.taskRef)
  if (scope === '') {
    return { kind: 'refuse', error: `taskRef 无目录前缀 → scope 键空（${input.taskRef}）` }
  }
  const planLine = extractPlanLine(input.prompt)
  if (planLine === undefined) {
    return { kind: 'refuse', error: 'guard=G1 任务书缺 worktree 预案（E1 拒派 fail-closed）' }
  }
  return { kind: 'run', scope, worktreePlan: planLine.slice(0, 500) }
}

/**
 * One loopback call against `/api/task-fsm/<path>` — module-scoped so the
 * factory below stays a pure binding; `status 0` = fetch failed.
 */
async function fsmFetch(origin: string, path: string, init: RequestInit): Promise<FsmSeamResponse> {
  try {
    const response = await fetch(`${origin}/api/task-fsm/${path}`, {
      ...init,
      signal: AbortSignal.timeout(5_000),
    })
    return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown> }
  } catch (error) {
    return { status: 0, json: { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) } }
  }
}

/**
 * Loopback self-call client for `/api/task-fsm/*` — the origin comes from
 * the dispatch request's own Host header (fence already proved it loopback),
 * so the seam talks to the very server hosting it. `status 0` = fetch failed;
 * callers treat it as a refusal (fail-closed, 不静默放行).
 * @returns the seam client bound into `DispatchServices.fsm`.
 */
export function makeLoopbackFsmSeam(): DispatchFsmSeam {
  return {
    post: (origin, path, body) => fsmFetch(origin, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    get: (origin, path) => fsmFetch(origin, path, { method: 'GET' }),
  }
}

/** Shape of `GET /api/task-fsm/state` (the 409 分流 read + 闸① live read). */
interface FsmStateBody {
  file?: { tasks?: Record<string, { state?: unknown; session?: { id?: unknown } }> }
}

/**
 * The six states, mirrored as literals — the task-fsm package is consumed
 * over loopback only (zero cross-plugin import, 同 PLAN_PATTERNS 两处字面
 * 必须保持一致口径): a state outside this list reads as unreadable so the
 * gate fails CLOSED, exactly like G2's NaN.
 */
const FSM_STATES: ReadonlySet<string> = new Set(['backlog', 'active', 'deferred', 'blocked', 'done', 'cancelled'])

/** 闸① verdict for one taskRef (fsm-rebind-1126): live session / clear / unreadable. */
export type FsmLiveGateVerdict =
  /** state 非终态 ∧ session.id 非空 → 同 taskRef 已有活会话 (409). */
  | { readonly kind: 'live'; readonly sessionId: string }
  /** 无记录 / 终态 / session.id 空 → 放行建会话. */
  | { readonly kind: 'clear' }
  /** fetch failed / non-200 / malformed body → fail-closed 503 (⛔ 不放行). */
  | { readonly kind: 'unreadable'; readonly detail: string }

/**
 * Read the 闸① liveness verdict out of a `GET state` response — the same
 * 「活」definition as E1's G2 (设计 §1P2 纯 FSM, fsm-rebind-1126):
 * `state ∉ {done, cancelled}` ∧ `session.id 非空`.
 * @param response - the seam's loopback response (`status 0` = fetch failed).
 * @param taskRef - the dispatched task reference.
 * @returns live / clear / unreadable (unreadable = refuse, fail-closed).
 */
export function fsmLiveGateOf(response: FsmSeamResponse, taskRef: string): FsmLiveGateVerdict {
  if (response.status !== 200) return { kind: 'unreadable', detail: `GET state status=${response.status}` }
  const body = response.json as FsmStateBody
  if (body.file === undefined || typeof body.file !== 'object') {
    return { kind: 'unreadable', detail: 'GET state body carries no file' }
  }
  const record = body.file.tasks?.[taskRef]
  if (record === undefined) return { kind: 'clear' }
  const state = record.state
  if (typeof state !== 'string' || !FSM_STATES.has(state)) {
    return { kind: 'unreadable', detail: `record state unreadable: ${taskRef} (${JSON.stringify(state)})` }
  }
  if (state === 'done' || state === 'cancelled') return { kind: 'clear' }
  const id = record.session?.id
  return typeof id === 'string' && id !== '' ? { kind: 'live', sessionId: id } : { kind: 'clear' }
}

/** Read one record's state out of a `GET state` response (absent = undefined). */
export function recordStateOf(response: FsmSeamResponse, taskRef: string): string | undefined {
  const body = response.json as FsmStateBody
  const state = body.file?.tasks?.[taskRef]?.state
  return typeof state === 'string' ? state : undefined
}
