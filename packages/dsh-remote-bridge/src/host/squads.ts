/**
 * The squad domain as this Host reaches it: the `dsh-agents` HTTP routes over
 * this machine's own loopback origin, with its ledger as a read-only fallback.
 *
 * The plugin's routes are the preferred source because they are the live one: a
 * definition the user just saved and a run that is still settling are both in the
 * plugin's own process state, while the ledger is the last committed write. So the
 * read is `GET /dsh-agents/api/state` and the two launches are POSTs, all
 * addressed at the origin `webServer` already serves and all carrying the `origin`
 * header the plugin's browser fence reads as its same-origin signal.
 *
 * A loopback call that cannot connect at all — nothing bound, a refused
 * connection, or a deadline — is what makes the fallback necessary: the
 * definitions are then read from the plugin's ledger, read-only, and the two run
 * commands fail closed with `squads-run-unavailable` instead of answering a run
 * that never started. An answer of any status is NOT a fallback: it is the plugin
 * speaking, and its refusal crosses with its own code.
 * @module dsh-remote-bridge/host/squads
 */

import { CODE_SQUADS_RUN_UNAVAILABLE, CODE_SQUADS_UNAVAILABLE } from '../core/protocol.ts'
import { SquadRefusal, type SquadMemberRunRequest, type SquadRunRequest, type SquadTransport } from '../core/squads.ts'
import { readSquadLedger } from './squads-ledger.ts'

/**
 * The three routes this channel drives, restated from the plugin's own
 * `DSH_AGENTS_ROUTE_PATHS`. They are spelled here rather than imported: this
 * package depends on no other plugin, so a frozen path is the only thing that can
 * cross between them.
 */
export const SQUADS_STATE_PATH = '/dsh-agents/api/state'
export const SQUADS_RUN_MEMBER_PATH = '/dsh-agents/api/run'
export const SQUADS_RUN_SQUAD_PATH = '/dsh-agents/api/squad/run'

/** Deadline behind one loopback read: the plugin answers a state read from memory. */
export const SQUADS_LOOPBACK_TIMEOUT_MS = 5_000
/**
 * Deadline behind one launch. A launch composes a session, restores it when it is
 * cold and may queue a first message, so it is allowed far longer than a read; the
 * bound exists to keep one stuck call from holding a connection open, not to time
 * the plugin's work.
 */
export const SQUADS_RUN_TIMEOUT_MS = 60_000

/** What one loopback call produced: the host's answer, or no connection at all. */
type LoopbackOutcome =
  | { readonly kind: 'answer'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'unreachable'; readonly reason: string }

/** The answer half of {@link LoopbackOutcome}. */
type LoopbackAnswer = Extract<LoopbackOutcome, { kind: 'answer' }>

/** Construction options; the origin and the ledger directory are resolved per call. */
export interface LoopbackSquadsOptions {
  /** The origin this host's own web server listens on, or undefined before it binds. */
  readonly origin: () => string | undefined
  /** The plugin-owned directory `dsh-agents` keeps its ledger in. */
  readonly ledgerDirectory: () => string
  /** Outbound call seam; the production default is the process's own fetch. */
  readonly fetch?: typeof fetch
  /** Deadline behind one read; the default is {@link SQUADS_LOOPBACK_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Deadline behind one launch; the default is {@link SQUADS_RUN_TIMEOUT_MS}. */
  readonly runTimeoutMs?: number
  readonly log: (message: string) => void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The squad domain over loopback, with the ledger as its read-only fallback. */
export class LoopbackSquads implements SquadTransport {
  readonly #options: LoopbackSquadsOptions

  constructor(options: LoopbackSquadsOptions) {
    this.#options = options
  }

  /**
   * Read the definitions and runs.
   *
   * A loopback call that connects answers for the domain, its refusals included.
   * A call that cannot connect at all falls back to the ledger, and a ledger that
   * is missing or unreadable refuses the read rather than answering an empty
   * board.
   */
  async state(): Promise<unknown> {
    const call = await this.#request('GET', SQUADS_STATE_PATH)
    if (call.kind === 'unreachable') {
      this.#options.log('squad state read fell back to the ledger: ' + call.reason)
      return await readSquadLedger(this.#options.ledgerDirectory())
    }
    return this.#bodyOf(call, SQUADS_STATE_PATH)
  }

  /**
   * Launch one member session through the plugin's own run route.
   * @param request - the squad, the member and the optional first message.
   */
  async runMember(request: SquadMemberRunRequest): Promise<unknown> {
    const call = await this.#request('POST', SQUADS_RUN_MEMBER_PATH, {
      teamId: request.squadId,
      memberId: request.memberId,
      ...(request.firstMessage === undefined ? {} : { firstMessage: request.firstMessage }),
    }, this.#options.runTimeoutMs ?? SQUADS_RUN_TIMEOUT_MS)
    if (call.kind === 'unreachable') throw this.#runUnavailable(call.reason)
    return this.#bodyOf(call, SQUADS_RUN_MEMBER_PATH)
  }

  /**
   * Launch the Lead session of one whole squad through the plugin's own squad run
   * route.
   * @param request - the squad and the optional goal its Lead is given.
   */
  async runSquad(request: SquadRunRequest): Promise<unknown> {
    const call = await this.#request('POST', SQUADS_RUN_SQUAD_PATH, {
      teamId: request.squadId,
      ...(request.goal === undefined ? {} : { goal: request.goal }),
    }, this.#options.runTimeoutMs ?? SQUADS_RUN_TIMEOUT_MS)
    if (call.kind === 'unreachable') throw this.#runUnavailable(call.reason)
    return this.#bodyOf(call, SQUADS_RUN_SQUAD_PATH)
  }

  /**
   * The refusal behind a launch this host cannot perform.
   * @param reason - why the loopback call produced no connection.
   */
  #runUnavailable(reason: string): SquadRefusal {
    return new SquadRefusal(CODE_SQUADS_RUN_UNAVAILABLE, 'this host reached no dsh-agents run route over loopback (' + reason + '), and the read-only ledger cannot launch a session')
  }

  /**
   * Read the body of an answer, or refuse with the code the plugin wrote.
   *
   * A non-2xx body carrying the plugin's `{ok:false, code, error}` crosses with
   * that code and that sentence; any other status means this host does not serve
   * the route at all, which is the one refusal this bridge names itself.
   * @param answer - the connected answer.
   * @param path - the route the answer came from, named in the refusal.
   */
  #bodyOf(answer: LoopbackAnswer, path: string): Record<string, unknown> {
    const body = record(answer.body)
    if (answer.status >= 200 && answer.status < 300) {
      if (body === undefined) {
        throw new SquadRefusal(CODE_SQUADS_UNAVAILABLE, 'the dsh-agents route ' + path + ' answered a body this bridge cannot read')
      }
      return body
    }
    if (body?.ok === false && typeof body.code === 'string') {
      const text = typeof body.error === 'string' && body.error !== '' ? body.error : 'the dsh-agents host refused ' + path
      throw new SquadRefusal(body.code, text)
    }
    throw new SquadRefusal(CODE_SQUADS_UNAVAILABLE, 'this host does not serve ' + path + ': it answered ' + String(answer.status))
  }

  /**
   * One loopback call against this host's own origin.
   * @param method - the route's own method.
   * @param path - the route's exact path.
   * @param body - the JSON body, for the two POST routes.
   * @param timeoutMs - the deadline behind this one call.
   * @returns the answer, or the reason no connection was made.
   */
  async #request(
    method: 'GET' | 'POST',
    path: string,
    body?: Readonly<Record<string, unknown>>,
    timeoutMs: number = this.#options.timeoutMs ?? SQUADS_LOOPBACK_TIMEOUT_MS,
  ): Promise<LoopbackOutcome> {
    const origin = this.#options.origin()
    if (origin === undefined) return { kind: 'unreachable', reason: 'this host has bound no web server port' }
    const call = this.#options.fetch ?? fetch
    try {
      const response = await call(origin + path, {
        method,
        // The plugin's fence admits this machine's own browser only: the socket has
        // to be loopback and a same-origin signal has to be present, and an origin
        // header naming this host is that signal.
        headers: {
          origin,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      return { kind: 'answer', status: response.status, body: parseJson(text) }
    } catch (error) {
      return { kind: 'unreachable', reason: messageOf(error) }
    }
  }
}
