/**
 * Bounded waiting for tests that observe a real socket or a fake backend.
 *
 * The test-standards gate forbids fixed-duration sleeps: a fixed sleep is
 * either too short under load (flaky) or paid in full on every run. These
 * helpers make the test say what it is waiting for instead, and turn a wait
 * that never completes into a named failure rather than a hang.
 *
 * @module tests/helpers/wait
 */

/** Default bound for one wait, in milliseconds. */
export const WAIT_TIMEOUT_MS = 2_000

/** Pause between two predicate polls, in milliseconds. */
const POLL_MS = 5

/**
 * Wait until a predicate holds.
 * @param label - what is awaited, used in the failure message.
 * @param predicate - the condition the test expresses; polled until it holds.
 * @param timeoutMs - bound for the whole wait in milliseconds.
 * @returns resolves once the predicate reports true.
 * @throws Error naming the label once the bound elapses.
 */
export async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs: number = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out after ' + timeoutMs + ' ms waiting for ' + label)
    await new Promise<void>((resolve) => { setTimeout(resolve, POLL_MS) })
  }
}

/**
 * Wait for the value an event handler reports through the settle callback.
 * @param label - what is awaited, used in the failure message.
 * @param setup - registers the listener and calls settle with the observed value.
 * @param timeoutMs - bound for the whole wait in milliseconds.
 * @returns the settled value.
 * @throws Error naming the label once the bound elapses.
 */
export function waitForSignal<T>(
  label: string,
  setup: (settle: (value: T) => void) => void,
  timeoutMs: number = WAIT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('timed out after ' + timeoutMs + ' ms waiting for ' + label))
    }, timeoutMs)
    setup((value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    })
  })
}
