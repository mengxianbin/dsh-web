/**
 * Scheduling rules for the revival v2 timers (design section five).
 *
 * The shell re-arms both timers on every state change, and that re-arm was
 * where the loop went wrong: an overdue wake deadline collapsed to
 * `setTimeout(0)` and spun the host main thread at 100 percent of one core,
 * while the probe timer was cleared and re-registered on every pass, so it
 * never fired - the route stayed unprobed, the parked sessions never released,
 * and the wake deadline stayed overdue forever. The rules live here as pure
 * functions so tests can pin them without mounting the plugin.
 */
import { PROBE_MAX_INTERVAL_MS, PROBE_MIN_INTERVAL_MS } from './v2-probe.ts'

/** An already-passed wake deadline retries at 1 Hz, never at 0 ms. */
export const WAKE_RETRY_FLOOR_MS = 1_000

/** Settings namespace reads ride this TTL so a scheduling pass stays cheap. */
export const SETTINGS_READ_TTL_MS = 5_000

/**
 * Delay before the wake timer fires: exact for a future deadline, floored for
 * one already in the past (release is blocked - on a red route for instance -
 * so polling is all the timer can usefully do).
 * @param deadline - the machine's earliest deferred deadline.
 * @param now - the arming time.
 * @returns milliseconds to wait.
 */
export function wakeDelayFor(deadline: number, now: number): number {
  const delay = deadline - now
  return delay > 0 ? delay : WAKE_RETRY_FLOOR_MS
}

/** What one scheduling pass does with the probe timer. */
export type ProbeTimerPlan =
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'arm'; delay: number }

/**
 * Decide the probe timer from the pending one and the current targets:
 * a pending timer is KEPT rather than restarted (re-arming on every state
 * change would push the randomised 60-120s cadence forward forever, and
 * clearing a due-now timer re-registers it behind the wake timer), it is
 * CLEARED when no session needs a probe, and it is replaced by an immediate
 * one only when the pending timer is not itself already immediate.
 * @param pending - the armed timer's urgency, or undefined when none is armed.
 * @param targets - what the machine wants probed right now.
 * @param random - cadence source, injectable for tests.
 * @returns the plan; the caller performs it.
 */
export function planProbeTimer(
  pending: { readonly immediate: boolean } | undefined,
  targets: readonly { readonly immediate: boolean }[],
  random: () => number = Math.random,
): ProbeTimerPlan {
  if (targets.length === 0) return pending === undefined ? { action: 'keep' } : { action: 'clear' }
  if (pending !== undefined) {
    if (pending.immediate) return { action: 'keep' }
    if (!targets.some((target) => target.immediate)) return { action: 'keep' }
    return { action: 'arm', delay: 0 }
  }
  const immediate = targets.some((target) => target.immediate)
  const delay = immediate
    ? 0
    : PROBE_MIN_INTERVAL_MS + Math.floor(random() * (PROBE_MAX_INTERVAL_MS - PROBE_MIN_INTERVAL_MS + 1))
  return { action: 'arm', delay }
}

/**
 * A reader that re-runs `read` at most once per TTL. The settings service has
 * no single-namespace read, so without this every scheduling pass pays a full
 * profile-directory scan; a `undefined` result is cached too, so a transient
 * settings hiccup parks the route for one TTL instead of re-scanning on every
 * pass.
 * @param ttlMs - how long a result stays fresh.
 * @param read - the underlying read (a full `describe()` in production).
 * @param now - clock source, injectable for tests.
 * @returns the cached reader.
 */
export function makeTtlReader<T>(ttlMs: number, read: () => T, now: () => number = Date.now): () => T {
  let cache: { at: number; value: T } | undefined
  return () => {
    const at = now()
    if (cache === undefined || at - cache.at >= ttlMs) cache = { at, value: read() }
    return cache.value
  }
}
