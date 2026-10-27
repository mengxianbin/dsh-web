/**
 * Per-session manual-override detection for the A-case ruling (2026-10-27:
 * 人工锁定优先). The controller remembers the `provider/model` value IT last
 * wrote per session; a durable `model/selection` event whose value matches
 * neither that ledger nor the policy's current target is a human touch — the
 * session locks and BOTH edges skip it until the selection realigns (with the
 * ledger or with the live target). Unlocking is automatic on realignment; the
 * lock itself is in-memory (a Host restart clears ledger and locks, and the
 * first events after boot rebuild both).
 *
 * Detection rides the shared `selectModel` channel via expectation + value
 * comparison because that channel carries no origin metadata (2026-10-24
 * 调研读码). Consequences, disclosed as ruling blind spots: a same-value human
 * touch is invisible (nothing diverges), as is an effort-only change (value
 * keys on provider/model only). @module dsh-auto-route/manual-lock
 */

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

/** Tracks ledger, pending expectations, and locks for one Host lifetime. */
export class ManualLockTracker {
  /** sessionId → value the controller last wrote (its claim of ownership). */
  private readonly ledger = new Map<string, string>()
  /** sessionId → value the controller is about to write (expectation window). */
  private readonly expected = new Map<string, string>()
  /** sessionId → lock entry while a human value diverges. */
  private readonly locks = new Map<string, ManualLockEntry>()

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
      if (this.locks.delete(sessionId)) return 'aligned-unlock'
      return 'aligned'
    }
    const prior = this.locks.get(sessionId)
    this.locks.set(sessionId, { sessionId, value, lockedAt: now })
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
