/**
 * The Live Activity half of the push channel (protocol §29).
 *
 * The alert channel in `core/push.ts` tells a phone something happened; a Live
 * Activity is the lock-screen card that keeps being right while the app is
 * suspended, which is why it is a second payload with its own rules rather than
 * a field on the first one:
 *
 * - the request is a `liveactivity` push to a per-card APNs token, under the app
 *   bundle's `.push-type.liveactivity` topic, with `apns-expiration: 0` — a card
 *   update that arrives late is a lie about the present, so it is never resent;
 * - `content-state` is the App's own `SessionActivityState`, decoded with
 *   ActivityKit's default Codable strategy. Timestamps in it are seconds since
 *   Apple's reference date (2001-01-01T00:00:00Z), never Unix seconds: a Unix
 *   number decodes as a date decades away and the whole card fails to decode;
 * - one card shows one session. A registered card names its session, a card
 *   without one is never pushed to, and a state is delivered to the cards whose
 *   session it is about — never to "all cards", because that is how one session's
 *   question ends up on another session's lock screen (§29.9). `runningCount` is
 *   the one bridge-wide number on a card, and it stays the total on purpose;
 * - one card lays out at most three rows (§30). The address is still one session
 *   per card — rows say what that card has to tell, not who it is sent to — and
 *   every card is given them the same way: the sessions waiting on the user
 *   first, in the order their questions arrived, then the sessions running now,
 *   most recently updated first. A row's name is the host's own title with its
 *   trailing path group taken off, because §29.5 keeps paths off a lock screen;
 * - a card that would say what the card before it already said is not sent, one
 *   activity takes at most one update per `LIVE_ACTIVITY_INTERVAL_MS`, and
 *   the whole bridge at most `LIVE_ACTIVITY_PER_MINUTE` a minute. What does
 *   not fit is dropped, never queued: a card is a snapshot of now, and a backlog
 *   of stale snapshots is exactly what this channel must not deliver.
 *
 * Nothing here is awaited by a frame path. Every entry point returns before a
 * delivery starts, and a failure — connection, 401, 410, 5xx, timeout — is one
 * log line and a dropped card, never a delayed or broken follow stream (§28.5).
 * @module dsh-remote-bridge/core/liveactivity
 */

import type { PushSendResult } from './push.ts'
import { pushEventOfTurnEnd } from './push.ts'

/** The phases a lock-screen card can report. */
export type SessionActivityPhase = 'running' | 'waitingForAnswer' | 'failed' | 'ended'

/** The two events one Live Activity push carries. */
export type LiveActivityEvent = 'update' | 'end'

/**
 * Seconds from 1970-01-01T00:00:00Z to Apple's reference date, 2001-01-01T00:00:00Z.
 *
 * ActivityKit encodes a `Date` as a double relative to that reference date, so a
 * value meant to decode as "now" is Unix seconds minus this offset.
 */
export const APPLE_REFERENCE_OFFSET_SECONDS = 978_307_200

/** How long after delivery iOS may still treat a card as current. */
export const LIVE_ACTIVITY_STALE_SECONDS = 90

/** Shortest gap between two updates of the same activity. */
export const LIVE_ACTIVITY_INTERVAL_MS = 5_000

/** Most Live Activity pushes this bridge sends in any rolling minute. */
export const LIVE_ACTIVITY_PER_MINUTE = 30

/** Longest option list a card carries; the App shows them as the answer choices. */
export const LIVE_ACTIVITY_OPTION_LIMIT = 2

/** Most rows one card lays out; a fourth is dropped, never wrapped or paged (§30.2). */
export const LIVE_ACTIVITY_ROW_LIMIT = 3

/**
 * Longest row name a card carries, in characters.
 *
 * A row is one line under a status phrase, so a name longer than this is cut
 * rather than allowed to push the rest of the card off the glass.
 */
export const LIVE_ACTIVITY_ROW_NAME_MAX = 48

/** Activity ids whose last content is remembered before the oldest is forgotten. */
export const LIVE_ACTIVITY_TRACKED = 64

/**
 * The one line a card shows per phase, in the App's own words.
 *
 * Fixed English strings, one per phase, and the same table the App renders
 * (§29.7, §30.2): the words on the glass are the client's, so a bridge that sent
 * its own would put a second language on the same card. Fixed for the second
 * reason the alert channel's bodies are fixed too — a line built out of host text
 * is session content on a lock screen. `core/push.ts` keeps its own localized
 * bodies: a notification is read in the user's language, a card is the App's, and
 * both are the same event said for two different surfaces.
 */
export const ACTIVITY_STATUS_LINE = {
  running: 'Running',
  waitingForAnswer: 'Waiting for your answer',
  failed: 'Stopped',
  ended: 'Turn finished',
} as const

/**
 * The fixed line one phase shows.
 *
 * The one accessor the single-session field and a row both go through, so a
 * phase cannot be named two ways on one card.
 * @param phase - the phase whose line is wanted.
 * @returns the App's own English phrase for it.
 */
export function statusLineOf(phase: SessionActivityPhase): string {
  return ACTIVITY_STATUS_LINE[phase]
}

/**
 * How iOS ranks one card against another.
 *
 * A card waiting on the user outranks one reporting work in progress, which in
 * turn outranks a finished one; `ended` is last because it is on its way out.
 */
const RELEVANCE_SCORE: Readonly<Record<SessionActivityPhase, number>> = {
  waitingForAnswer: 100,
  failed: 90,
  running: 60,
  ended: 10,
}

/**
 * One row of the multi-session card (§30.2).
 *
 * Exactly three keys, all non-empty: the host's own name for the session, the
 * same status phrase that session's own card would carry, and its phase. There
 * is no id, no url and no count — a row is a line on a card, not a record.
 *
 * A row only ever carries one of the two live phases: a failed or ended turn is
 * the card's own `phase`, and repeating it as a row would say one thing twice
 * on a card that is already on its way out.
 */
export interface ActivityRow {
  readonly name: string
  readonly status: string
  readonly phase: SessionActivityPhase
}

/**
 * One card's state, as the App's own `SessionActivityState` decodes it.
 *
 * The key set is frozen (§29): no field may be added or renamed, because the
 * App's Codable type is the other half of this contract and a key it does not
 * declare fails the whole decode.
 */
export interface SessionActivityState {
  readonly phase: SessionActivityPhase
  readonly statusLine: string
  readonly questionHeader?: string
  readonly optionLabels?: readonly string[]
  /** Apple-reference-date seconds of the moment this bridge delivered the card. */
  readonly asOf: number
  /** Sessions running right now across the whole bridge, never below 1. */
  readonly runningCount: number
  /**
   * The sessions this card lays out, most urgent first, at most
   * {@link LIVE_ACTIVITY_ROW_LIMIT} of them (§30). Absent and empty mean the
   * same thing to the App: it lays out one row out of the single-session keys.
   */
  readonly rows?: readonly ActivityRow[]
}

/** The request body one Live Activity delivery carries (protocol §29). */
export interface LiveActivityNotification {
  readonly aps: {
    /** Unix epoch seconds of the delivery. */
    readonly timestamp: number
    readonly event: LiveActivityEvent
    readonly 'content-state': SessionActivityState
    /** Unix epoch seconds after which the card is stale: the delivery plus 90. */
    readonly 'stale-date': number
    readonly 'relevance-score': number
    /** Only an `end` for a card whose session left the roster dismisses at once. */
    readonly 'dismissal-date'?: number
  }
}

/** What the projection of one delivery says, before it is dated. */
export interface LiveActivityStateInput {
  readonly event: LiveActivityEvent
  readonly phase: SessionActivityPhase
  readonly statusLine: string
  readonly questionHeader?: string
  readonly optionLabels?: readonly string[]
  readonly runningCount: number
  /** The rows this card lays out, already chosen, ordered and capped by the notifier. */
  readonly rows?: readonly ActivityRow[]
  /** Delivery moment, in milliseconds since the Unix epoch. */
  readonly now: number
  /** Dismiss the card the moment it is delivered, instead of letting it expire. */
  readonly dismiss?: boolean
}

/** @returns the score iOS ranks one card of this phase by. */
export function relevanceScoreOf(phase: SessionActivityPhase): number {
  return RELEVANCE_SCORE[phase]
}

/**
 * The content state one card carries.
 * @param input - the projection and the delivery moment.
 * @returns the frozen key set, in a fixed order.
 */
function contentStateOf(input: LiveActivityStateInput): SessionActivityState {
  const labels = input.optionLabels === undefined
    ? undefined
    : input.optionLabels.filter(label => label !== '').slice(0, LIVE_ACTIVITY_OPTION_LIMIT)
  return {
    phase: input.phase,
    statusLine: input.statusLine,
    ...(input.questionHeader === undefined || input.questionHeader === '' ? {} : { questionHeader: input.questionHeader }),
    ...(labels === undefined || labels.length === 0 ? {} : { optionLabels: labels }),
    // ActivityKit's default strategy decodes a `Date` as a double relative to
    // Apple's reference date, so this is not `now / 1000`.
    asOf: input.now / 1000 - APPLE_REFERENCE_OFFSET_SECONDS,
    runningCount: Math.max(1, Math.trunc(input.runningCount)),
    // Appended last so the six frozen keys keep their names, their order and
    // their meaning (§29.3): a client that never reads `rows` decodes exactly
    // the state it decoded before this key existed.
    ...(input.rows === undefined ? {} : { rows: input.rows.slice(0, LIVE_ACTIVITY_ROW_LIMIT) }),
  }
}

/**
 * The push one card gets.
 *
 * Pure, and exported so the shape can be asserted without a sender: the headers
 * and this key set are the contract, and every value derived from the delivery
 * moment is derived here, once.
 * @param input - the projection and the delivery moment.
 * @returns the exact body an APNs Live Activity delivery carries.
 */
export function buildLiveActivityNotification(input: LiveActivityStateInput): LiveActivityNotification {
  const timestamp = Math.floor(input.now / 1000)
  return {
    aps: {
      timestamp,
      event: input.event,
      'content-state': contentStateOf(input),
      'stale-date': timestamp + LIVE_ACTIVITY_STALE_SECONDS,
      'relevance-score': relevanceScoreOf(input.phase),
      ...(input.event === 'end' && input.dismiss === true ? { 'dismissal-date': timestamp } : {}),
    },
  }
}

/** One card this bridge may push to. */
export interface LiveActivityAddress {
  /** The activity the App created; stable for the life of one card. */
  readonly activityId: string
  /** The per-card APNs token, which is not the device's token. */
  readonly token: string
  /**
   * The session this card shows. Absent is a card this bridge never pushes to:
   * it has no state to put on it, and borrowing another session's state is
   * exactly what §29.9 forbids.
   */
  readonly sessionId?: string
  readonly environment: 'sandbox' | 'production'
  /** The app bundle id; the topic is this bundle plus the Live Activity suffix. */
  readonly bundle: string
}

/** Whatever actually reaches a card; the APNs client implements this. */
export interface LiveActivitySender {
  sendLiveActivity(target: LiveActivityAddress, notification: LiveActivityNotification): Promise<PushSendResult>
}

/** One row of a roster this bridge just served, as the projection reads it. */
export interface ActivityRosterRow {
  readonly id: string
  readonly agentRunning?: boolean
  /** The host's own title for that session, the name a row carries (§26, §30.2). */
  readonly title?: string
  /** When the host last updated the session, in milliseconds; 0 when it names none. */
  readonly updatedAt?: number
}

/** The question or approval one session's card is waiting on. */
interface Waiting {
  readonly statusLine: string
  readonly questionHeader?: string
  readonly optionLabels?: readonly string[]
}

export interface LiveActivityNotifierOptions {
  /** The cards that are alive right now, read per delivery. */
  readonly targets: () => readonly LiveActivityAddress[]
  /** The sender; absent is a bridge with no signing key, and then nothing happens. */
  readonly sender?: LiveActivitySender
  readonly now?: () => number
  readonly log?: (message: string) => void
  /**
   * Forget a token APNs reported dead. The roster owner removes it from the
   * device row and persists, so a token that can never work again is not retried
   * on every later card (§29 token lifecycle).
   */
  readonly retire?: (activityId: string, token: string) => Promise<boolean> | boolean | void
  readonly intervalMs?: number
  readonly perMinute?: number
}

/**
 * The bridge's Live Activity path.
 *
 * Deliberately inert when no sender is configured: `enabled` is false, no
 * card is ever read and no clock is consulted, so a bridge without an Apple key
 * behaves — byte for byte, frame for frame — exactly as it did before this
 * channel existed, and `push.register` still answers the same acknowledgement
 * (§28.3: registering is one thing, sending is another).
 */
export class LiveActivityNotifier {
  readonly #options: LiveActivityNotifierOptions
  readonly #now: () => number
  readonly #log: (message: string) => void
  /** Session ids the last roster reported as running. */
  #running = new Set<string>()
  /** Session ids the last roster named. */
  #listed = new Set<string>()
  /** Session ids any roster ever named, so "left the roster" is not "never listed". */
  #known = new Set<string>()
  /** The host's own title of each session the last roster named (§26). */
  #titles = new Map<string, string>()
  /** When the host last updated each session the last roster named, in milliseconds. */
  #sessionUpdatedAt = new Map<string, number>()
  /** The question or approval each session's card is waiting on, one entry per session. */
  readonly #waiting = new Map<string, Waiting>()
  /** Content last admitted per activity id. */
  readonly #content = new Map<string, string>()
  /** When each activity id was last updated, in milliseconds. */
  readonly #updated = new Map<string, number>()
  /** Delivery timestamps inside the rolling minute. */
  #recent: number[] = []
  /** Cards already reported as carrying no session, so the line is logged once each. */
  readonly #unaddressed = new Set<string>()

  constructor(options: LiveActivityNotifierOptions) {
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
    this.#log = options.log ?? (() => undefined)
  }

  /** @returns whether this bridge will actually deliver anything. */
  get enabled(): boolean {
    return this.#options.sender !== undefined
  }

  /**
   * Take the roster this bridge just served as the current picture of what runs.
   *
   * A listing is the only place this bridge learns which sessions are live, so it
   * is where each running session's own card is refreshed: that session's card is
   * told it is running, and the number beside it is how many sessions are running
   * in total. A card waiting on the user keeps that state — listing sessions is
   * not an answer, and downgrading the card would hide the question still owed.
   * @param rows - the roster rows, as this connection built them.
   */
  noteRoster(rows: readonly ActivityRosterRow[]): void {
    if (!this.enabled) return
    try {
      this.#listed = new Set()
      this.#running = new Set()
      // The roster is the only place a row's name and its recency come from, so
      // both are replaced wholesale with it: a renamed session must not keep
      // describing itself under the name it was listed under before, and a
      // session this roster does not name has no recency to be ordered by.
      this.#titles = new Map()
      this.#sessionUpdatedAt = new Map()
      for (const row of rows) {
        this.#listed.add(row.id)
        this.#known.add(row.id)
        if (row.title !== undefined) this.#titles.set(row.id, row.title)
        this.#sessionUpdatedAt.set(row.id, row.updatedAt ?? 0)
        if (row.agentRunning === true) this.#running.add(row.id)
      }
      const runningCount = this.#running.size
      if (runningCount === 0) return
      for (const sessionId of this.#running) {
        if (this.#waiting.has(sessionId)) continue
        this.#emit(sessionId, {
          event: 'update',
          phase: 'running',
          statusLine: statusLineOf('running'),
          runningCount,
        })
      }
    } catch (error) {
      this.#log(`live activity could not be prepared from a roster: ${String(error)}`)
    }
  }

  /**
   * Report one turn that ended.
   *
   * Only that session's own card is affected: the session stops running, its
   * pending question is gone with the turn, and its card is ended — not updated —
   * because the turn it was about is over. A session that was listed before and
   * is not in the roster any more has left it, so its card is dismissed on
   * delivery instead of being left on a lock screen to describe a session that no
   * longer exists.
   * @param sessionId - the session whose turn ended.
   * @param reason - the host's own reason, read exactly as the alert channel reads it.
   */
  noteTurnEnd(sessionId: string, reason: string): void {
    if (!this.enabled) return
    try {
      this.#waiting.delete(sessionId)
      this.#running.delete(sessionId)
      const completed = pushEventOfTurnEnd(reason) === 'turn-end'
      this.#emit(sessionId, {
        event: 'end',
        phase: completed ? 'ended' : 'failed',
        statusLine: statusLineOf(completed ? 'ended' : 'failed'),
        runningCount: this.#running.size,
        ...(this.#known.has(sessionId) && !this.#listed.has(sessionId) ? { dismiss: true } : {}),
      })
    } catch (error) {
      this.#log(`live activity end for ${sessionId} could not be prepared: ${String(error)}`)
    }
  }

  /**
   * Report a question that reached a phone and is now waiting for an answer.
   *
   * Only the header and at most two option labels cross: they are the choices the
   * App can offer. The question itself and its detail stay behind the wire, the
   * same rule the alert channel follows (§28.4), and only this session's card is
   * told — another session's card has no business showing this question (§29.9).
   * @param sessionId - the session that asked.
   * @param question - the first question of the claimed batch.
   */
  noteQuestion(sessionId: string, question: { readonly header?: string; readonly optionLabels?: readonly string[] }): void {
    if (!this.enabled) return
    try {
      const header = question.header === '' ? undefined : question.header
      const labels = question.optionLabels?.filter(label => label !== '').slice(0, LIVE_ACTIVITY_OPTION_LIMIT)
      // One waiting phrase serves a question and an approval: the App's table has
      // one, and a bridge-only second line would be a word it never renders.
      const waiting: Waiting = {
        statusLine: statusLineOf('waitingForAnswer'),
        ...(header === undefined ? {} : { questionHeader: header }),
        ...(labels === undefined || labels.length === 0 ? {} : { optionLabels: labels }),
      }
      this.#waiting.set(sessionId, waiting)
      this.#emit(sessionId, { event: 'update', phase: 'waitingForAnswer', runningCount: this.#running.size, ...waiting })
    } catch (error) {
      this.#log(`live activity question for ${sessionId} could not be prepared: ${String(error)}`)
    }
  }

  /**
   * Report an approval that reached a phone and is blocking the agent.
   *
   * The card says what state that session is in and nothing more: an approval's
   * own summary is a tool's reason text, which is exactly the session content a
   * lock screen must not carry, so it gets the fixed line and no details.
   * @param sessionId - the session whose tool is blocked.
   */
  noteApproval(sessionId: string): void {
    if (!this.enabled) return
    try {
      const waiting: Waiting = { statusLine: statusLineOf('waitingForAnswer') }
      this.#waiting.set(sessionId, waiting)
      this.#emit(sessionId, { event: 'update', phase: 'waitingForAnswer', runningCount: this.#running.size, ...waiting })
    } catch (error) {
      this.#log(`live activity approval for ${sessionId} could not be prepared: ${String(error)}`)
    }
  }

  /**
   * Report that the question one card was waiting on is gone — answered here, on
   * the desktop, or expired.
   *
   * A card left saying "waiting for an answer" after the answer landed is the one
   * lie a lock screen cannot afford, so that session's card goes back to whatever
   * is true now. Nothing is sent when that session is not known to run: there is
   * no fact to show, and the ended card already covers that case.
   * @param sessionId - the session whose claim settled.
   */
  noteSettled(sessionId: string): void {
    if (!this.enabled) return
    if (!this.#waiting.has(sessionId)) return
    try {
      this.#waiting.delete(sessionId)
      if (!this.#running.has(sessionId)) return
      this.#emit(sessionId, {
        event: 'update',
        phase: 'running',
        statusLine: statusLineOf('running'),
        runningCount: this.#running.size,
      })
    } catch (error) {
      this.#log(`live activity resume for ${sessionId} could not be prepared: ${String(error)}`)
    }
  }

  /**
   * The cards one session's state is delivered to.
   *
   * A card that names no session is skipped and reported once: §29.9 makes the
   * session the address, and a card this bridge cannot address is a card it must
   * not write to at all.
   * @param sessionId - the session the state is about.
   * @returns that session's cards, possibly none.
   */
  #targetsFor(sessionId: string): readonly LiveActivityAddress[] {
    const matched: LiveActivityAddress[] = []
    for (const target of this.#options.targets()) {
      if (target.sessionId === undefined) {
        if (this.#unaddressed.has(target.activityId)) continue
        this.#unaddressed.add(target.activityId)
        this.#log(`live activity ${target.activityId} names no session and is never pushed to`)
        while (this.#unaddressed.size > LIVE_ACTIVITY_TRACKED) {
          const oldest = this.#unaddressed.keys().next()
          if (oldest.done === true) break
          this.#unaddressed.delete(oldest.value)
        }
        continue
      }
      if (target.sessionId === sessionId) matched.push(target)
    }
    return matched
  }

  /**
   * The rows one card lays out (§30).
   *
   * The order is the whole of the bridge-side priority §30.6 leaves open: a
   * session waiting on the user outranks one that is merely working, so the
   * questions come first in the order they arrived (the waiting map remembers
   * that order), then the running sessions by how recently the host touched
   * them. Which sessions run is read from the same set the single-session state
   * is built from, so a card and its rows can never disagree about that.
   *
   * Only the two live phases ever appear on a row. An ended or failed turn is the
   * card's own `phase` and its own line, said once: adding it here as well would
   * repeat the same sentence and make a card that is already leaving taller.
   * @returns at most {@link LIVE_ACTIVITY_ROW_LIMIT} rows, most urgent first.
   */
  #rowsFor(): readonly ActivityRow[] {
    const rows: ActivityRow[] = []
    for (const [id, waiting] of this.#waiting) {
      if (rows.length >= LIVE_ACTIVITY_ROW_LIMIT) return rows
      this.#appendRow(rows, id, waiting.statusLine, 'waitingForAnswer')
    }
    for (const id of this.#runningByRecency()) {
      if (rows.length >= LIVE_ACTIVITY_ROW_LIMIT) return rows
      if (this.#waiting.has(id)) continue
      this.#appendRow(rows, id, statusLineOf('running'), 'running')
    }
    return rows
  }

  /**
   * Add one row, unless that session has no usable name.
   *
   * §30.2 makes all three keys non-empty and §30.4 drops a row it cannot name,
   * so a session the host never titled is left out here instead of on a lock
   * screen — an empty list is the same card as no list at all.
   * @param rows - the row list being built.
   * @param sessionId - the session the row would name.
   * @param status - that session's status line.
   * @param phase - that session's phase.
   */
  #appendRow(rows: ActivityRow[], sessionId: string, status: string, phase: SessionActivityPhase): void {
    const name = this.#nameOf(sessionId)
    if (name === '') return
    rows.push({ name, status, phase })
  }

  /** @returns the running session ids, most recently updated first. */
  #runningByRecency(): readonly string[] {
    return [...this.#running].sort((left, right) => {
      const recency = (this.#sessionUpdatedAt.get(right) ?? 0) - (this.#sessionUpdatedAt.get(left) ?? 0)
      return recency !== 0 ? recency : (left < right ? -1 : left > right ? 1 : 0)
    })
  }

  /** @returns the normalized name of one session, or an empty string. */
  #nameOf(sessionId: string): string {
    return normalizeActivityRowName(this.#titles.get(sessionId) ?? '')
  }

  /** Build one session's delivery and start it, or drop it. */
  #emit(sessionId: string, state: {
    readonly event: LiveActivityEvent
    readonly phase: SessionActivityPhase
    readonly statusLine: string
    readonly questionHeader?: string
    readonly optionLabels?: readonly string[]
    readonly runningCount: number
    readonly dismiss?: boolean
  }): void {
    const sender = this.#options.sender
    if (sender === undefined) return
    const targets = this.#targetsFor(sessionId)
    if (targets.length === 0) return
    const now = this.#now()
    // Every delivery carries the rows, even an `end`: the list is what the card
    // says about the bridge, and a key that appears and disappears would make a
    // client choose between two pictures of the same moment (§30.2).
    const notification = buildLiveActivityNotification({ ...state, rows: this.#rowsFor(), now })
    const content = contentKeyOf(notification.aps['content-state'])
    for (const target of targets) {
      if (!this.#admits(target.activityId, content, state.event, now)) continue
      void Promise.resolve()
        .then(async () => await sender.sendLiveActivity(target, notification))
        .then((result) => { if (!result.ok) this.#failed(target, state.event, result) })
        .catch((error: unknown) => {
          this.#log(`live activity ${state.event} for ${target.activityId} failed: ${String(error)}`)
        })
    }
  }

  /**
   * @returns whether this activity may take this content now; records the send
   * when it may. Everything refused here is dropped, never queued.
   */
  #admits(activityId: string, content: string, event: LiveActivityEvent, now: number): boolean {
    if (this.#content.get(activityId) === content) return false
    if (event === 'update') {
      const interval = this.#options.intervalMs ?? LIVE_ACTIVITY_INTERVAL_MS
      const last = this.#updated.get(activityId)
      if (last !== undefined && now - last < interval) return false
    }
    this.#recent = this.#recent.filter(at => now - at < 60_000)
    if (this.#recent.length >= (this.#options.perMinute ?? LIVE_ACTIVITY_PER_MINUTE)) return false
    this.#recent.push(now)
    // Delete before set so the entry moves to the end: the map is trimmed from its
    // head, and an activity that is still in use must not be the one forgotten.
    this.#content.delete(activityId)
    this.#content.set(activityId, content)
    if (event === 'update') this.#updated.set(activityId, now)
    while (this.#content.size > LIVE_ACTIVITY_TRACKED) {
      const oldest = this.#content.keys().next()
      if (oldest.done === true) break
      this.#content.delete(oldest.value)
      this.#updated.delete(oldest.value)
    }
    return true
  }

  /** Log one failed delivery and, when the token is dead, forget it. */
  #failed(target: LiveActivityAddress, event: LiveActivityEvent, result: PushSendResult): void {
    const reason = result.reason ?? ''
    this.#log(`live activity ${event} for ${target.activityId} was not delivered (${result.status ?? '-'} ${reason === '' ? 'no reason' : reason})`)
    const dead = result.status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken'
    if (!dead) return
    const retire = this.#options.retire
    if (retire === undefined) return
    void Promise.resolve()
      .then(async () => await retire(target.activityId, target.token))
      .then((dropped) => {
        if (dropped === false) this.#log(`live activity token for ${target.activityId} was dead but matched no device row`)
      })
      .catch((error: unknown) => {
        this.#log(`live activity token for ${target.activityId} could not be dropped: ${String(error)}`)
      })
  }
}

/**
 * What identifies a content state for the dedupe.
 *
 * `asOf` is left out on purpose: it is the delivery moment, so it differs on
 * every build, and including it would make "the same content was sent" impossible
 * to observe — a card is a duplicate exactly when everything a user can read on
 * it is unchanged. The rows are part of what a user reads (§30), so a card whose
 * list of sessions reordered, was renamed or lost a row says something new.
 * @param state - the content state of one delivery.
 * @returns a stable key for the readable part of it.
 */
export function contentKeyOf(state: SessionActivityState): string {
  return JSON.stringify([
    state.phase,
    state.statusLine,
    state.questionHeader ?? null,
    state.optionLabels ?? null,
    state.runningCount,
    state.rows ?? null,
  ])
}

/** The separators a row name may not end on, and which are never part of its tail (§30.2). */
const TRAILING_SEPARATOR = /[\s·\-/\\]+$/u

/**
 * A bracket group at the very tail — a host title's `... (/Users/zcl/code/x)` suffix.
 *
 * Anchored at the end and its body may hold no bracket of its own, so a match is
 * always one whole group at the very tail rather than the front half of one.
 */
const TRAILING_GROUP = /[(（][^()（）]*[)）]$/u

/** Either path separator, however the host wrote it. */
const PATH_SEPARATOR = /[/\\]/u

/** Any closing bracket, ASCII or full-width. */
const CLOSING_BRACKET = /[)）]/u

/**
 * Whether one trailing bracket group names a path.
 *
 * The test §30.2 and the App's own `SessionActivityDisplayName` share: the group
 * is a path when its body holds a separator or holds nothing at all. `Ship (main)`
 * is part of the name and stays — one card may not show two versions of one name.
 * @param group - the whole group, brackets included.
 * @returns whether the group is the path suffix rather than part of the name.
 */
function isPathGroup(group: string): boolean {
  const body = group.slice(1, -1).trim()
  return body === '' || PATH_SEPARATOR.test(body)
}

/**
 * The text with every trailing path group taken off, brackets included.
 * @param text - one name candidate.
 * @returns the same text without a path group hanging on its tail.
 */
function stripTrailingPathGroups(text: string): string {
  let next = text
  for (;;) {
    const group = TRAILING_GROUP.exec(next)
    if (group === null || !isPathGroup(group[0])) return next
    next = next.slice(0, group.index).trim()
  }
}

/**
 * The text without a tail group the host never closed, when that group names a path.
 *
 * A title cut off before its closing bracket — `Deck (/Users/zcl/code/x` — has no
 * group at the tail to strip, and leaving it would put half a path on a lock
 * screen (§29.5). An unclosed group that holds no separator is the name, so
 * `Fix it (beta` keeps its tail.
 * @param text - one name candidate.
 * @returns the same text without a trailing unclosed path group.
 */
function cutUnclosedPathTail(text: string): string {
  const opened = Math.max(text.lastIndexOf('('), text.lastIndexOf('（'))
  if (opened < 0) return text
  const body = text.slice(opened + 1)
  if (CLOSING_BRACKET.test(body)) return text
  if (!PATH_SEPARATOR.test(body)) return text
  return text.slice(0, opened).trim()
}

/** @returns how many brackets the text leaves open. */
function bracketDepth(text: string): number {
  let depth = 0
  for (const character of text) {
    if (character === '(' || character === '（') depth += 1
    else if (character === ')' || character === '）') depth -= 1
  }
  return depth
}

/**
 * The text without a bracket left dangling on its tail.
 *
 * A closing bracket that still closes a group — `Ship (main)` — is part of the
 * name and stays. What may not end a name (§30.2) is the closing bracket of a
 * group that went away with a path, and a lone opening bracket.
 * @param text - one name candidate.
 * @returns the same text with no dangling bracket on its end.
 */
function trimDanglingBracket(text: string): string {
  let next = text
  for (;;) {
    const last = next.slice(-1)
    if (last === '(' || last === '（') {
      next = next.slice(0, -1).trim()
      continue
    }
    if ((last === ')' || last === '）') && bracketDepth(next) < 0) {
      next = next.slice(0, -1).trim()
      continue
    }
    return next
  }
}

/**
 * One pass of the tail cleanup, in the order that keeps a group whole.
 *
 * The separators come off first, because they are what hides the group at the
 * tail (`Name - (/path)`); only then the path groups; only then a bracket left on
 * its own. Peeling a bracket before its group is reached is how `Name (/path) -`
 * turns into a name still holding half a path.
 * @param text - one name candidate.
 * @returns the same text with no path group, separator or dangling bracket on its tail.
 */
function cleanRowNameTail(text: string): string {
  let next = text
  for (let round = 0; round < 8; round += 1) {
    const before = next
    next = stripTrailingPathGroups(cutUnclosedPathTail(next.replace(/\s+/gu, ' ').trim()))
    next = next.replace(TRAILING_SEPARATOR, '').trim()
    next = trimDanglingBracket(next)
    if (next === before) break
  }
  return next
}

/**
 * The host's own title, as one row may carry it (§30.2).
 *
 * The same rule the App applies to a card's own name
 * (`SessionActivityDisplayName`), so one card cannot show two versions of one
 * name. A roster title is usually the session's first message, and those end on
 * the absolute path the session ran in — `你是本仓 (/Users/zcl/code/x)` — while
 * §29.5 keeps paths off a lock screen. A trailing group whose body is a path or
 * nothing therefore comes off, brackets included, and whatever it exposed is
 * cleaned up after it (the separator in front of it, the bracket of the group
 * before it). A group that is part of the name, `Ship (main)`, stays. What is
 * left is whitespace-collapsed, trimmed of the separators and dangling brackets
 * its tail may hang on, and cut to {@link LIVE_ACTIVITY_ROW_NAME_MAX}.
 *
 * The rule lives here and nowhere else in this bridge, so there is one answer to
 * "which words of a host title may reach a lock screen".
 * @param title - the title the roster carried for that session, possibly empty.
 * @returns a name a row can carry, and an empty string when the title held nothing else.
 */
export function normalizeActivityRowName(title: string): string {
  const cleaned = cleanRowNameTail(title)
  const points = Array.from(cleaned)
  if (points.length <= LIVE_ACTIVITY_ROW_NAME_MAX) return cleaned
  // A cut can land inside a group or on a separator, so the tail is cleaned again.
  return cleanRowNameTail(points.slice(0, LIVE_ACTIVITY_ROW_NAME_MAX).join(''))
}
