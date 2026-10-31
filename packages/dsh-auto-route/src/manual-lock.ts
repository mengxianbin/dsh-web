/**
 * Per-session manual-override detection for the A-case ruling (2026-10-27:
 * 人工锁定优先). The controller remembers the `provider/model` value IT last
 * wrote per session; a durable `model/selection` event whose value matches
 * neither that ledger nor the policy's current target is a human touch — the
 * session locks and BOTH edges skip it until the selection realigns (with the
 * ledger or with the live target). Unlocking is automatic on realignment.
 *
 * Since ruling A (2026-11-01 锁持久化), lock ENTRIES persist through an
 * optional `LockStore`: a Host restart no longer drops them, so the first
 * reconcile pass after boot cannot drag a deliberately parked session back.
 * The controller's own-write ledger stays in-memory — it rebuilds from the
 * first events after boot, and a lost ledger only ever makes the classifier
 * MORE cautious (a would-be `aligned` becomes a `manual-lock`, which skips
 * edges rather than switching anything).
 *
 * Detection rides the shared `selectModel` channel via expectation + value
 * comparison because that channel carries no origin metadata (2026-10-24
 * 调研读码). Consequences, disclosed as ruling blind spots: a same-value human
 * touch is invisible (nothing diverges), as is an effort-only change (value
 * keys on provider/model only). @module dsh-auto-route/manual-lock
 */

import type { LockStore } from './lock-store.ts'

/** One locked session as served on the status endpoint. */
export interface ManualLockEntry {
  readonly sessionId: string
  /** Divergent value a human selected, `provider/model`. */
  readonly value: string
  /** Wall-clock ms of the lock (or re-lock). */
  readonly lockedAt: number
}

/** Classification of one observed model/selection event. */
export type ObserveVerdict =
  /** Matched the controller's own pending write — bookkeeping only. */
  | 'auto'
  /** Already aligned (ledger or live target), never locked. */
  | 'aligned'
  /** Was locked; the touch realigned it — now managed again. */
  | 'aligned-unlock'
  /** First human touch — newly locked. */
  | 'manual-lock'
  /** Another divergent touch while already locked — lock value refreshed. */
  | 'manual-relock'

/** Tracks ledger, pending expectations, and locks; locks optionally persist across Host lifetimes. */
export class ManualLockTracker {
  /** sessionId → value the controller last wrote (its claim of ownership). */
  private readonly ledger = new Map<string, string>()
  /** sessionId → value the controller is about to write (expectation window). */
  private readonly expected = new Map<string, string>()
  /** sessionId → lock entry while a human value diverges. */
  private readonly locks = new Map<string, ManualLockEntry>()
  /** Durability for the LOCKS only; undefined = the previous in-memory behavior. */
  private readonly store: LockStore | undefined

  /**
   * @param store - optional persistence; restored locks load here, and every
   *   lock change is written back. The own-write ledger deliberately does NOT
   *   persist (rebuilds from post-boot events; a lost ledger only locks MORE).
   */
  constructor(store?: LockStore) {
    this.store = store
    if (store === undefined) return
    let restored: ManualLockEntry[] | undefined
    try {
      restored = store.load()
    } catch (error) {
      // A throwing store must never block the tracker — same fail-open rule
      // as an unreadable file: warn-through, start cold.
      restored = undefined
    }
    for (const entry of restored ?? []) this.locks.set(entry.sessionId, entry)
  }

  /** Write the lock set back; best-effort (the store swallows its own I/O errors). */
  private persist(): void {
    if (this.store === undefined) return
    try {
      this.store.save([...this.locks.values()])
    } catch {
      // LockStore implementations warn internally; an in-memory tracker must
      // never fail an observation because persistence did.
    }
  }

  /** Declare an upcoming controller write so its event is not read as human. */
  expect(sessionId: string, value: string): void {
    this.expected.set(sessionId, value)
  }

  /**
   * The controller's write succeeded. The durable event normally arrives (and
   * books the ledger through `observe`) before this call — then this is a
   * no-op, which is what keeps a raced human observation in between from
   * being overwritten. Only an unobserved write books its own value here.
   */
  confirm(sessionId: string, value: string): void {
    const pending = this.expected.get(sessionId)
    this.expected.delete(sessionId)
    if (pending === value) this.ledger.set(sessionId, value)
  }

  /** The controller's write failed — drop the expectation, ledger untouched. */
  abort(sessionId: string): void {
    this.expected.delete(sessionId)
  }

  /**
   * Classify one durable model/selection event.
   * @param sessionId - the session whose selection changed.
   * @param value - new selection as `provider/model`.
   * @param now - wall-clock ms for lock timestamps.
   * @param policyTarget - value the policy would set right now (`provider/model`).
   * @returns what happened; `manual-lock` / `manual-relock` mean edges skip it.
   */
  observe(sessionId: string, value: string, now: number, policyTarget: string): ObserveVerdict {
    const pending = this.expected.get(sessionId)
    if (pending === value) {
      // The controller's own durable event: book ownership. A pending
      // expectation is consumed ONLY by its own value — a different value
      // landing in the window is judged below while the expected event may
      // still arrive (and book itself afterwards).
      this.expected.delete(sessionId)
      this.ledger.set(sessionId, value)
      return 'auto'
    }
    if (value === policyTarget || value === this.ledger.get(sessionId)) {
      this.ledger.set(sessionId, value)
      if (this.locks.delete(sessionId)) {
        this.persist()
        return 'aligned-unlock'
      }
      return 'aligned'
    }
    const prior = this.locks.get(sessionId)
    this.locks.set(sessionId, { sessionId, value, lockedAt: now })
    this.persist()
    return prior === undefined ? 'manual-lock' : 'manual-relock'
  }

  /** Whether both edges must skip this session. */
  isLocked(sessionId: string): boolean {
    return this.locks.has(sessionId)
  }

  /** All current locks (status payload). */
  snapshot(): ManualLockEntry[] {
    return [...this.locks.values()]
  }
}
