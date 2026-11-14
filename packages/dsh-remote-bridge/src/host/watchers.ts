/**
 * The bridge's own follow streams: one per session that holds a live card.
 *
 * §28 and §29 both describe things this bridge must report while it is the only
 * party still awake, and everything that reports them used to hang off a
 * client's own stream: a turn end was observed only while this bridge was
 * draining a follow stream for a connected phone. A suspended app has no such
 * stream — its socket is closed and the subscription is aborted with the
 * connection — so the card frozen on its lock screen kept saying "running" long
 * after the turn was over, and no APNs delivery ever failed, because nothing was
 * ever sent.
 *
 * A standing watcher is that missing party: for one session with at least one
 * registered live-activity token this bridge opens its OWN follow stream, under
 * the same in-process owner peer every other gateway call speaks for, and turns
 * the one frame it cares about — `turn/end` — into the two things a card needs:
 * §28's notification and §29's card end, each addressed to that session alone.
 *
 * Five rules keep that from becoming a second, unaccountable scheduler:
 *
 * - a watcher exists exactly while its session holds a card token, reconciled by
 *   {@link StandingWatchers.sync} from the roster rather than from any client
 *   frame;
 * - at most {@link WATCHER_LIMIT} streams are open at once; past that a session
 *   is logged once and left unwatched, so a card on a session that never ends
 *   cannot grow the set without bound;
 * - dedupe is inherited, not added: a client that is also following the same
 *   session sees the same turn end, and the two reports collapse in the layers
 *   that already own that rule — §28.5's `(sessionId, event)` window and §29's
 *   identical-content key. No third window is introduced here;
 * - a stream that ends on its own is re-armed after {@link WATCHER_REOPEN_MS},
 *   because the next turn is the next thing a card has to show;
 * - nothing a watcher does can reach a client frame: every failure is one log
 *   line, and a stream that cannot be opened is dropped rather than retried in a
 *   tight loop.
 * @module dsh-remote-bridge/host/watchers
 */

import { isTurnStartDelta, SNAPSHOT_MAX_MESSAGES } from '../core/connection.ts'
import { deltaOfFollowFrame, MessageIndex, readFollowBaseline, SpawnCallIndex, ToolCallIndex } from '../core/dsh-frames.ts'
import { failureText, withServiceUnavailableRetry } from '../core/gateway-errors.ts'
import type { LiveActivityNotifier } from '../core/liveactivity.ts'
import { pushEventOfTurnEnd, type PushNotifier } from '../core/push.ts'
import type { TurnEndQuietGate } from '../core/turn-end-quiet.ts'
import { sessionAddress, wireArgs, type BridgeGateway, type GatewayPeer } from '../core/wire.ts'

/** Most standing streams this bridge keeps open at once. */
export const WATCHER_LIMIT = 64
/** How long a watcher waits before re-opening a stream that ended on its own. */
export const WATCHER_REOPEN_MS = 1_000

export interface StandingWatcherOptions {
  /** The host's gateway, the same one the connections speak through. */
  readonly gateway: BridgeGateway
  /** The in-process owner peer every call of this bridge speaks for. */
  readonly peer: GatewayPeer
  /**
   * Sessions that currently hold at least one registered live-activity token,
   * read from the roster on every reconcile.
   */
  readonly sessions: () => readonly string[]
  /** The card path of §29; absent is a bridge with no signing key. */
  readonly liveActivity?: LiveActivityNotifier
  /** The notification path of §28; absent for the same reason. */
  readonly push?: PushNotifier
  /**
   * The gate both channels announce a finished turn through, so a card and a
   * notification wait for the same quiet session. Absent is a watcher set built
   * without one — a suite — and then both report at the frame.
   */
  readonly turnEndQuiet?: TurnEndQuietGate
  readonly log: (message: string) => void
  readonly limit?: number
  readonly reopenMs?: number
  readonly maxMessages?: number
}

/** One open stream, and the handle that closes it. */
interface Watching {
  readonly controller: AbortController
}

/**
 * The bridge's stand-in for a client that is no longer there.
 *
 * Deliberately inert when neither push path is configured: {@link sync} returns
 * without opening anything, so a bridge without an Apple signing key keeps the
 * exact stream count it had before this module existed.
 */
export class StandingWatchers {
  readonly #options: StandingWatcherOptions
  /** Open streams by session id. */
  readonly #open = new Map<string, Watching>()
  /** Sessions a reconcile had to refuse for the cap, so each is logged once. */
  readonly #refused = new Set<string>()
  /** Pending re-arm timers, cleared on dispose. */
  readonly #timers = new Set<NodeJS.Timeout>()
  #disposed = false

  constructor(options: StandingWatcherOptions) {
    this.#options = options
  }

  /** @returns how many standing streams are open right now. */
  get size(): number {
    return this.#open.size
  }

  /** @returns whether this bridge has any path worth opening a stream for. */
  get enabled(): boolean {
    return this.#options.liveActivity !== undefined || this.#options.push !== undefined
  }

  /**
   * Reconcile the open streams with the sessions that hold a card right now.
   *
   * Called when the roster changes (a registration arrived, a dead token was
   * retired) and when a stream ends. Idempotent, and safe to call before the
   * roster has been read: no session with a token means nothing to watch.
   */
  sync(): void {
    if (this.#disposed || !this.enabled) return
    let wanted: readonly string[]
    try {
      wanted = this.#options.sessions()
    } catch (error) {
      this.#options.log(`watcher reconcile failed: ${failureText(error)}`)
      return
    }
    const desired = new Set(wanted)
    for (const [sessionId, watching] of this.#open) {
      if (desired.has(sessionId)) continue
      this.#open.delete(sessionId)
      watching.controller.abort()
      this.#options.log(`watcher close session=${sessionId} reason=cards-gone`)
    }
    const limit = this.#options.limit ?? WATCHER_LIMIT
    for (const sessionId of desired) {
      if (this.#open.has(sessionId)) continue
      if (this.#open.size >= limit) {
        if (!this.#refused.has(sessionId)) {
          this.#refused.add(sessionId)
          this.#options.log(`watcher refused session=${sessionId} reason=limit(${String(limit)})`)
        }
        continue
      }
      this.#watch(sessionId)
    }
  }

  /** Close every stream and drop every pending re-arm. Idempotent. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    for (const watching of this.#open.values()) watching.controller.abort()
    this.#open.clear()
  }

  /** Open one session's stream and start consuming it. */
  #watch(sessionId: string): void {
    const watching: Watching = { controller: new AbortController() }
    this.#open.set(sessionId, watching)
    this.#options.log(`watcher open session=${sessionId} reason=cards`)
    void this.#run(sessionId, watching).catch((error: unknown) => {
      // A watch that cannot even be started is one line: the caller is this
      // bridge itself, and there is no frame to fail.
      this.#options.log(`watcher failed session=${sessionId}: ${failureText(error)}`)
    })
  }

  /** Consume one session's stream until it ends or is aborted. */
  async #run(sessionId: string, watching: Watching): Promise<void> {
    const signal = watching.controller.signal
    let iterator: AsyncIterator<unknown>
    try {
      const stream = await withServiceUnavailableRetry(() => this.#options.gateway.stream({
        namespace: 'session',
        method: 'follow',
        args: wireArgs('session', 'follow', {
          address: sessionAddress(sessionId),
          // The shape a connection opens: one stream per session carries both
          // the baseline and the process-local deltas. The watcher needs no
          // baseline — attaching is what makes it a party.
          assistantStream: true,
          maxMessages: this.#options.maxMessages ?? SNAPSHOT_MAX_MESSAGES,
        }),
        peer: this.#options.peer,
        signal,
      }))
      iterator = stream[Symbol.asyncIterator]()
    } catch (error) {
      this.#options.log(`watcher stream refused session=${sessionId}: ${failureText(error)}`)
      // Not re-armed: a stream the host refuses would be refused again on every
      // retry, and the next roster change is the honest trigger to try once more.
      this.#settle(sessionId, watching, false)
      return
    }
    const toolCalls = new ToolCallIndex()
    const messages = new MessageIndex()
    // No capability gate here: a watcher publishes no frame, so the thread kind
    // of a delta is none of its business.
    const memory = { subagentThread: false, spawnCalls: new SpawnCallIndex() }
    try {
      const first = await iterator.next()
      if (first.done === true || readFollowBaseline(first.value) === undefined) {
        this.#options.log(`watcher stream unusable session=${sessionId}`)
        await iterator.return?.()
        this.#settle(sessionId, watching, false)
        return
      }
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) break
        if (signal.aborted) break
        const delta = deltaOfFollowFrame(next.value, toolCalls, messages, memory)
        if (delta === undefined) continue
        // Only an increment that proves this session's own work proves a new turn; a
        // settled child, a usage count and a catalog change all arrive here without
        // meaning the user prompted again.
        if (delta.kind !== 'turn-end') {
          if (isTurnStartDelta(delta)) this.#options.turnEndQuiet?.noteTurnStarted(sessionId)
          continue
        }
        this.#turnEnded(sessionId, delta.reason)
      }
    } catch (error) {
      if (!signal.aborted) this.#options.log(`watcher stream ended session=${sessionId}: ${failureText(error)}`)
    } finally {
      this.#settle(sessionId, watching)
    }
  }

  /**
   * Report one turn end to both channels that need it.
   *
   * Both, on purpose: §28's notification is what wakes a phone that is not
   * holding a socket, and §29's card end is what clears a lock screen. Reporting
   * only one of them leaves the other surface stale, which is the exact state
   * this module exists to end. Both go through the shared gate, so a watcher and
   * a client that followed the same session announce it at the same instant — when
   * the session is quiet — and never at the frame.
   */
  #turnEnded(sessionId: string, reason: string): void {
    try {
      const gate = this.#options.turnEndQuiet
      if (gate !== undefined) {
        gate.noteTurnEnd(sessionId, reason)
        // Nothing has been sent at this point, so the line says what really
        // happened: the end is held, and the gate's own line reports the send.
        this.#options.log(`watcher turn-end session=${sessionId} reason=${reason} held=quiet-gate`)
        return
      }
      this.#options.push?.notify(pushEventOfTurnEnd(reason), sessionId)
      this.#options.liveActivity?.noteTurnEnd(sessionId, reason)
      const pushed = this.#options.liveActivity?.enabled === true ? 'card' : 'notification-only'
      this.#options.log(`watcher turn-end session=${sessionId} reason=${reason} pushed=${pushed}`)
    } catch (error) {
      this.#options.log(`watcher turn-end session=${sessionId} failed: ${failureText(error)}`)
    }
  }

  /**
   * Forget one stream's handle, and re-arm it when that is the right answer.
   * @param sessionId - the session whose stream is over.
   * @param watching - the exact stream being settled, so a newer one is untouched.
   * @param rearm - whether a stream that was open and then ended should come back.
   */
  #settle(sessionId: string, watching: Watching, rearm = true): void {
    watching.controller.abort()
    if (this.#open.get(sessionId) === watching) this.#open.delete(sessionId)
    if (rearm) this.#rearm(sessionId)
  }

  /**
   * Schedule one reconcile, so a session still holding a card gets its stream
   * back after the stream it was on ended.
   */
  #rearm(sessionId: string): void {
    if (this.#disposed || this.#open.has(sessionId)) return
    let wanted = false
    try {
      wanted = this.#options.sessions().includes(sessionId)
    } catch {
      wanted = false
    }
    if (!wanted) return
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      this.sync()
    }, this.#options.reopenMs ?? WATCHER_REOPEN_MS)
    timer.unref?.()
    this.#timers.add(timer)
  }
}
