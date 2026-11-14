/**
 * The Host's own error type: every refusal leaves this plugin carrying one of
 * the frozen codes, so the route layer maps a failure to a status without
 * parsing prose, and the browser never receives a stack trace.
 *
 * @module @linxin666/dsh-agents/core/errors
 */
import type { AgentsErrorCode } from '../protocol.ts'

/** A refusal this plugin decided, carrying its stable machine code. */
export class AgentsError extends Error {
  readonly code: AgentsErrorCode

  constructor(code: AgentsErrorCode, message: string) {
    super(message)
    this.name = 'AgentsError'
    this.code = code
  }
}

/** Whether a caught value is this plugin's typed refusal. */
export function isAgentsError(value: unknown): value is AgentsError {
  return value instanceof AgentsError
}

/**
 * HTTP status per code. Definition problems the user can fix in the panel are
 * 409 (the request was well-formed, the definition cannot run as written);
 * environment problems are 503; a lost definition is 404.
 */
const STATUS_BY_CODE: Record<AgentsErrorCode, number> = {
  'invalid-request': 400,
  'body-too-large': 413,
  'json-required': 415,
  'method-not-allowed': 405,
  forbidden: 403,
  'team-not-found': 404,
  'member-not-found': 404,
  'preset-registry-unavailable': 503,
  'preset-unknown': 409,
  'preset-unavailable': 409,
  'workspace-unavailable': 503,
  'workspace-unknown': 409,
  'model-pin-invalid': 409,
  'session-create-failed': 502,
  'session-rename-failed': 502,
  'session-pin-failed': 502,
  'session-prompt-failed': 502,
  'permission-dispatcher-unavailable': 503,
  'ledger-corrupt': 503,
  'ledger-owned': 503,
  'ledger-write-failed': 500,
  'describe-unavailable': 503,
  'describe-failed': 502,
  'internal-error': 500,
}

/** The HTTP status a refusal is served with. */
export function statusForCode(code: AgentsErrorCode): number {
  return STATUS_BY_CODE[code]
}
