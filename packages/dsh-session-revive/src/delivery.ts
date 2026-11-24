/**
 * Nudge delivery dispatch (design revive-child-rescue-1124 件1): route one
 * decided revive nudge to its target. Top-level sessions keep the generic
 * prompt path untouched; `origin=subagent` children ride the host subagent
 * delivery seam (parent-authorized queue) with the ruled three boundary
 * states:
 *
 * - **parent live** → deliver through the seam directly;
 * - **parent dead** → rescue the parent through the existing top-level
 *   prompt path first, then deliver once the parent agent is live again;
 * - **parent absent (orphan) / parent rescue failed / subagent runtime
 *   missing** → fail-closed **pre-send intercept**: one `stall-unsendable`
 *   evidence line, zero attempt, zero fence probing (围栏零改 — the generic
 *   fenced prompt is never even tried for a child).
 *
 * Outcome vocabulary (B4② division, ruled at dispatch): `sent` = accepted
 * by the transport; `failed` = attempted and rejected (the `nudge-failed`
 * family, post-attempt); `unsendable` = intercepted before any send (the
 * `stall-unsendable` family). Both non-sent outcomes must clear the
 * machine's in-flight marker (a stuck marker would deny forever).
 */

/** Header facts the dispatch needs; captured from list rows and live events. */
export interface ChildHeaderFacts {
  readonly origin?: 'subagent'
  readonly parentSession?: string
}

/** Why a child nudge was intercepted before any send (件1 fail-closed states). */
export type UnsendableReason = 'no-parent' | 'parent-rescue-failed' | 'subagent-runtime-unavailable'

/** Injected host surface; the plugin shell binds live services, tests bind fakes. */
export interface NudgeDeliveryDeps {
  /** Captured child header; `undefined` for top-level/unknown sessions. */
  header(sessionId: string): ChildHeaderFacts | undefined
  /** Live direct parent agent (opaque here), or `undefined` when none is live. */
  liveParent(parentId: string): unknown
  /** The subagent runtime service owning the delivery seam, or `undefined`. */
  runtime(): unknown
  /** Generic prompt path (top-level send + parent rescue). Rejects on failure. */
  prompt(sessionId: string, text: string): Promise<void>
  /** Parent-authorized child delivery through the subagent seam. Rejects on failure. */
  deliver(parent: unknown, childId: string, text: string): Promise<void>
  /** Accepted by the transport. */
  sent(sessionId: string): void
  /** Attempted and rejected — clear in-flight, land `nudge-failed`. */
  failed(sessionId: string, error: unknown): void
  /** Intercepted before any send — clear in-flight, land `stall-unsendable`. */
  unsendable(sessionId: string, reason: UnsendableReason): void
}

/**
 * Dispatch one decided nudge; never throws (every outcome lands in a dep).
 * @param sessionId - target session (top-level or subagent child).
 * @param text - nudge body already chosen by the caller.
 * @param deps - injected host surface (see {@link NudgeDeliveryDeps}).
 */
export async function dispatchNudge(
  sessionId: string,
  text: string,
  deps: NudgeDeliveryDeps,
): Promise<void> {
  const facts = deps.header(sessionId)
  if (facts === undefined || facts.origin !== 'subagent') {
    try {
      await deps.prompt(sessionId, text)
      deps.sent(sessionId)
    } catch (error: unknown) {
      deps.failed(sessionId, error)
    }
    return
  }
  const parentId = facts.parentSession
  if (parentId === undefined) {
    deps.unsendable(sessionId, 'no-parent')
    return
  }
  if (deps.runtime() === undefined) {
    deps.unsendable(sessionId, 'subagent-runtime-unavailable')
    return
  }
  let parent = deps.liveParent(parentId)
  if (parent === undefined) {
    // 先救父: the existing top-level prompt path (no fence on top-level).
    try {
      await deps.prompt(parentId, text)
    } catch {
      deps.unsendable(sessionId, 'parent-rescue-failed')
      return
    }
    parent = deps.liveParent(parentId)
    if (parent === undefined) {
      // Accepted but the parent agent is not live again — do not hard-probe
      // the fence; fail closed exactly like a failed rescue.
      deps.unsendable(sessionId, 'parent-rescue-failed')
      return
    }
  }
  try {
    await deps.deliver(parent, sessionId, text)
    deps.sent(sessionId)
  } catch (error: unknown) {
    deps.failed(sessionId, error)
  }
}
