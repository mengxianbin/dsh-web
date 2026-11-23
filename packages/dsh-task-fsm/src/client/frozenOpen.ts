/**
 * Frozen-open wiring (frozen-open-1123, design §3.5 点开形态): makes a
 * frozen/locked session's conversation open as a **true read-only
 * snapshot** — the composer chain elects this package's readonly card in
 * place of the input bar and ahead of every other composer occupant (ask
 * card included), so the input panel and the ask panel are unreachable
 * while the freeze holds; non-frozen sessions elect nothing and render
 * exactly as before (the regression-green half of the acceptance).
 *
 * The election is a **pure selector over the chain's owner currency**: it
 * reads only `pendingInteraction`, whose `kind` this face publishes
 * itself (the react-bridge described below). Publishing rides
 * `uiSession.registerPendingInteraction` — the same takeover channel the
 * question card and the approval card use — at a precedence above both,
 * which is also what keeps a pending ask card from electing while frozen:
 * the winner stored on the session status becomes this face's interaction,
 * so their selectors decline on their own `instanceof` checks.
 *
 * React-bridge (why the selector may stay pure): this package cannot write
 * the harness session store, so freeze state reaches the chain through the
 * pending-interaction slot — `ConversationContent` re-renders on every
 * sessionStatus change, which re-runs the selectors. The data path is the
 * existing page cache: the row hover fetches it (B2), the boot wiring
 * catches up on anything already warm, and {@link FsmFrozenWatcher}'s poll
 * (immediate + every 5 s while a conversation is open) drives every later
 * transition — freeze landing while the user watches, wake clearing it,
 * reason/mode changes.
 *
 * Degradation: no `uiSession` service means no publishing and therefore no
 * takeover — the seats still register, the selector just never matches.
 * Nothing here touches the freeze mechanism itself (D axis / wake triggers
 * shipped with B2) or the four-state checkbox values.
 * @module @linxin666/dsh-task-fsm/client/frozenOpen
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { fsmCachedSessionIds, peekFsmView, subscribeFsmViews, type FsmSessionView } from './api.ts'
import { FsmFrozenComposer, type FsmFrozenMatch } from './FsmFrozenComposer.tsx'
import { FsmFrozenWatcher } from './FsmFrozenWatcher.tsx'
import { NS } from './locales.ts'

/** Pending-interaction kind this face publishes (the sidebar row's `visiblePendingKind` whitelist ignores it — zero badge change). */
export const FROZEN_KIND = 'task-fsm-frozen'
/**
 * Chain priority: ahead of every in-tree composer occupant — ui-subagent's
 * read-only takeover sits at -10, the question card at 0 (registration
 * default), ui-approval and the resident composer at 1 — so a frozen
 * session's selector wins the election first and theirs never runs.
 */
export const FROZEN_PRIORITY = -20
/** Cross-domain precedence: beats question plan-review (2), question (1), approval (0). */
export const FROZEN_PRECEDENCE = 10
/** Seat occupant id of the freshness watcher. */
const WATCHER_ID = 'task-fsm-frozen-watcher'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Selector-routed composer takeover: the frozen readonly card. */
    'conversation.composer': { kind: 'chain'; scope: 'session'; owner: FrozenComposerOwner }
    /** Floating overlay inside the resident input card: the invisible freshness watcher. */
    'conversation.input.overlay': { kind: 'list'; scope: 'session' }
  }
}

/** Chain currency this selector reads (pure function of these props only). */
export interface FrozenComposerOwner {
  readonly sessionId?: string
  readonly session?: unknown
  readonly pendingInteraction?: unknown
}

/** One published frozen state (SessionPendingInteractionBase shape + freeze data). */
export interface FrozenReadonlyInteraction {
  readonly key: string
  readonly kind: string
  readonly sessionId: string
  readonly mode: 'frozen' | 'locked'
  readonly reason: string
}

/** The structural face of `ctx.uiSession` this wiring consumes (no package link). */
interface UiSessionFace {
  registerPendingInteraction<T extends FrozenReadonlyInteraction>(
    precedence: (interaction: T) => number,
  ): (interaction: T, delegate: () => Promise<void>) => () => void
}

/**
 * The chain selector: elects the readonly card exactly when this session's
 * published interaction is a frozen state. Pure by contract — a function of
 * the owner currency only; the cache never enters this decision.
 * @param owner - the chain's owner currency (sessionId + pendingInteraction read).
 * @returns the match to inject as `matched`, or null to pass to the next entry.
 */
export function selectFrozenReadonly(owner: FrozenComposerOwner): FsmFrozenMatch | null {
  const pending = owner.pendingInteraction as FrozenReadonlyInteraction | undefined | null
  if (pending === undefined || pending === null || pending.kind !== FROZEN_KIND) return null
  if (typeof owner.sessionId !== 'string' || owner.sessionId === '') return null
  return {
    sessionId: owner.sessionId,
    mode: pending.mode === 'locked' ? 'locked' : 'frozen',
    reason: typeof pending.reason === 'string' ? pending.reason : '',
  }
}

function frozenModeOf(view: FsmSessionView | null): 'frozen' | 'locked' | undefined {
  const mode = view?.session?.mode
  return mode === 'frozen' || mode === 'locked' ? mode : undefined
}

interface PublishedFreeze {
  dispose: () => void
  mode: 'frozen' | 'locked'
}

/**
 * Monotonic key sequence: the pending-interaction contract requires a
 * replacement request to carry a NEW key, and a release-then-re-freeze cycle
 * must not resurrect the previous one (a module counter keeps every publish
 * unique across the wiring's lifetime).
 */
let frozenPublishSeq = 0

/**
 * The react-bridge: keep one published interaction per frozen session in
 * step with resolved view fetches (publish on freeze, release on wake, and
 * re-key on a frozen↔locked mode change; a reason refresh rides the view
 * itself, which the panel reads live — no republish flicker).
 * @param ctx - client root context (owns the effect lifetime).
 * @param uiSession - the pending-interaction service face.
 */
function startPublishing(ctx: ClientContext, uiSession: UiSessionFace): void {
  // One domain for the face's lifetime (register = claim the precedence
  // slot once; every publish/release below rides the returned publisher).
  const publish = uiSession.registerPendingInteraction<FrozenReadonlyInteraction>(() => FROZEN_PRECEDENCE)
  const published = new Map<string, PublishedFreeze>()
  const applyView = (sessionId: string, view: FsmSessionView | null): void => {
    const mode = frozenModeOf(view)
    const existing = published.get(sessionId)
    if (mode === undefined) {
      existing?.dispose()
      published.delete(sessionId)
      return
    }
    const reason = typeof view?.session?.reason === 'string' ? view.session.reason : ''
    if (existing !== undefined && existing.mode === mode) return // same state: reason rides the view
    existing?.dispose()
    const dispose = publish(
      {
        key: `frozen:${sessionId}#${frozenPublishSeq++}`,
        kind: FROZEN_KIND,
        sessionId,
        mode,
        reason,
      },
      async () => undefined,
    )
    published.set(sessionId, { dispose, mode })
  }
  const unsubscribe = subscribeFsmViews(applyView)
  // Catch-up: views resolved before this wiring mounted (test seams, reloads).
  for (const sessionId of fsmCachedSessionIds()) {
    const view = peekFsmView(sessionId)
    if (view !== undefined) applyView(sessionId, view)
  }
  ctx.effect(() => () => {
    unsubscribe()
    for (const entry of published.values()) entry.dispose()
    published.clear()
  }, 'dsh-task-fsm: frozen-open publish')
}

function serviceOf(ctx: ClientContext): UiSessionFace | undefined {
  try {
    const candidate = (ctx as unknown as { get?: (name: string) => unknown }).get?.('uiSession')
    if (candidate === undefined || candidate === null) return undefined
    const face = candidate as UiSessionFace
    return typeof face.registerPendingInteraction === 'function' ? face : undefined
  } catch {
    return undefined
  }
}

/**
 * Register the two seats and the pending-interaction publish bridge.
 * Quiet degradation throughout (this package's seat style): a missing seat
 * or a missing service skips that leg instead of failing the plugin.
 * @param ctx - client root context.
 */
export function wireFrozenOpen(ctx: ClientContext): void {
  // The readonly takeover (chain, first non-null selector wins).
  ctx.slots.inject('conversation.composer', () => {
    try {
      const unregister = ctx.slots.register({
        name: 'conversation.composer',
        priority: FROZEN_PRIORITY,
        locale: NS,
        select: selectFrozenReadonly,
      }, FsmFrozenComposer)
      return () => {
        unregister()
      }
    } catch {
      return () => {}
    }
  })
  // The invisible freshness watcher inside the resident input card.
  ctx.slots.inject('conversation.input.overlay', () => {
    try {
      const unregister = ctx.slots.register({
        name: 'conversation.input.overlay',
        id: WATCHER_ID,
        order: 20,
        locale: NS,
        inject: (sessionId: string) => ({ sessionId }),
      }, FsmFrozenWatcher)
      return () => {
        unregister()
      }
    } catch {
      return () => {}
    }
  })
  const start = (): void => {
    const service = serviceOf(ctx)
    if (service !== undefined) startPublishing(ctx, service)
  }
  // Deferred start: client load order may deliver uiSession after this plugin.
  const injectFace = (ctx as unknown as {
    inject?: (names: readonly string[], callback: () => void) => void
  }).inject
  if (typeof injectFace === 'function') injectFace.call(ctx, ['uiSession'], start)
  else start()
}
