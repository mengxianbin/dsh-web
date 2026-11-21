/**
 * Per-connection delta windows: what a client that already holds a copy of a
 * whole set is sent instead of the whole set again.
 *
 * The difference is computed here, in the bridge, because the bridge is the
 * only place that holds what the host said last — the host itself is asked for
 * its complete answer every time and never learns that a client is caching one.
 * That is the whole point of this module: the saving is bytes on the wire
 * between the bridge and the phone, not a change to any host API.
 *
 * Three rules live in this file and nowhere else, so the roster and the board
 * cannot disagree about them:
 *
 * - a delta is only diffed against the exact set this window last sent, and
 *   only for a token this window itself issued; anything else answers a reset,
 *   because a wrong base is a wrong answer;
 * - a change is a change of the serialised row, not of a timestamp — the host's
 *   `updatedAt` is not a change signal for every field, and a row whose body is
 *   byte-identical has not changed;
 * - a delta that is not clearly smaller than the reset body is not worth
 *   sending: past {@link DELTA_CHANGED_RATIO} of the rows, the answer is a reset.
 * @module dsh-remote-bridge/core/delta
 */

import { randomBytes } from 'node:crypto'

/** Largest roster one connection's delta window retains. */
export const ROSTER_DELTA_MAX_ROWS = 5000
/** Largest board one connection's delta window retains. */
export const BOARD_DELTA_MAX_ROWS = 2000

/**
 * Share of the current set that may change before a reset is the cheaper
 * answer. Bytes, not cleverness: past this point the delta carries most of the
 * body already and the extra keys only make it bigger.
 */
export const DELTA_CHANGED_RATIO = 0.6

/**
 * Identity of this bridge process, minted once at load.
 *
 * Part of every token, so a token minted by an earlier boot can never be
 * replayed into a delta against a set that boot never sent. It is not a secret
 * on its own — the per-window secret beside it is what makes a token
 * unguessable, and the exact comparison below is what actually decides.
 */
const BOOT_ID = randomBytes(8).toString('hex')

/** The one row field every set this module diffs is keyed by. */
export interface DeltaRow {
  readonly id: string
}

/** One window's answer, before a method wraps it in its own wire shape. */
export type DeltaAnswer<T> =
  | {
    readonly mode: 'reset'
    /** Opaque token to send back as `since`; `""` when nothing was retained. */
    readonly token: string
    /** The whole set, exactly as the method always published it. */
    readonly rows: readonly T[]
  }
  | {
    readonly mode: 'delta'
    readonly token: string
    /** Every row that is new or whose body differs from the last one sent. */
    readonly changed: readonly T[]
    /** Every id this window sent before and the host no longer names. */
    readonly removed: readonly string[]
  }

/** Cap on the set one window may retain. */
export interface DeltaLimits {
  readonly maxRows: number
}

/**
 * One connection's view of one set: the rows it last sent, and the token that
 * set was announced under.
 *
 * A window is created lazily by whoever needs it and lives exactly as long as
 * the connection that owns it (see {@link RemoteBridgeDeltas}), so two
 * connections never share a base and a dropped connection leaks nothing.
 */
export class DeltaWindow<T extends DeltaRow> {
  readonly #maxRows: number
  /**
   * This window's own secret: what makes one connection's token useless to
   * another, and what a client cannot derive from a token it was given.
   */
  readonly #secret = randomBytes(8).toString('hex')
  readonly #sent = new Map<string, string>()
  #revision = 0
  #token: string | undefined

  constructor(limits: DeltaLimits) {
    this.#maxRows = limits.maxRows
  }

  /**
   * Answer one call over the current full set.
   * @param rows - the complete set, exactly as the host answered it this time.
   * @param since - the opaque token the client sent, if it sent one.
   * @returns a reset carrying every row, or a delta against the last set sent.
   */
  answer(rows: readonly T[], since: string | undefined): DeltaAnswer<T> {
    const current = new Map<string, string>()
    for (const row of rows) current.set(row.id, JSON.stringify(row))
    // A set past the cap is not retained at all: one connection must never pin
    // an unbounded copy of the host's state, and a reset is answered instead of
    // pretending a base exists.
    if (current.size > this.#maxRows) return this.#forget(rows)
    // The only base a delta may be diffed against is the set this window sent
    // last, named by the token it handed out with it. A token from another
    // connection, another boot, an older answer of this one, or garbage is not
    // that base.
    if (since === undefined || this.#token === undefined || since !== this.#token) {
      return this.#reset(rows, current)
    }
    const changed: T[] = []
    for (const row of rows) if (this.#sent.get(row.id) !== current.get(row.id)) changed.push(row)
    const removed: string[] = []
    for (const id of this.#sent.keys()) if (!current.has(id)) removed.push(id)
    // Removals are not counted against the ratio: a removal costs one id on the
    // wire, not a row, so a wave of deletions is exactly what a delta is for.
    if (changed.length > DELTA_CHANGED_RATIO * rows.length) return this.#reset(rows, current)
    this.#sent.clear()
    for (const [id, body] of current) this.#sent.set(id, body)
    return { mode: 'delta', token: this.#nextToken(), changed, removed }
  }

  /**
   * Answer the whole set and keep it as the next base.
   * @param rows - the complete set.
   * @param current - the set, serialised, to retain.
   */
  #reset(rows: readonly T[], current: Map<string, string>): DeltaAnswer<T> {
    this.#sent.clear()
    for (const [id, body] of current) this.#sent.set(id, body)
    return { mode: 'reset', token: this.#nextToken(), rows }
  }

  /**
   * Answer the whole set and retain nothing.
   *
   * The empty token says so: this answer cannot be continued from, because
   * there is no copy of it here to diff against. A client that sends it back is
   * answered a reset, which is the truth rather than a wrong delta.
   * @param rows - the complete set.
   */
  #forget(rows: readonly T[]): DeltaAnswer<T> {
    this.#sent.clear()
    this.#token = undefined
    this.#revision += 1
    return { mode: 'reset', token: '', rows }
  }

  /** @returns the token for the set just retained, bumping the window's revision. */
  #nextToken(): string {
    this.#revision += 1
    this.#token = `d1.${BOOT_ID}.${this.#secret}.${this.#revision}`
    return this.#token
  }
}

/**
 * The delta windows one connection owns, by the name its owner keys them with.
 *
 * Held on the connection, so the state is released exactly when the connection
 * is: there is no second registry to expire, and no connection's window can be
 * read by another.
 */
export class RemoteBridgeDeltas {
  readonly #windows = new Map<string, DeltaWindow<DeltaRow>>()

  /**
   * @param key - the window's name within this connection; one set, one key.
   * @param limits - the cap this window retains.
   * @returns the window, created on first use.
   */
  window<T extends DeltaRow>(key: string, limits: DeltaLimits): DeltaWindow<T> {
    const known = this.#windows.get(key)
    if (known !== undefined) return known as DeltaWindow<T>
    const created = new DeltaWindow<T>(limits)
    this.#windows.set(key, created as unknown as DeltaWindow<DeltaRow>)
    return created
  }

  /**
   * @param key - one window's name.
   *
   * Drops that window and the set it retained, so its token names nothing and
   * the next call answers a reset. Used when a connection stops being served
   * increments at all, which must cost it no memory either.
   */
  drop(key: string): void {
    this.#windows.delete(key)
  }

  /** Drop every window: called when the owning connection is torn down. */
  clear(): void {
    this.#windows.clear()
  }
}
