/**
 * Bounded retry for the DSH service-activation window.
 *
 * The gateway raises its activation failures as `error.code`, never as an
 * `instanceof` identity, and two generations of code strings coexist: the
 * namespace-qualified `gateway/service-unavailable` and the bare
 * `service-unavailable`. Both are recognized, verbatim from the family's
 * task-board runner, so a provider that is merely slow to activate is retried
 * rather than reported to the phone as a broken deployment.
 * @module dsh-remote-bridge/core/gateway-errors
 */

/** Tries one unary call may consume while the target service is activating. */
export const SERVICE_UNAVAILABLE_ATTEMPTS = 5
/** Wait between those tries. */
export const SERVICE_UNAVAILABLE_BACKOFF_MS = 2_000

/** Namespace-qualified and bare spellings of the same failure. */
function codeIsOneOf(error: unknown, bare: string): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return code === bare || code === `gateway/${bare}`
}

/**
 * Whether a failure means the target service has not finished activating.
 * This is the one failure worth retrying: the same call succeeds moments later.
 */
export function isServiceUnavailable(error: unknown): boolean {
  return codeIsOneOf(error, 'service-unavailable')
}

/**
 * Whether the running gateway does not serve this endpoint at all (the cohort
 * changed under this plugin). Retrying cannot help; the caller reports it.
 */
export function isInvocationUnavailable(error: unknown): boolean {
  return codeIsOneOf(error, 'invocation-unavailable')
}

/** Whether the endpoint exists but its strict definition was withdrawn by the running gateway. */
export function isDefinitionWithdrawn(error: unknown): boolean {
  return codeIsOneOf(error, 'definition-unavailable')
}

/** Whether the call's named arguments did not match the descriptor. */
export function isArgumentsInvalid(error: unknown): boolean {
  return codeIsOneOf(error, 'arguments-invalid')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** One-line text of a failure, for a decideable reason the phone can show. */
export function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 300 ? `${message.slice(0, 297)}...` : message
}

/**
 * The failure's own code, for the response envelope. The gateway's codes cross
 * to the phone unchanged (`gateway/arguments-invalid` and friends) so the client
 * can tell "this deployment cannot" from "this build is wrong"; anything
 * without a string code is `internal`.
 */
export function errorCodeOf(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code !== '' ? code : fallback
}

/**
 * Run one unary call, retrying only the service-activation window.
 * @param run - the call to attempt.
 * @param options.attempts - total tries (default {@link SERVICE_UNAVAILABLE_ATTEMPTS}).
 * @param options.backoffMs - wait between tries (default {@link SERVICE_UNAVAILABLE_BACKOFF_MS}).
 * @returns the call's own result or failure; the failure is never swallowed.
 */
export async function withServiceUnavailableRetry<T>(
  run: () => Promise<T>,
  options: { attempts?: number; backoffMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? SERVICE_UNAVAILABLE_ATTEMPTS
  const backoffMs = options.backoffMs ?? SERVICE_UNAVAILABLE_BACKOFF_MS
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (!isServiceUnavailable(error) || attempt >= attempts) throw error
      await delay(backoffMs)
    }
  }
}
