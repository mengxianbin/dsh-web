/**
 * When a finished turn may be announced: after the family it belongs to falls
 * quiet, not when the frame arrives.
 *
 * A `turn/end` increment is a fact about one turn and nothing more. The work the
 * user started with it may still be going: the subagent sessions the host spawned
 * under it at any depth, and the background jobs the host still holds under any of
 * them, outlive the turn that started them. A phone told "turn finished" at the
 * frame wakes on a roster that still badges a session running, reads a card that
 * says ended while the work goes on, and is told again by a second turn end it
 * never asked for. §28's notification and §29's card answer the same question — "is
 * this work still going" — and that question has one answer, the family's.
 *
 * The family is the root a session's parent chain climbs to, plus every session
 * under that root at any depth. A leaf session's own turn end therefore waits for
 * the root and for the siblings and cousins it shares that root with, which is the
 * work the user actually started. So a turn end is registered here instead of sent,
 * and sent once the host says the family is quiet. Three rules hold that together:
 *
 * - the answer comes from the host and nowhere else: one `session/list` read for the
 *   running flags, the parent chain and each session's origin, and the host's job
 *   registry for the jobs it attributes to a session. This module invents no
 *   timer-based guess and reads no client state, because a guess that says "quiet"
 *   is a lock screen saying the work finished when it did not;
 * - nothing on the frame path waits: a registration stores five fields and arms a
 *   timer, so a follow stream still publishes its increment at the speed it did
 *   before;
 * - the wait has no deadline. A family that stays busy is never announced, and a
 *   host that cannot answer is asked again rather than read as quiet: announcing
 *   work that is still running is the failure this channel exists to prevent, and a
 *   notification that never arrives is the lesser one. One question, though, is
 *   bounded ({@link TURN_END_QUIET_PROBE_TIMEOUT_MS}): a read the gateway never
 *   returns is abandoned as that question's own failure and the entry asks again, so
 *   a stuck call cannot leave the entry holding no question to ask and no way to
 *   speak. One line at {@link TURN_END_QUIET_REPORT_MS} says the bridge is still
 *   waiting, so an operator is not left guessing why a phone stayed silent.
 *
 * Not every turn end is the phone's to hear. A session the host spawned as a
 * subagent (`origin: "subagent"`) ends turns nobody asked this bridge about, so its
 * turn end is dropped on its first answer unless the phone itself prompted that
 * session over the wire.
 * @module dsh-remote-bridge/core/turn-end-quiet
 */

import { failureText } from './gateway-errors.ts'
import type { JobRoster } from './jobs.ts'
import type { LiveActivityNotifier } from './liveactivity.ts'
import { pushEventOfTurnEnd, type PushEvent, type PushNotifier } from './push.ts'
import { wireArgs, type BridgeGateway, type GatewayPeer } from './wire.ts'

/**
 * How long a held turn end waits before the bridge logs that it is still waiting,
 * in milliseconds.
 *
 * A progress line and never a send: the wait itself has no cap, because announcing a
 * turn while its family still works is exactly what this module exists to prevent.
 */
export const TURN_END_QUIET_REPORT_MS = 600_000

/**
 * How long a held turn end waits before asking the host again, in milliseconds.
 *
 * A turn end usually finds its family already quiet — the host clears the flag as
 * the turn finishes — so the first question is the one that matters, and five
 * seconds is short enough that the notification a user waits for is not visibly
 * late. The interval is also what bounds how many questions one held turn end can
 * cost: at most one every five seconds, never more than one in flight.
 */
export const TURN_END_QUIET_INTERVAL_MS = 5_000

/**
 * How long one question to the host may stay unanswered before the bridge abandons
 * that question, in milliseconds.
 *
 * Three times {@link TURN_END_QUIET_INTERVAL_MS}. A `session/list` read the host is
 * willing to make comes back well inside one interval, so a question that outlives
 * three of them is a call that will not return — a stuck gateway request, not a slow
 * host — and an entry that keeps waiting for it has no next question to ask, which is
 * exactly how a phone goes permanently silent. The bound belongs to the question and
 * never to the turn end: an abandoned question answers nothing, the entry stays held,
 * and the next question leaves on the usual interval.
 */
export const TURN_END_QUIET_PROBE_TIMEOUT_MS = 15_000

/**
 * How many session ids the gate remembers the phone prompting, at most.
 *
 * The set exists to tell the phone's own subagent sessions from the ones it merely
 * watches, and a bridge that runs for weeks must not grow it without end: the oldest
 * id is dropped first, and a session dropped that way and prompted again enters as a
 * new one.
 */
export const TURN_END_PHONE_PROMPTED_MAX = 5_000

/** The host's answer about the work one session's family still holds. */
export interface QuietAnswer {
  /** Whether nothing in this session's family is still going. */
  readonly quiet: boolean
  /** What was still going when it was not, in one token for the log line. */
  readonly busy?: string
  /**
   * Present only when the host says another session spawned this one
   * (`origin: "subagent"`).
   *
   * Absent is a host that said nothing about the session's origin, which is not the
   * same as saying it has none: a turn end is announced for anything the host does
   * not name as a subagent.
   */
  readonly subagent?: boolean
}

/** Whether one session's family is quiet right now, as the host answers it. */
export type QuietProbe = (sessionId: string) => Promise<QuietAnswer>

export interface TurnEndQuietOptions {
  /** The notification path of §28; absent is a bridge that sends no notification. */
  readonly push?: PushNotifier
  /** The card path of §29; absent for the same reason. */
  readonly liveActivity?: LiveActivityNotifier
  /**
   * The host's own answer, asked off the frame path.
   *
   * Absent is a bridge assembled without one, which cannot tell a quiet family from
   * a busy one — nor a subagent session from the phone's own — and therefore reports
   * at the frame rather than holding anything back.
   */
  readonly probe?: QuietProbe
  readonly now?: () => number
  readonly log?: (message: string) => void
  /** When the still-waiting line is logged; the default is {@link TURN_END_QUIET_REPORT_MS}. */
  readonly reportAfterMs?: number
  /** The re-check interval; the default is {@link TURN_END_QUIET_INTERVAL_MS}. */
  readonly intervalMs?: number
  /**
   * How many phone-prompted session ids to remember; the default and the ceiling are
   * both {@link TURN_END_PHONE_PROMPTED_MAX}, and a deployment lowers it for a suite.
   */
  readonly phonePromptLimit?: number
}

/** One turn end held until its family is quiet. */
interface Waiting {
  readonly sessionId: string
  /** §28's event, decided when the turn end was registered. */
  event: PushEvent
  /** The host's own reason, kept because §29 decides ended versus failed from it. */
  reason: string
  readonly registeredAt: number
  /** The next question to the host that is armed, if one is. */
  check: NodeJS.Timeout | undefined
  /** The one-shot timer that says the wait is still going, if it has not fired. */
  report: NodeJS.Timeout | undefined
  /** Why the last question answered "not quiet". */
  busy: string | undefined
  /**
   * The generation of the question in flight, or zero when none is out.
   *
   * A generation rather than a flag: a question the bound has abandoned settles under
   * a number that is no longer current, so its answer can neither announce anything
   * nor ask again, and one entry never has two questions out at once.
   */
  asking: number
  /** The one-shot bound on the question in flight, until it answers or is abandoned. */
  deadline: NodeJS.Timeout | undefined
}

/**
 * The bridge's outbound turn-end path: registration now, announcement when quiet.
 *
 * Deliberately inert when neither channel can send: {@link enabled} is false, no
 * entry is stored and no timer is armed, so a bridge without an Apple signing key
 * behaves — byte for byte, frame for frame — exactly as it did before this module
 * existed, and no host call is ever made on its behalf.
 */
export class TurnEndQuietGate {
  readonly #options: TurnEndQuietOptions
  readonly #now: () => number
  readonly #log: (message: string) => void
  /** Held turn ends by session id; one session has one thing to announce. */
  readonly #waiting = new Map<string, Waiting>()
  /** The sessions the phone itself prompted, oldest first. */
  readonly #phonePrompted = new Set<string>()
  readonly #phonePromptLimit: number
  /** The last question generation handed out, so no question is ever minted twice. */
  #asked = 0
  #disposed = false

  constructor(options: TurnEndQuietOptions) {
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
    this.#log = options.log ?? (() => undefined)
    // The ceiling is this module's own rule, so a configured limit can only lower it.
    this.#phonePromptLimit = Math.max(1, Math.min(options.phonePromptLimit ?? TURN_END_PHONE_PROMPTED_MAX, TURN_END_PHONE_PROMPTED_MAX))
  }

  /** @returns whether either channel can send, which is the only case a turn end is held at all. */
  get enabled(): boolean {
    if (this.#disposed) return false
    return this.#options.push?.enabled === true || this.#options.liveActivity?.enabled === true
  }

  /** @returns how many turn ends are held right now. */
  get held(): number {
    return this.#waiting.size
  }

  /**
   * Hold one finished turn until its family is quiet, then announce it.
   *
   * Returns at once and never awaits a host read: the caller is a follow stream
   * that has already published its increment.
   * @param sessionId - the session the turn belonged to.
   * @param reason - the host's own reason for ending it.
   */
  noteTurnEnd(sessionId: string, reason: string): void {
    if (!this.enabled) return
    try {
      this.#register(sessionId, reason)
    } catch (error) {
      this.#log(`turn-end for ${sessionId} could not be held: ${failureText(error)}`)
    }
  }

  /**
   * Remember that the phone itself prompted one session.
   *
   * This is the one thing that makes a subagent session's turn end announceable: the
   * host spawns those on its own, and a phone that never asked that session anything
   * is not waiting to hear how its turn went. Bounded and first in, first out, so the
   * memory is the recent work rather than everything since the bridge started.
   * @param sessionId - the session a `session/prompt` frame carried.
   */
  notePhonePrompt(sessionId: string): void {
    if (sessionId === '') return
    // A session prompted again keeps its place: the question is whether the phone ever
    // prompted it, and the oldest entry is the one whose answer is least likely to be
    // asked again.
    if (this.#phonePrompted.has(sessionId)) return
    this.#phonePrompted.add(sessionId)
    while (this.#phonePrompted.size > this.#phonePromptLimit) {
      const oldest = this.#phonePrompted.values().next().value
      if (oldest === undefined) break
      this.#phonePrompted.delete(oldest)
    }
  }

  /**
   * Drop a held turn end because another turn is on.
   *
   * A caller reports this from the evidence it actually has — an increment for the
   * session that is not a turn end — so a turn the bridge cannot see costs the user
   * nothing: the held end is still announced, and the turn that is really running
   * ends with its own report.
   * @param sessionId - the session that started working again.
   */
  noteTurnStarted(sessionId: string): void {
    if (this.#waiting.size === 0) return
    const waiting = this.#waiting.get(sessionId)
    if (waiting === undefined) return
    this.#forget(waiting)
    this.#log(`turn-end dropped session=${sessionId} reason=new-turn`)
  }

  /** Drop every held turn end and every timer. Idempotent. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const waiting of [...this.#waiting.values()]) this.#forget(waiting)
    this.#waiting.clear()
    this.#phonePrompted.clear()
  }

  /** Store one registration, or fold it into the one already held for that session. */
  #register(sessionId: string, reason: string): void {
    const held = this.#waiting.get(sessionId)
    if (held !== undefined) {
      // One session has one thing to announce, so a second turn end replaces what
      // will be said and keeps the instant the first one registered: a session that
      // keeps ending turns cannot postpone its own announcement for ever.
      held.event = pushEventOfTurnEnd(reason)
      held.reason = reason
      this.#log(`turn-end registered session=${sessionId} event=${held.event} replaces=held`)
      return
    }
    const now = this.#now()
    const waiting: Waiting = {
      sessionId,
      event: pushEventOfTurnEnd(reason),
      reason,
      registeredAt: now,
      check: undefined,
      report: undefined,
      deadline: undefined,
      busy: undefined,
      asking: 0,
    }
    this.#waiting.set(sessionId, waiting)
    if (this.#options.probe === undefined) {
      this.#deliver(waiting)
      return
    }
    this.#log(`turn-end registered session=${sessionId} event=${waiting.event}`)
    const report = setTimeout(() => {
      waiting.report = undefined
      this.#stillWaiting(waiting)
    }, Math.max(0, this.#options.reportAfterMs ?? TURN_END_QUIET_REPORT_MS))
    // A notification waiting on work it did not start must never keep the host
    // process alive.
    report.unref?.()
    waiting.report = report
    this.#arm(waiting)
  }

  /** Arm the next question to the host. */
  #arm(waiting: Waiting): void {
    if (this.#disposed || this.#waiting.get(waiting.sessionId) !== waiting) return
    // A zero interval would turn the re-check into a zero-delay loop on a family that
    // never falls quiet, so the floor is one millisecond.
    const interval = Math.max(1, this.#options.intervalMs ?? TURN_END_QUIET_INTERVAL_MS)
    const timer = setTimeout(() => {
      waiting.check = undefined
      this.#check(waiting)
    }, interval)
    timer.unref?.()
    waiting.check = timer
  }

  /**
   * Ask the host once whether a held entry's family is quiet.
   *
   * One question is out at a time, and every question carries its own bound: a read
   * the gateway never returns would otherwise leave the entry holding a question that
   * has no answer coming, with no next question armed behind it — the channel silenced
   * for as long as the entry is held. The bound ends that one question only; the entry
   * keeps waiting and the next question leaves on the usual interval.
   */
  #check(waiting: Waiting): void {
    if (this.#disposed || this.#waiting.get(waiting.sessionId) !== waiting) return
    const probe = this.#options.probe
    if (probe === undefined || waiting.asking !== 0) return
    // Every question is one generation, minted here and never reused. A question the
    // bound abandons settles under a generation that is no longer in flight, so it can
    // neither announce anything nor ask a second time.
    const generation = ++this.#asked
    waiting.asking = generation
    void Promise.resolve()
      .then(async (): Promise<QuietAnswer | undefined> => {
        if (this.#disposed || this.#waiting.get(waiting.sessionId) !== waiting) return undefined
        if (waiting.asking !== generation) return undefined
        // The bound is armed here, where the question really leaves, rather than at the
        // call site: it times the host read itself and not the turn of the loop that
        // queued it. Nothing short of that loop never running can starve this line.
        const deadline = setTimeout(() => {
          waiting.deadline = undefined
          if (this.#disposed || this.#waiting.get(waiting.sessionId) !== waiting) return
          // Only the question this bound was armed for is abandoned: one that has
          // already answered has armed the next question and is not this bound's to
          // touch.
          if (waiting.asking !== generation) return
          waiting.asking = 0
          // An answer that never came is not a quiet answer: the token says which
          // failure it was, one line says the question was given up on, and the entry
          // asks again on its interval.
          waiting.busy = 'unreadable'
          this.#log(`turn-end quiet check unreadable session=${waiting.sessionId} after=${TURN_END_QUIET_PROBE_TIMEOUT_MS}ms`)
          this.#arm(waiting)
        }, TURN_END_QUIET_PROBE_TIMEOUT_MS)
        // A question waiting on a host that may never answer must never keep the host
        // process alive either.
        deadline.unref?.()
        waiting.deadline = deadline
        return await probe(waiting.sessionId)
      })
      .then((answer) => {
        // Nothing to take an answer for: the question never left, or the bound has
        // already abandoned this generation.
        if (answer === undefined || waiting.asking !== generation) return
        waiting.asking = 0
        this.#dropDeadline(waiting)
        if (this.#disposed || this.#waiting.get(waiting.sessionId) !== waiting) return
        // A session the host spawned as a subagent is not the phone's own work, so its
        // turn end is dropped rather than announced — unless the phone prompted that
        // session itself, in which case it is exactly what the phone is waiting for.
        if (answer.subagent === true && !this.#phonePrompted.has(waiting.sessionId)) {
          this.#forget(waiting)
          this.#log(`turn-end dropped session=${waiting.sessionId} reason=subagent-not-prompted`)
          return
        }
        if (answer.quiet) {
          this.#deliver(waiting)
          return
        }
        // The reason is kept rather than logged here: a family that is busy for a
        // minute would otherwise write twelve lines saying the same thing, and the
        // lines worth reading are the still-waiting one and the announcement's.
        waiting.busy = answer.busy ?? 'unstated'
        this.#arm(waiting)
      })
      .catch((error: unknown) => {
        if (waiting.asking !== generation) return
        waiting.asking = 0
        this.#dropDeadline(waiting)
        if (this.#disposed || this.#waiting.get(waiting.sessionId) !== waiting) return
        // An unreadable answer is one line and another try: the host may answer the
        // next one, and nothing is announced on a question that got no answer.
        waiting.busy = 'unreadable'
        this.#log(`turn-end quiet check failed session=${waiting.sessionId}: ${failureText(error)}`)
        this.#arm(waiting)
      })
  }

  /** Cancel the bound on the question in flight, if it is still armed. */
  #dropDeadline(waiting: Waiting): void {
    if (waiting.deadline !== undefined) clearTimeout(waiting.deadline)
    waiting.deadline = undefined
  }

  /**
   * Say once that a held turn end is still waiting, and keep holding it.
   * @param waiting - the entry that has been held this long.
   */
  #stillWaiting(waiting: Waiting): void {
    if (this.#disposed || this.#waiting.get(waiting.sessionId) !== waiting) return
    const waited = this.#now() - waiting.registeredAt
    this.#log(`turn-end still waiting session=${waiting.sessionId} waited=${waited}ms busy=${waiting.busy ?? 'unanswered'}, nothing announced`)
  }

  /**
   * Announce one held turn end and forget it.
   *
   * The rate windows are booked inside the two calls below, at this instant: what
   * the channels admit is what they really send, never what was once registered.
   * @param waiting - the entry to announce.
   */
  #deliver(waiting: Waiting): void {
    this.#forget(waiting)
    const sessionId = waiting.sessionId
    const waited = this.#now() - waiting.registeredAt
    this.#log(`turn-end quiet session=${sessionId} waited=${waited}ms event=${waiting.event}`)
    try {
      this.#options.push?.notify(waiting.event, sessionId)
    } catch (error) {
      this.#log(`turn-end ${waiting.event} for ${sessionId} could not be sent: ${failureText(error)}`)
    }
    try {
      // The reason comes from the registration, not from anything read now: §29's
      // ended-versus-failed is a fact about how that turn ended.
      this.#options.liveActivity?.noteTurnEnd(sessionId, waiting.reason)
    } catch (error) {
      this.#log(`turn-end card for ${sessionId} could not be ended: ${failureText(error)}`)
    }
  }

  /** Drop one entry and every timer it holds. */
  #forget(waiting: Waiting): void {
    if (waiting.check !== undefined) clearTimeout(waiting.check)
    if (waiting.report !== undefined) clearTimeout(waiting.report)
    this.#dropDeadline(waiting)
    waiting.check = undefined
    waiting.report = undefined
    // A question already in flight is disowned here, so its answer can neither
    // announce nor ask again for an entry that is gone.
    waiting.asking = 0
    if (this.#waiting.get(waiting.sessionId) === waiting) this.#waiting.delete(waiting.sessionId)
  }
}

/** What {@link sessionQuietProbe} reads the host through. */
export interface SessionQuietProbeOptions {
  /** The host's gateway, the same one every connection speaks through. */
  readonly gateway: BridgeGateway
  /** The in-process owner peer every call of this bridge speaks for. */
  readonly peer: GatewayPeer
  /** The host's job registry, read for the jobs it attributes to a session. */
  readonly jobs: JobRoster
}

/**
 * The host's answer to "is this session's family quiet", built from its own facts.
 *
 * The session list is where the running flags, the parent chain and each session's
 * origin come from, and the job registry is where a job's owner and status come
 * from; neither is captured once, because both move while a held turn end waits. A
 * read that cannot be made is thrown rather than answered as quiet: "the host did
 * not answer" and "nothing is running" are different facts, and the caller retries
 * the one and announces the other.
 * @param options - the faces the answer is read through.
 * @returns the probe the gate asks.
 */
export function sessionQuietProbe(options: SessionQuietProbeOptions): QuietProbe {
  return async (sessionId: string): Promise<QuietAnswer> => {
    const value = await options.gateway.invoke({
      namespace: 'session',
      method: 'list',
      args: wireArgs('session', 'list', {}),
      peer: options.peer,
    })
    const items = typeof value === 'object' && value !== null ? (value as { items?: unknown }).items : undefined
    if (!Array.isArray(items)) throw new Error('session/list returned no item table')
    const running = new Set<string>()
    const parents = new Map<string, string>()
    let subagent: true | undefined
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as { sessionId?: unknown; running?: unknown; parentSessionId?: unknown; origin?: unknown }
      if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
      if (row.running === true) running.add(row.sessionId)
      if (typeof row.parentSessionId === 'string' && row.parentSessionId !== '') parents.set(row.sessionId, row.parentSessionId)
      // The subagent plugin writes `origin: "subagent"` on the sessions it spawned, so
      // that one word is the whole of the host's own answer about provenance.
      if (row.sessionId === sessionId && row.origin === 'subagent') subagent = true
    }
    // The host answers `running` for a session's own agent, so every member of a
    // family reads idle while the family's work goes on: the family is resolved here
    // — the root the parent chain climbs to, and every session under that root at any
    // depth — because a leaf's turn end waits for what its siblings are still doing.
    const root = familyRootOf(sessionId, parents)
    const family = new Set<string>([root])
    for (const id of parents.keys()) if (descendsFrom(id, root, parents)) family.add(id)
    if (running.has(sessionId)) return { quiet: false, busy: 'session-running', ...(subagent === undefined ? {} : { subagent }) }
    for (const id of running) {
      if (id === sessionId || !family.has(id)) continue
      // The token says which side of the session the work sits on, because the log
      // line is read by someone deciding whether the wait is reasonable.
      const side = descendsFrom(id, sessionId, parents) ? 'descendant' : 'ancestor'
      return { quiet: false, busy: `${side}-running(${id})`, ...(subagent === undefined ? {} : { subagent }) }
    }
    for (const id of family) {
      const roster = options.jobs.read(id)
      // A host that composes no job registry holds no job this bridge can name,
      // and a scope that cannot be read is not evidence of work either.
      if (roster === undefined) continue
      for (const job of roster.jobs) {
        // Only the jobs the host names an owner for count: an unowned job is not a
        // fact about this family, and spreading it over the roster would be a claim
        // the payload does not support.
        if (job.ownerSessionId === undefined || !family.has(job.ownerSessionId)) continue
        // The host's own projection omits `finishedAt` while a job is live, which is
        // what makes `stopping` count as work in progress and keeps a status this
        // bridge has never heard of from being read as a finished one.
        if (job.finishedAt === undefined) return { quiet: false, busy: `job-live(${job.id})`, ...(subagent === undefined ? {} : { subagent }) }
      }
    }
    return { quiet: true, ...(subagent === undefined ? {} : { subagent }) }
  }
}

/** @returns the session a parent chain climbs to, stopping where the chain repeats. */
function familyRootOf(sessionId: string, parents: ReadonlyMap<string, string>): string {
  const walked = new Set<string>([sessionId])
  let root = sessionId
  let cursor = parents.get(sessionId)
  while (cursor !== undefined && !walked.has(cursor)) {
    root = cursor
    walked.add(cursor)
    cursor = parents.get(cursor)
  }
  return root
}

/** @returns whether one session sits under another in the host's own parent chain. */
function descendsFrom(sessionId: string, ancestorId: string, parents: ReadonlyMap<string, string>): boolean {
  const walked = new Set<string>([sessionId])
  let cursor = parents.get(sessionId)
  while (cursor !== undefined && !walked.has(cursor)) {
    if (cursor === ancestorId) return true
    walked.add(cursor)
    cursor = parents.get(cursor)
  }
  return false
}
