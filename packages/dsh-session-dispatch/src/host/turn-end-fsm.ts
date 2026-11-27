/**
 * C leg — host-side full-coverage task-FSM entry (fsm-turnend-wire-1126 §3.3).
 *
 * The A leg (m-note Stop hook) can only reconcile from trees that carry
 * `scripts/guard/turnend-nudge.py`; this subscription is the host-side face
 * that covers every session regardless of which tree it runs in. On each
 * `turn/end` it resolves the session's bound taskRef out of the quick ledger
 * and drives the FSM:
 *
 *   no binding            → zero action (spec ②)
 *   no FSM record         → create + E1 (入机, spec ①)
 *   record in `backlog`   → E1 (推进 — the dispatch-time E1 never landed)
 *   record past backlog   → zero action (idempotent, spec ①)
 *
 * **Same entry judgment as the A leg** (防分裂): exemptions first (no `#`
 * anchor, `bot-boss` class — the `planSeam` rule), then the same
 * `scopeKeyOf` scope key and the same `worktree.py create <slug>` G1 plan
 * line the hook synthesises for a row that carries no plan of its own. The
 * dispatch-time seam (`fsm-seam.planSeam`) keeps the prompt-derived plan
 * line; this leg runs where no prompt is in hand, so it derives the plan
 * from the taskRef instead — same pattern family, same G1 evidence class.
 *
 * Failure shape is fail-open and loud: every step is guarded, a failure
 * warns with the session id + taskRef + cause and returns. Nothing here can
 * deny, block or stall a turn — the Host's own event loop must never wait on
 * the FSM (the loopback calls carry a 5s budget each).
 *
 * Teardown is idempotent: `stop()` disposes the listener and parks every
 * in-flight entry behind the stopped guard; a second `stop()` is a no-op.
 * @module dsh-session-dispatch/host/turn-end-fsm
 */
import type { Context } from '@deepseek-ai/cordis'
// The `session/event` map is declared by the Host's type augmentations;
// `index.ts` pulls the same type-only lines (this package has no direct
// `@deepseek-ai/dsh-session` dependency, so the map arrives via augmentation).
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { scopeKeyOf, type DispatchFsmSeam, type FsmSeamResponse } from './fsm-seam.ts'

/** Collaborators of one C-leg instance (all injectable → specs drive fakes). */
export interface TurnEndFsmOptions {
  /**
   * Latest taskRef bound to a session (quick ledger `$DSH_HOME/dispatch-bindings.json`,
   * read-only through the store's own `list()` — ⛔ no binding semantics are touched,
   * that surface belongs to `#bindings-retire-1126`).
   * @returns the taskRef, or undefined when the session is unbound.
   */
  readonly resolveTaskRef: (sessionId: string) => Promise<string | undefined>
  /**
   * Session class for the `bot-boss` exemption (attention ledger).
   * @returns the class, or undefined when the ledger has no record.
   */
  readonly resolveClass?: (sessionId: string) => Promise<string | undefined>
  /** Loopback FSM face — the very `DispatchFsmSeam` the dispatch route uses. */
  readonly fsm: DispatchFsmSeam
  /** The Host's own origin (`webServer.getOrigin()`); read per attempt, may bind late. */
  readonly origin: () => string
}

/** The lifecycle handle the dispatch plugin owns. */
export interface TurnEndFsmSync {
  /** Arm the `session/event` subscription (idempotent: a second start is a no-op). */
  start(): void
  /** Release the listener and park in-flight work; idempotent. */
  stop(): void
}

/** One attempt's structured outcome (specs assert on this instead of HTTP). */
export type TurnEndEntry =
  /** No ledger binding for this session — spec ②, zero FSM calls. */
  | { readonly kind: 'unbound' }
  /** Exempt (no `#` anchor / bot-boss class) or empty scope key — zero FSM calls. */
  | { readonly kind: 'exempt'; readonly reason: string }
  /** FSM unreadable (non-200 / no file) — fail-open, zero writes. */
  | { readonly kind: 'unreadable'; readonly detail: string }
  /** Record created + E1 fired (入机). */
  | { readonly kind: 'entered'; readonly taskRef: string }
  /** Record existed in `backlog` and E1 fired (推进). */
  | { readonly kind: 'advanced'; readonly taskRef: string }
  /** Record already past `backlog` — idempotent no-op (spec ①). */
  | { readonly kind: 'settled'; readonly taskRef: string; readonly state: string }
  /** A write the FSM refused (409/4xx/5xx/fetch failure) — loud, never retried here. */
  | { readonly kind: 'refused'; readonly taskRef: string; readonly where: string; readonly detail: string }

/** `GET /state` body shape the leg reads (structural, no cross-package import). */
interface FsmStateBody {
  readonly file?: { readonly tasks?: Record<string, { readonly state?: unknown }> }
}

/** Truncated error text for a warn line (mirrors the route layer's cap). */
function detailOf(response: FsmSeamResponse): string {
  const raw = response.json?.error
  const text = typeof raw === 'string' ? raw : `status=${response.status}`
  return text.slice(0, 300)
}

/** The G1 plan line this leg synthesises — same literal the A leg falls back to. */
function planLineOf(taskRef: string): string {
  const anchor = taskRef.slice(taskRef.indexOf('#') + 1)
  return `worktree.py create ${anchor}`.slice(0, 500)
}

/**
 * Create the C-leg instance for one dispatch-plugin mount.
 * @param ctx - the plugin context (events only; no services are injected).
 * @param options - the ledger resolver, the loopback seam and the origin.
 * @returns the lifecycle handle; call `start` after construction, `stop` on unmount.
 */
export function createTurnEndFsmSync(ctx: Context, options: TurnEndFsmOptions): TurnEndFsmSync {
  /** The `session/event` subscription, armed while started. */
  let disposeEvent: (() => void) | undefined
  let stopped = true
  /** Session ids with an attempt in flight — dedupes a double turn/end. */
  const inFlight = new Set<string>()

  /**
   * One entry attempt — every step guarded, nothing throws to the caller.
   * @param sessionId - the session whose turn just ended.
   * @returns the structured outcome (specs assert on it).
   */
  const enter = async (sessionId: string): Promise<TurnEndEntry> => {
    let taskRef: string | undefined
    try {
      taskRef = await options.resolveTaskRef(sessionId)
    } catch (error) {
      return { kind: 'unreadable', detail: `ledger read failed: ${String(error).slice(0, 200)}` }
    }
    if (taskRef === undefined || taskRef === '') return { kind: 'unbound' }
    // Exemption first, exactly the dispatch seam's rule (防分裂): a synthetic
    // anchor never enters the FSM, and neither does a boss rotation.
    if (!taskRef.includes('#')) return { kind: 'exempt', reason: 'taskRef has no # anchor' }
    if (options.resolveClass !== undefined) {
      let sessionClass: string | undefined
      try {
        sessionClass = await options.resolveClass(sessionId)
      } catch {
        sessionClass = undefined // Unreadable ledger → treat as non-boss (fail-open on the exemption only).
      }
      if (sessionClass === 'bot-boss') return { kind: 'exempt', reason: 'sessionClass=bot-boss' }
    }
    const scope = scopeKeyOf(taskRef)
    if (scope === '') return { kind: 'exempt', reason: 'scope key empty' }
    if (stopped) return { kind: 'exempt', reason: 'sync stopped' }

    const origin = (() => {
      try {
        return options.origin()
      } catch {
        return ''
      }
    })()
    if (origin === '') return { kind: 'unreadable', detail: 'origin unavailable (listener not bound yet)' }

    const state = await options.fsm.get(origin, 'state')
    if (state.status !== 200) return { kind: 'unreadable', detail: `GET state ${detailOf(state)}` }
    const file = (state.json as FsmStateBody).file
    if (file === undefined || typeof file !== 'object') {
      return { kind: 'unreadable', detail: 'GET state body carries no file' }
    }
    if (stopped) return { kind: 'exempt', reason: 'sync stopped' }
    const record = file.tasks?.[taskRef]
    if (record !== undefined && record.state !== 'backlog') {
      return { kind: 'settled', taskRef, state: String(record.state) }
    }

    const plan = planLineOf(taskRef)
    if (record === undefined) {
      const created = await options.fsm.post(origin, 'create', {
        taskRef, worktreePlan: plan, scope,
      })
      // 409 = a racing attempt already created it → still worth firing E1 below.
      if (created.status !== 200 && created.status !== 409) {
        return { kind: 'refused', taskRef, where: 'create', detail: detailOf(created) }
      }
    }
    const e1 = await options.fsm.post(origin, 'transition', {
      taskRef,
      event: 'E1',
      evidence: { worktreePlan: true },
      payload: { sessionId },
    })
    if (e1.status !== 200) {
      return { kind: 'refused', taskRef, where: record === undefined ? 'create+E1' : 'E1', detail: detailOf(e1) }
    }
    return record === undefined
      ? { kind: 'entered', taskRef }
      : { kind: 'advanced', taskRef }
  }

  /** Run one attempt with the in-flight dedupe + the loud fail-open backstop. */
  const run = async (sessionId: string): Promise<void> => {
    if (stopped || inFlight.has(sessionId)) return
    inFlight.add(sessionId)
    try {
      const outcome = await enter(sessionId)
      if (stopped) return
      if (outcome.kind === 'refused' || outcome.kind === 'unreadable') {
        console.warn(`[turn-end-fsm] entry ${outcome.kind} session=${sessionId} detail=${'detail' in outcome ? outcome.detail : ''}`)
      }
    } catch (error) {
      // Never propagate into the Host's event loop: a turn end must not fail
      // because the FSM was unreachable.
      if (!stopped) {
        console.warn(`[turn-end-fsm] entry failed session=${sessionId} error=${String(error).slice(0, 300)}`)
      }
    } finally {
      inFlight.delete(sessionId)
    }
  }

  const onSessionEvent = (session: { readonly id: unknown }, event: { readonly type: string }): void => {
    if (event.type !== 'turn/end') return
    void run(String(session.id))
  }

  return {
    start(): void {
      if (!stopped) return // idempotent arming
      stopped = false
      disposeEvent = ctx.on('session/event', onSessionEvent)
    },
    stop(): void {
      stopped = true
      const dispose = disposeEvent
      disposeEvent = undefined
      if (dispose !== undefined) {
        try {
          dispose()
        } catch {
          // The listener fiber may already be gone during shutdown.
        }
      }
      inFlight.clear()
    },
  }
}
