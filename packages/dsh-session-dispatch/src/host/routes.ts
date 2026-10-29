/**
 * HTTP routes for dsh-session-dispatch. Every route is loopback-fenced (the
 * plugin creates real Host sessions; tunnels and LAN clients get 403), the
 * mutating route additionally requires POST, and the body is a bounded JSON
 * object whose fields are validated before any Host service is touched.
 * @module dsh-session-dispatch/host/routes
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { readBoundedJson, writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'

export const DISPATCH_API_PREFIX = '/api/session-dispatch'

/** Top-level send endpoint: delivery to an existing Session (not under the dispatch prefix). */
export const SESSION_SEND_API_PREFIX = '/api/session-send'

/** Dispatch prompts are prose task books; 1 MiB covers very long ones with margin. */
const BODY_MAX_BYTES = 1_000_000

/** Prompt prose cap shared by the dispatch and send routes (900,000 characters). */
const PROMPT_MAX_CHARS = 900_000

/** Permission presets composed by the web profile's permission row. */
export const DISPATCH_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/**
 * The attention class of a dispatched Session: `human` sessions take the
 * default pin (human-dispatched work, bot duty sessions), `bot` sessions
 * stay unpinned (bot-dispatched task work). Absent on the wire means `human`
 * — a caller that forgets the field fails toward attention, not toward
 * burying the session.
 */
export type SessionClass = 'human' | 'bot'

/** One validated dispatch request. */
export interface DispatchRequest {
  readonly workspaceId: string
  readonly prompt: string
  readonly title?: string
  readonly mode?: string
  readonly permission?: string
  readonly taskRef?: string
  readonly sessionClass?: SessionClass
}

/**
 * One task-to-session binding in the quick ledger. `taskRef` is an opaque
 * caller-chosen reference (recommended shape `<board path>#<item anchor>`),
 * `createdAt` an ISO-8601 timestamp minted at record time.
 */
export interface DispatchBinding {
  readonly taskRef: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly title?: string
  readonly createdAt: string
}

/** One binding as served by GET /api/session-dispatch/bindings, with live aliveness. */
export interface DispatchBindingView extends DispatchBinding {
  readonly alive: boolean
}

/** Quick-ledger surface consumed by the dispatch and bindings routes. */
export interface DispatchBindingStore {
  /** The newest still-alive binding for a taskRef, or undefined (dead bindings do not gate). */
  findAlive(taskRef: string): Promise<DispatchBinding | undefined>
  /** Durably append one binding (atomic temp-file + rename). */
  record(binding: DispatchBinding): Promise<void>
  /** All bindings ever recorded, each annotated with live aliveness. */
  list(): Promise<DispatchBindingView[]>
}

/**
 * Neutral session surface the dispatch route consumes. Structural, so the
 * plugin stays decoupled from the session-controller package's version.
 */
export interface DispatchSessionApi {
  create(request: { workspaceId?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  prompt(
    request: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: readonly { type: 'text'; text: string }[] },
    signal: AbortSignal,
  ): Promise<{ accepted: true }>
}

/** Neutral workspace lookup the dispatch route consumes. */
export interface DispatchWorkspaceRegistry {
  get(id: string): { readonly id: string } | undefined
}

/** Neutral agent lookup consumed by the optional permission pin. */
export interface DispatchAgentRegistry {
  get(sessionId: string): unknown
}

/** Neutral attention-classification surface consumed by the dispatch route. */
export interface DispatchAttentionApi {
  /**
   * Record the declared class for a freshly created Session and apply its
   * default pin state; a rejection is reported as `attentionRecorded: false`
   * and never fails the dispatch itself.
   * @param sessionId - id returned by the session create call.
   * @param sessionClass - declared class (wire default applied by the route).
   */
  declare(sessionId: string, sessionClass: SessionClass): Promise<void>
}

/** Neutral slash-command executor consumed by the optional permission pin. */
export interface DispatchCommandExecutor {
  execute(agent: unknown, line: string, attachments: readonly never[], signal: AbortSignal): Promise<{ result?: { kind?: string; text?: string } } | undefined>
}

/** Host services bound into the route factories. */
export interface DispatchServices {
  readonly sessions: DispatchSessionApi
  readonly workspaces: DispatchWorkspaceRegistry
  readonly agents?: DispatchAgentRegistry
  readonly commands?: DispatchCommandExecutor
  /** Quick-ledger binding store; when absent, taskRef dispatches record nothing and never 409. */
  readonly bindings?: DispatchBindingStore
  /** Attention ledger; when absent, dispatches record no class and apply no pin default. */
  readonly attention?: DispatchAttentionApi
}

/** Body-parse verdict. */
export type DispatchBodyResult = { readonly ok: true; readonly value: DispatchRequest } | { readonly ok: false; readonly error: string }

/**
 * Validate one raw dispatch body. Pure — every rejection names the offending
 * field so a script caller can fix the request without reading plugin code.
 * @param body - parsed JSON body (unknown from the wire).
 * @returns the validated request, or the first field error.
 */
export function parseDispatchBody(body: unknown): DispatchBodyResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const record = body as Record<string, unknown>
  const { workspaceId, prompt, title, mode, permission, taskRef, sessionClass } = record
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    return { ok: false, error: 'workspaceId must be a non-empty string' }
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'prompt must be a non-empty string' }
  }
  if (prompt.length > PROMPT_MAX_CHARS) {
    return { ok: false, error: 'prompt exceeds the 900000-character dispatch limit' }
  }
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '' || title.length > 500)) {
    return { ok: false, error: 'title must be a non-empty string of at most 500 characters' }
  }
  if (mode !== undefined && (typeof mode !== 'string' || mode.trim() === '')) {
    return { ok: false, error: 'mode must be a non-empty agent-preset id' }
  }
  if (permission !== undefined) {
    if (typeof permission !== 'string' || !(DISPATCH_PERMISSIONS as readonly string[]).includes(permission)) {
      return { ok: false, error: `permission must be one of ${DISPATCH_PERMISSIONS.join(' | ')}` }
    }
  }
  if (taskRef !== undefined) {
    if (typeof taskRef !== 'string' || taskRef.trim() === '' || taskRef.length > 2000) {
      return { ok: false, error: 'taskRef must be a non-empty string of at most 2000 characters' }
    }
  }
  if (sessionClass !== undefined && sessionClass !== 'human' && sessionClass !== 'bot') {
    return { ok: false, error: 'sessionClass must be either human or bot' }
  }
  return {
    ok: true,
    value: {
      workspaceId: workspaceId.trim(),
      prompt,
      ...(title === undefined ? {} : { title: title.trim() }),
      ...(mode === undefined ? {} : { mode: mode.trim() }),
      ...(permission === undefined ? {} : { permission }),
      ...(taskRef === undefined ? {} : { taskRef: taskRef.trim() }),
      ...(sessionClass === undefined ? {} : { sessionClass }),
    },
  }
}

function fenced(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return false
  }
  return true
}

/** Map a Host rejection to an HTTP status: known request/workspace codes stay 4xx, everything else is 500. */
function statusForError(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return 500
  if (code === 'workspace/not-found') return 404
  if (code.startsWith('gateway/bad-request') || code.startsWith('session/')) return 400
  return 500
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
}

/** POST /api/session-dispatch — create a workspace-pinned session and queue its first prompt. */
export function makeDispatchRoute(services: DispatchServices): WebRoute {
  return {
    kind: 'exact',
    path: `${DISPATCH_API_PREFIX}`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' })
        return
      }
      let body: unknown
      try {
        body = await readBoundedJson(req, BODY_MAX_BYTES)
      } catch {
        writeJson(res, 400, { ok: false, error: 'body must be valid JSON' })
        return
      }
      const parsed = parseDispatchBody(body)
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error })
        return
      }
      const { workspaceId, prompt, title, mode, permission, taskRef, sessionClass } = parsed.value
      if (services.workspaces.get(workspaceId) === undefined) {
        writeJson(res, 404, { ok: false, error: `workspace not found: ${workspaceId}` })
        return
      }
      if (taskRef !== undefined && services.bindings !== undefined) {
        let existing: Awaited<ReturnType<DispatchBindingStore['findAlive']>>
        try {
          existing = await services.bindings.findAlive(taskRef)
        } catch (error) {
          // The ledger is an occupancy sensor, not an authority: a store
          // failure must not wedge dispatch, so the gate fails open.
          existing = undefined
          void error
        }
        if (existing !== undefined) {
          writeJson(res, 409, {
            ok: false,
            error: `taskRef already has a live session: ${existing.sessionId}`,
            taskRef,
            sessionId: existing.sessionId,
          })
          return
        }
      }
      const signal = new AbortController().signal
      let sessionId: string
      let attentionError: string | undefined
      try {
        const created = await services.sessions.create({
          workspaceId,
          ...(mode === undefined ? {} : { agentPreset: mode }),
        })
        sessionId = created.sessionId
        if (services.attention !== undefined) {
          try {
            await services.attention.declare(sessionId, sessionClass ?? 'human')
          } catch (error) {
            // Attention is a classification side effect: a ledger failure is
            // reported alongside the binding's, never as a dispatch failure.
            attentionError = errorDetail(error)
          }
        }
        if (title !== undefined) {
          await services.sessions.rename({ sessionId, title })
        }
        if (permission !== undefined) {
          if (services.agents === undefined || services.commands === undefined) {
            throw new Error('permission pinning is unavailable: commands registry is not composed')
          }
          const agent = services.agents.get(sessionId)
          if (agent === undefined) throw new Error(`session ${sessionId} has no agent for the permission pin`)
          const execution = await services.commands.execute(agent, `/permission ${permission}`, [], signal)
          const result = execution?.result
          if (result === undefined || (result.kind !== undefined && result.kind !== 'success')) {
            // A rejected pin is a caller-fixable request error, not a Host fault.
            const failure = new Error(`permission pin failed: ${result?.text ?? 'command produced no result'}`) as Error & { code: string }
            failure.code = 'gateway/bad-request'
            throw failure
          }
        }
        await services.sessions.prompt({
          requestId: `session-dispatch-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        }, signal)
      } catch (error) {
        writeJson(res, statusForError(error), { ok: false, error: errorDetail(error) })
        return
      }
      if (taskRef !== undefined && services.bindings !== undefined) {
        try {
          await services.bindings.record({
            taskRef,
            sessionId,
            workspaceId,
            ...(title === undefined ? {} : { title }),
            createdAt: new Date().toISOString(),
          })
        } catch (error) {
          // The session is live and prompting; a ledger write failure is
          // reported but does not turn a successful dispatch into a 5xx.
          writeJson(res, 200, {
            ok: true,
            sessionId,
            bindingRecorded: false,
            bindingError: errorDetail(error),
            ...(attentionError === undefined ? {} : { attentionRecorded: false, attentionError }),
          }, { 'cache-control': 'no-store' })
          return
        }
      }
      writeJson(res, 200, {
        ok: true,
        sessionId,
        ...(attentionError === undefined ? {} : { attentionRecorded: false, attentionError }),
      }, { 'cache-control': 'no-store' })
    },
  }
}

/** GET /api/session-dispatch/health — liveness probe for restart verification. */
export function makeHealthRoute(): WebRoute {
  return {
    kind: 'exact',
    path: `${DISPATCH_API_PREFIX}/health`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' })
        return
      }
      writeJson(res, 200, { ok: true, service: 'dsh-session-dispatch' }, { 'cache-control': 'no-store' })
    },
  }
}

/** GET /api/session-dispatch/bindings — the quick ledger: every binding with live aliveness. */
export function makeBindingsRoute(bindings: DispatchBindingStore): WebRoute {
  return {
    kind: 'exact',
    path: `${DISPATCH_API_PREFIX}/bindings`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed: use GET' })
        return
      }
      try {
        const list = await bindings.list()
        writeJson(res, 200, { ok: true, bindings: list }, { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

/** One validated session-send request. Deliberately mode-free: delivery is queue-only. */
export interface SessionSendRequest {
  readonly sessionId: string
  readonly prompt: string
}

/** Body-parse verdict for the send route. */
export type SessionSendBodyResult = { readonly ok: true; readonly value: SessionSendRequest } | { readonly ok: false; readonly error: string }

/**
 * Validate one raw session-send body. Pure, and queue-only by construction:
 * the wire shape has no delivery-mode field, so no caller input can ever
 * select a different delivery semantic. Every rejection names the offending
 * field.
 * @param body - parsed JSON body (unknown from the wire).
 * @returns the validated request, or the first field error.
 */
export function parseSessionSendBody(body: unknown): SessionSendBodyResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const record = body as Record<string, unknown>
  const { sessionId, prompt } = record
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { ok: false, error: 'sessionId must be a non-empty string' }
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'prompt must be a non-empty string' }
  }
  if (prompt.length > PROMPT_MAX_CHARS) {
    return { ok: false, error: 'prompt exceeds the 900000-character send limit' }
  }
  return { ok: true, value: { sessionId: sessionId.trim(), prompt } }
}

/** Session service surface the send route consumes (the prompt half of the dispatch surface). */
export interface SessionSendServices {
  readonly sessions: Pick<DispatchSessionApi, 'prompt'>
}

/**
 * POST /api/session-send — queue one prompt onto an existing Session, the
 * REST mirror of typing into a live session's composer. The prompt is
 * delivered with the fixed queue semantic: a busy Session consumes it as a
 * fresh turn after the current one, an idle Session starts a turn at once.
 * No mode field exists on the wire and no code path can steer.
 */
export function makeSessionSendRoute(services: SessionSendServices): WebRoute {
  return {
    kind: 'exact',
    path: `${SESSION_SEND_API_PREFIX}`,
    handler: async (req, res) => {
      if (!fenced(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed: use POST' })
        return
      }
      let body: unknown
      try {
        body = await readBoundedJson(req, BODY_MAX_BYTES)
      } catch {
        writeJson(res, 400, { ok: false, error: 'body must be valid JSON' })
        return
      }
      const parsed = parseSessionSendBody(body)
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error })
        return
      }
      const { sessionId, prompt } = parsed.value
      const signal = new AbortController().signal
      try {
        await services.sessions.prompt({
          requestId: `session-send-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        }, signal)
      } catch (error) {
        writeJson(res, statusForError(error), { ok: false, error: errorDetail(error) })
        return
      }
      writeJson(res, 200, { ok: true, sessionId }, { 'cache-control': 'no-store' })
    },
  }
}

/** All dispatch routes: the POST endpoint, its liveness probe, and the bindings ledger. */
export function makeDispatchRoutes(services: DispatchServices): WebRoute[] {
  const routes = [makeDispatchRoute(services), makeHealthRoute()]
  if (services.bindings !== undefined) routes.push(makeBindingsRoute(services.bindings))
  return routes
}
