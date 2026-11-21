/**
 * The bridge's claims on `ui.request` (§35): which self-contained pages a phone
 * or the desktop may show, and the one path a user's action travels back into the
 * tool call that presented it.
 *
 * A card belongs to exactly one tool call and ends at the user's FIRST action:
 * the first `ui.event` settles it and becomes that call's result, so a card that
 * should keep taking actions is a second presentation rather than a second event
 * (§35.3, §35.8). Every claim is one record keyed by the call id published on the
 * wire, so an event that arrives late still lands, and one naming a call id this
 * bridge never claimed is refused instead of being handed to a tool that is not
 * waiting for it.
 *
 * The bridge invents no deadline: the tool schema declares no `timeout`, so a
 * card carries no `expiresAt` and stays open until the user acts, the agent's own
 * turn is cancelled, or the last paired device has been gone long enough for the
 * hub's grace window (§35.5). It also fabricates no event: a card nobody answered
 * is released as a refusal, never as a decision the operator did not make.
 *
 * Both caps are enforced on this side rather than the client's (§35.2, §35.3): a
 * client that refused an oversized page would leave the agent waiting for a card
 * that never comes, so the call is refused as `invalid-args` before any frame is
 * written.
 * @module dsh-remote-bridge/core/ui
 */

import { CODE_UI_SETTLED, CODE_UI_UNKNOWN } from './protocol.ts'

/** Upper bound of one card's document, in UTF-8 bytes (§35.2). */
export const UI_HTML_MAX_BYTES = 262_144

/** Upper bound of one `ui.event` payload, in UTF-8 bytes (§35.3). */
export const UI_PAYLOAD_MAX_BYTES = 8192

/**
 * How many settled call ids this bridge remembers, so a repeated tap is answered
 * `ui-settled` instead of `ui-unknown` (§35.3).
 *
 * The promise is already settled and the card is already gone by then; the only
 * reason to remember the id is that a client which tapped twice must be able to
 * tell "already done" from "never mine". A phone holds no more live cards than it
 * rendered, so the bound costs one short string per presentation and never grows
 * with the process's uptime.
 */
export const UI_SETTLED_MEMORY = 256

/** Whether a card still holds the tool call, or is only a notice now. */
export type UiState = 'open' | 'settled'

/** One lossless JSON value, as the wire carries it inside an event payload. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** The action a user took inside one card, in the presenter's own closed set. */
export interface UiEvent {
  readonly type: string
  readonly payload?: JsonValue
}

/**
 * The `ui.request` payload for one claim, and the `payload` of every `ui.list`
 * entry.
 *
 * One function for both so the card a client was handed and the card it reads back
 * out of a list cannot drift apart: an absent `title` or `height` is an absent key
 * rather than an empty or null one, exactly as §35.2 froze it. `expiresAt` is never
 * written: a presentation whose tool schema declares no `timeout` has no deadline
 * to publish, and a published one would be a promise this bridge does not keep.
 * @param state - whether the card still holds the tool call.
 * @param card - the claim being published.
 * @returns the frozen payload body.
 */
export function uiPayload(state: UiState, card: UiCardView): UiRequestPayload {
  return {
    sessionId: card.sessionId,
    callId: card.callId,
    state,
    ...(card.title === undefined ? {} : { title: card.title }),
    html: card.html,
    ...(card.height === undefined ? {} : { height: card.height }),
  }
}

/**
 * The identity a client knows one card by (`"<sessionId>/<callId>"`, §35.4).
 *
 * The same pair a `ui.list` row carries, so the card a tool presented and the row
 * a client reconciles it against are compared as one name instead of two fields
 * that could be recombined differently on each side.
 * @param sessionId - the session whose agent presented the card.
 * @param callId - the tool call id it is held under.
 * @returns the card key.
 */
export function uiKey(sessionId: string, callId: string): string {
  return sessionId + '/' + callId
}

/** @returns the UTF-8 byte length of one string. */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** @returns whether one card document is within {@link UI_HTML_MAX_BYTES}. */
export function uiHtmlFits(html: string): boolean {
  return utf8Bytes(html) <= UI_HTML_MAX_BYTES
}

/**
 * Read one `ui.event` body out of a decoded frame.
 *
 * The event's `type` is the presenter's own closed set: this bridge carries it and
 * never interprets the value, so the only shape it enforces is the one the frame
 * declares (§35.3). An absent and an explicit `null` payload are different
 * things — the payload key is kept exactly when the client sent one.
 * @param raw - the `event` field as it crossed the wire.
 * @returns the event, or undefined when the frame is not one.
 */
export function uiEventOf(raw: unknown): UiEvent | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const type = record.type
  if (typeof type !== 'string' || type === '') return undefined
  return record.payload === undefined ? { type } : { type, payload: record.payload as JsonValue }
}

/** @returns whether one event's payload is within {@link UI_PAYLOAD_MAX_BYTES}. */
export function uiEventFits(event: UiEvent): boolean {
  return event.payload === undefined || utf8Bytes(JSON.stringify(event.payload)) <= UI_PAYLOAD_MAX_BYTES
}

/** One card this bridge still holds, as `ui.list` publishes it (§35.4). */
export interface ListedCard {
  /** {@link uiKey}: the identity the client holds it under. */
  readonly key: string
  readonly sessionId: string
  /** `open` or `settled`; a settled card is not held and never listed. */
  readonly state: UiState
  /** The `ui.request` payload, byte for byte the shape §35.2 froze. */
  readonly payload: UiRequestPayload
}

/**
 * The body of one `ui.list` answer.
 *
 * `complete` is what a client is allowed to act on: only a COMPLETE list may
 * retire a card it does not carry (§35.5, §24.3), so a bridge that could answer
 * only part of the set must say `false` rather than let the difference read as
 * "the card is over".
 */
export interface UiListPayload {
  readonly cards: readonly ListedCard[]
  readonly complete: boolean
}

/** `ui.request`'s payload, as §35.2 froze it. */
export interface UiRequestPayload {
  readonly sessionId: string
  readonly callId: string
  readonly state: UiState
  /** One header line; absent when the presenter named none. */
  readonly title?: string
  /** A whole self-contained document, `<!doctype html>` first, within {@link UI_HTML_MAX_BYTES}. */
  readonly html: string
  /** The presenter's suggested initial height in points; the client still measures. */
  readonly height?: number
  /**
   * Epoch milliseconds of this bridge's own deadline for the card; absent, always,
   * for a presentation whose tool schema declares no `timeout` (§35.2).
   */
  readonly expiresAt?: number
}

/** The identity and content of one claim, as the hub publishes it. */
export interface UiCardView {
  readonly sessionId: string
  readonly callId: string
  readonly html: string
  readonly title?: string
  readonly height?: number
}

/** Why one presentation ended without a user action, in the wire's own vocabulary. */
export type UiRefusalReason = 'unavailable' | 'invalid-args' | 'timeout' | 'cancelled'

/** What one presentation ended as: the user's action, or the refusal to wait for one. */
export type UiPresentOutcome =
  | { readonly ok: true; readonly type: string; readonly payload?: JsonValue }
  | { readonly ok: false; readonly reason: UiRefusalReason }

/** What one `ui.event` produced: acknowledgement, or the refusal to accept it. */
export type UiEventReply = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly msg: string }

export interface OpenCardInput {
  readonly sessionId: string
  /** The id published on the wire, which is the host's own `ToolCallId`. */
  readonly callId: string
  readonly html: string
  readonly title?: string
  readonly height?: number
  /** The agent's own cancellation lifetime for this call. */
  readonly signal?: AbortSignal
  /**
   * Called when the card leaves this bridge — the user's event, the grace window,
   * a cancelled turn, the bridge unloading. The client still holds a card for it
   * and has to be told, or it keeps showing a page whose actions go nowhere.
   */
  readonly onSettled?: (card: UiCardView) => void
}

/** The presentation one `ui_present` call is waiting on, as the hub publishes it. */
export interface ClaimedCard extends UiCardView {
  /** The user's action, or the refusal that ended the card. Never rejects. */
  readonly outcome: Promise<UiPresentOutcome>
}

/** One live claim, with every path that ends it. */
interface Claim {
  readonly sessionId: string
  readonly callId: string
  readonly html: string
  readonly title: string | undefined
  readonly height: number | undefined
  readonly finish: (outcome: UiPresentOutcome) => void
  readonly detach: () => void
  /** Tells the client its card is over; set from the input's `onSettled`. */
  readonly notifySettled: () => void
}

/**
 * The publishable view of one claim.
 * @param record - the live claim.
 * @returns the card's fields as the hub publishes them.
 */
function viewOf(record: Claim): UiCardView {
  return {
    sessionId: record.sessionId,
    callId: record.callId,
    html: record.html,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.height === undefined ? {} : { height: record.height }),
  }
}

/**
 * Pending cards of one bridge process.
 *
 * One record per call id published on the wire and one settle for every path
 * (the user's event, the agent's cancellation, the grace window, bridge unload),
 * so a card can never be settled twice and a released claim leaves no abort
 * listener behind.
 */
export class UiCards {
  readonly #cards = new Map<string, Claim>()
  /** Call ids a user's own event settled, oldest first, bounded by {@link UI_SETTLED_MEMORY}. */
  readonly #settled = new Set<string>()

  /** @returns how many cards this bridge currently holds. */
  get size(): number {
    return this.#cards.size
  }

  /**
   * @param callId - one wire call id.
   * @returns `open` while it holds a tool call, `settled` once a user's event
   * settled it, and undefined when this bridge never claimed it — which is how a
   * listener tells `ui-settled` from `ui-unknown` (§35.3).
   */
  stateOf(callId: string): UiState | undefined {
    if (this.#cards.has(callId)) return 'open'
    return this.#settled.has(callId) ? 'settled' : undefined
  }

  /**
   * Claim one card.
   * @param input - session identity, wire call id, the page, and the host's lifetime.
   * @returns the claim the hub publishes, or undefined when there is nothing to publish.
   */
  open(input: OpenCardInput): ClaimedCard | undefined {
    // A call whose own lifetime already ended has no card to publish: announcing one
    // would hand the client a page that can never be settled.
    if (input.signal?.aborted === true) return undefined
    if (this.#cards.has(input.callId) || this.#settled.has(input.callId)) return undefined
    let finish: (outcome: UiPresentOutcome) => void = () => undefined
    const outcome = new Promise<UiPresentOutcome>((resolve) => { finish = resolve })
    const signal = input.signal
    const onAbort = (): void => { this.#cancel(input.callId) }
    const record: Claim = {
      sessionId: input.sessionId,
      callId: input.callId,
      html: input.html,
      title: input.title,
      height: input.height,
      finish,
      detach: (): void => { signal?.removeEventListener('abort', onAbort) },
      notifySettled: (): void => { input.onSettled?.(viewOf(record)) },
    }
    this.#cards.set(input.callId, record)
    signal?.addEventListener('abort', onAbort, { once: true })
    return { ...viewOf(record), outcome }
  }

  /**
   * Settle one card from the client's first event (§35.3).
   *
   * The event is the tool call's result and its only result: the card leaves the
   * held table in the same step, so a second event finds it settled rather than
   * settling the call twice.
   * @param sessionId - the session the client believes owns the card.
   * @param callId - the wire call id the client was shown.
   * @param event - the user's action, carried verbatim.
   */
  settle(sessionId: string, callId: string, event: UiEvent): UiEventReply {
    const record = this.#cards.get(callId)
    if (record === undefined) {
      return this.#settled.has(callId)
        ? { ok: false, code: CODE_UI_SETTLED, msg: 'this card is already settled' }
        : { ok: false, code: CODE_UI_UNKNOWN, msg: 'the card is unknown or was settled elsewhere' }
    }
    if (record.sessionId !== sessionId) {
      return { ok: false, code: CODE_UI_UNKNOWN, msg: 'the card is unknown or was settled elsewhere' }
    }
    this.#cards.delete(callId)
    this.#remember(callId)
    record.detach()
    record.notifySettled()
    record.finish(event.payload === undefined ? { ok: true, type: event.type } : { ok: true, type: event.type, payload: event.payload })
    return { ok: true }
  }

  /**
   * Every card this bridge still holds, as `ui.list` publishes it (§35.4).
   *
   * The claim registry IS the answer: a card leaves it the moment the user settles
   * it, the grace window releases it, or the bridge unloads, so a card missing from
   * this list is one no action can reach any more. Only `open` is ever listed —
   * `settled` is the one-way notice, never a held row.
   * @returns one entry per held card, in claim order.
   */
  listed(): readonly ListedCard[] {
    return [...this.#cards.values()].map(record => ({
      key: uiKey(record.sessionId, record.callId),
      sessionId: record.sessionId,
      state: 'open',
      payload: uiPayload('open', viewOf(record)),
    }))
  }

  /**
   * Withdraw the named cards, ending each tool call with a refusal.
   * @param callIds - the cards to release.
   * @param reason - why; carried into the tool result as it stands.
   * @returns how many were still open and therefore released.
   */
  withdraw(callIds: readonly string[], reason: UiRefusalReason = 'timeout'): number {
    let withdrawn = 0
    for (const callId of callIds) {
      const record = this.#cards.get(callId)
      if (record === undefined) continue
      this.#cards.delete(callId)
      record.detach()
      record.notifySettled()
      record.finish({ ok: false, reason })
      withdrawn += 1
    }
    return withdrawn
  }

  /**
   * Withdraw every claim.
   * @param reason - why; carried into every released tool call.
   * @returns how many cards were still open.
   */
  withdrawAll(reason: UiRefusalReason = 'timeout'): number {
    return this.withdraw([...this.#cards.keys()], reason)
  }

  /**
   * End one card from the agent's own cancellation lifetime.
   *
   * The tool call is going away, so nothing can settle it later: the promise is
   * resolved with the refusal instead of being left pending, and the client is told
   * its page is over rather than left with a card whose actions go nowhere.
   */
  #cancel(callId: string): void {
    this.withdraw([callId], 'cancelled')
  }

  /**
   * Remember one call id a user's event settled, dropping the oldest once the bound
   * is reached — a repeated tap is answered `ui-settled` while the id is here, and
   * `ui-unknown` afterwards.
   */
  #remember(callId: string): void {
    this.#settled.add(callId)
    if (this.#settled.size <= UI_SETTLED_MEMORY) return
    const oldest = this.#settled.values().next().value
    if (oldest !== undefined) this.#settled.delete(oldest)
  }
}
