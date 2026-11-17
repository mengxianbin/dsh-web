/**
 * The revival v2 triage state machine (design
 * session-revival-v2-alert-inbox-1116, sections three, four, five and seven):
 * one pure, event-driven class that decides whether an attempt may run, what a
 * failure's actual form was, and when the archive-relay chain fires.
 *
 * The machine replaces nothing by deletion: the ruled account (quota, breaker,
 * wave, watermark, stagger - section six's connected column) stays untouched
 * and keeps deciding as before, while this machine gates the SEND and carries
 * the new counters. Every entry point takes explicit timestamps, every side
 * effect leaves as a record, and the only external calls (probe, chain) are
 * injected ports - so the transfer table is testable row by row with no host.
 *
 * Transfer table (section three, probe-gated):
 *   probe red            -> park: no attempt, no transcript events, re-probe 60-120s, no limit
 *   attempt -> 0 token   -> cooldown 10min, zeroCostStrikes++; 3 -> stop zero-cost-3strike
 *   attempt -> spend/no progress -> archive (structured reason) -> relay depth=1
 *                           (relay recidive -> keep scene, stop relay-recidive)
 *   attempt -> spend/progress -> cooldown 10min, one progress retry;
 *                           retry spends and fails -> stop progress-retry-failed
 *   success              -> every counter clears
 * Triage follows each failure's ACTUAL form, never the attempt count: a
 * granted progress retry that dies 0-token re-joins the zero-cost channel.
 * @module dsh-session-revive/v2-machine
 */

import type { TranscriptFirstGate } from './v2-transcript.ts'
import {
  PROBE_MIN_INTERVAL_MS,
  PROBE_RED_ALARM_MS,
  type ProbeAttribution,
  type ProbeResult,
  routeKey,
} from './v2-probe.ts'

// ── Ruled constants (design section eight, judged values) ──────────────────

/** Cooldown after any failed attempt: the next try waits this long. */
export const V2_COOLDOWN_MS = 10 * 60 * 1000
/** 0-token failures allowed before stopping with the false-green attribution. */
export const ZERO_COST_STRIKE_LIMIT = 3
/** Relay generations allowed; a recidive keeps the scene and stops. */
export const RELAY_DEPTH_LIMIT = 1
/** Spend-progress failures allowed before the granted retry must pay off. */
export const PROGRESS_RETRY_LIMIT = 1

// ── Contract vocabulary (section seven, literal - readers share these) ─────

/** Actual form of one failed attempt, by spend and progress (two-level boolean). */
export type V2FailureForm = 'zero-token' | 'spend-no-progress' | 'spend-progress'

/** Terminal stop reasons; a non-null value means "keep the scene, human now". */
export type V2Stopped = 'zero-cost-3strike' | 'relay-recidive' | 'progress-retry-failed'

/** Exported probe field: green = path open, red = path dead, parked = waiting on the probe. */
export type V2ProbeField = 'green' | 'red' | 'parked'

/** One session's section-seven export shape (bilateral contract, do not widen). */
export interface ReviveV2SessionExport {
  probe: V2ProbeField
  probeRedSince: number | null
  probeRedAlarmed: boolean
  zeroCostStrikes: number
  relayDepth: number
  progressRetry: number
  stopped: V2Stopped | null
  lastFailureAt: number | null
  lastFailureForm: V2FailureForm | null
  lastFailureTokens: number
  episodeSpentTokens: number
  relaySessionId: string | null
  lastSuccessAt: number | null
}

/** The whole state export written to `<dsh-home>/session-revive-v2-state.json`. */
export interface ReviveV2StateExport {
  at: number
  sessions: Record<string, ReviveV2SessionExport>
}

// ── Records the machine emits (the shell logs and executes them) ───────────

/** Why a gate verdict refused or deferred an attempt. */
export type V2GateWhy =
  | 'ok'
  | 'probe-pending'
  | 'probe-red'
  | 'route-unknown'
  | 'cooldown'
  | 'stopped'
  | 'relay-chain'
  | 'attempt-in-flight'
  | 'halted'

/** Which channel opened this attempt (evidence for the log line). */
export type V2AttemptChannel = 'fresh' | 'zero-cost' | 'progress-retry'

/** Structured archive reason the chain writes into the archive ledger. */
export interface V2ArchiveReason {
  code: 'revive-failed-spend-no-progress'
  tokens: number
  from: number
  to: number
  form: V2FailureForm
}

export type V2Record =
  | { kind: 'v2-halt'; at: number; detail: string }
  | {
      kind: 'v2-probe'
      at: number
      provider: string
      ok: boolean
      status?: number
      ttfbMs?: number
      error?: string
      attribution?: ProbeAttribution
    }
  | { kind: 'v2-alarm'; at: number; sessionId: string; provider: string; redForMs: number }
  | {
      kind: 'v2-gate'
      at: number
      sessionId: string
      verdict: 'defer' | 'deny'
      why: Exclude<V2GateWhy, 'ok'>
      fireAt?: number
    }
  | { kind: 'v2-attempt'; at: number; sessionId: string; fireAt: number; code?: string; channel: V2AttemptChannel }
  | {
      kind: 'v2-failure'
      at: number
      sessionId: string
      form: V2FailureForm
      tokens: number
      zeroCostStrikes: number
      relayDepth: number
      progressRetry: number
      episodeSpentTokens: number
    }
  | { kind: 'v2-stop'; at: number; sessionId: string; stopped: V2Stopped; attribution?: string }
  | { kind: 'v2-archive-relay'; at: number; sessionId: string; reason: V2ArchiveReason }
  | { kind: 'v2-chain'; at: number; sessionId: string; ok: boolean; relaySessionId?: string; detail?: string }
  | { kind: 'v2-clear'; at: number; sessionId: string }

// ── Internal state ─────────────────────────────────────────────────────────

/** Spend and progress accumulated while one attempt is in flight. */
interface AttemptAccount {
  at: number
  spentTokens: number
  sawAssistant: boolean
  sawToolCall: boolean
  sawToolOk: boolean
  outputTokens: number
  refusal: boolean
}

interface PendingDecision {
  plannedAt: number
  code?: string
  channel: V2AttemptChannel
}

interface SessionState {
  route?: { provider: string; model?: string }
  // section-seven export fields
  probeRedSince: number | null
  probeRedAlarmed: boolean
  zeroCostStrikes: number
  relayDepth: number
  progressRetry: number
  stopped: V2Stopped | null
  lastFailureAt: number | null
  lastFailureForm: V2FailureForm | null
  lastFailureTokens: number
  episodeSpentTokens: number
  relaySessionId: string | null
  lastSuccessAt: number | null
  // machine internals (never exported)
  cooldownUntil: number
  nextChannel: V2AttemptChannel
  pending?: PendingDecision
  attempt?: AttemptAccount
  /** A granted progress retry: consumed by that attempt's outcome, whatever the form. */
  progressRetryAwaiting: boolean
  /** Archive-relay intent emitted or running: further attempts stay denied. */
  relaying: boolean
  episodeStartedAt: number | null
}

interface RouteState {
  ok: boolean
  at: number
  lastProbeAt: number
  redSince: number | null
}

/** One provider route the probe loop should visit. */
export interface ProbeTarget {
  provider: string
  model?: string
  baseURL?: string
  /** No cached result yet: the caller should probe immediately, not on interval. */
  immediate: boolean
}

/** Injected ports the machine needs from the host shell. */
export interface ReviveV2Options {
  /** Fail-closed first gate verdict, evaluated before any revival attempt exists. */
  gate: TranscriptFirstGate
  /** Resolve a route's provider baseURL; undefined means fail closed (park + alarm). */
  resolveBaseURL: (route: { provider: string; model?: string }) => string | undefined
  now?: () => number
}

/**
 * The triage state machine. Pure and synchronous: probe rounds and the
 * archive-relay chain run outside it, feeding results back through
 * {@link ReviveV2Machine.onProbeResult} and {@link ReviveV2Machine.onChainResult}.
 */
export class ReviveV2Machine {
  private readonly gate: TranscriptFirstGate
  private readonly resolveBaseURL: ReviveV2Options['resolveBaseURL']
  private readonly now: () => number
  private readonly sessions = new Map<string, SessionState>()
  private readonly routes = new Map<string, RouteState>()
  /** Relay generation seeds: a spawned relay carries depth 1 from its first state. */
  private readonly relaySeeds = new Map<string, number>()
  private currentRoute?: { provider: string; model?: string }

  constructor(options: ReviveV2Options) {
    this.gate = options.gate
    this.resolveBaseURL = options.resolveBaseURL
    this.now = options.now ?? (() => Date.now())
  }

  // ── inputs ───────────────────────────────────────────────────────────────

  /** Durable route switch: the fallback route for sessions without a folded header. */
  setRoute(route: { provider: string; model?: string }): void {
    this.currentRoute = route
  }

  /**
   * One `turn/end` error. First it triages the in-flight attempt by its ACTUAL
   * form (section three discipline), then it drops any deferred decision this
   * death supersedes. The gate for the NEXT attempt is answered when the ruled
   * account's revive decision arrives ({@link onReviveDecision}).
   * @returns records to log; the fail-closed halt comes back first when the gate failed.
   */
  onDeath(input: { sessionId: string; at: number; route?: { provider: string; model?: string } }): V2Record[] {
    if (!this.gate.ok) return [{ kind: 'v2-halt', at: input.at, detail: this.gate.detail }]
    const state = this.stateOf(input.sessionId)
    if (input.route !== undefined) state.route = input.route
    else if (state.route === undefined && this.currentRoute !== undefined) state.route = this.currentRoute
    const records: V2Record[] = []
    if (state.attempt !== undefined) {
      records.push(...this.triageFailure(state, input.at))
      state.attempt = undefined
    }
    // A deferred decision belongs to the death that produced it; this new one
    // supersedes it (the ruled account re-decides in the same tick).
    state.pending = undefined
    return records
  }

  /**
   * A revive decision from the ruled account: the v2 gate answers whether the
   * attempt may run - stopped and relay-chain scenes deny, a red or unprobed
   * route parks, a running cooldown defers to its deadline, otherwise the
   * attempt opens immediately (the shell sends it, live mode only).
   * @returns gate records plus at most one attempt record.
   */
  onReviveDecision(input: { sessionId: string; at: number; plannedAt: number; code?: string }): V2Record[] {
    if (!this.gate.ok) return [{ kind: 'v2-halt', at: input.at, detail: this.gate.detail }]
    const state = this.stateOf(input.sessionId)
    if (state.stopped !== null) {
      return [{ kind: 'v2-gate', at: input.at, sessionId: input.sessionId, verdict: 'deny', why: 'stopped' }]
    }
    if (state.relaying) {
      return [{ kind: 'v2-gate', at: input.at, sessionId: input.sessionId, verdict: 'deny', why: 'relay-chain' }]
    }
    if (state.attempt !== undefined) {
      return [{ kind: 'v2-gate', at: input.at, sessionId: input.sessionId, verdict: 'deny', why: 'attempt-in-flight' }]
    }
    const route = state.route ?? this.currentRoute
    if (route === undefined) {
      // No route yet: park fail-closed until a model/selection names one.
      state.pending = {
        plannedAt: input.plannedAt,
        channel: state.nextChannel,
        ...(input.code === undefined ? {} : { code: input.code }),
      }
      return [{ kind: 'v2-gate', at: input.at, sessionId: input.sessionId, verdict: 'defer', why: 'route-unknown' }]
    }
    state.route = route
    const cached = this.routes.get(routeKey(route.provider))
    if (cached === undefined || !cached.ok) {
      state.pending = {
        plannedAt: input.plannedAt,
        channel: state.nextChannel,
        ...(input.code === undefined ? {} : { code: input.code }),
      }
      if (cached !== undefined) this.markRed(state, input.at)
      return [
        {
          kind: 'v2-gate',
          at: input.at,
          sessionId: input.sessionId,
          verdict: 'defer',
          why: cached === undefined ? 'probe-pending' : 'probe-red',
        },
      ]
    }
    const fireAt = Math.max(input.plannedAt, state.cooldownUntil)
    if (input.at < fireAt) {
      state.pending = {
        plannedAt: input.plannedAt,
        channel: state.nextChannel,
        ...(input.code === undefined ? {} : { code: input.code }),
      }
      return [{ kind: 'v2-gate', at: input.at, sessionId: input.sessionId, verdict: 'defer', why: 'cooldown', fireAt }]
    }
    return this.openAttempt(state, input.at, fireAt, input.code)
  }

  /**
   * One assistant message: fold spend into the in-flight attempt and the
   * episode, and record the output-level half of the progress boolean. State
   * only - never creates an entry, so sessions outside revival keep no state.
   */
  onAssistant(
    sessionId: string,
    usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; refusal?: boolean } | undefined,
  ): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    const spent = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cacheReadTokens ?? 0)
    if (state.attempt !== undefined) {
      state.attempt.sawAssistant = true
      state.attempt.spentTokens += spent
      state.attempt.outputTokens += usage?.outputTokens ?? 0
      if (usage?.refusal === true) state.attempt.refusal = true
    }
    state.episodeSpentTokens += spent
  }

  /** One `tool/call` or successful `tool/result`: the activity halves of the progress boolean. */
  onActivity(sessionId: string, kind: 'tool-call' | 'tool-ok'): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined || state.attempt === undefined) return
    if (kind === 'tool-call') state.attempt.sawToolCall = true
    else state.attempt.sawToolOk = true
  }

  /**
   * A turn ended without an error (section three, last row): the session
   * demonstrably runs, so the whole per-session account clears. A session with
   * no entry stays without one - success creates no state, it only resets it.
   * @returns a clear record when there was anything to clear.
   */
  onSuccessTurn(sessionId: string, at: number): V2Record[] {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return []
    state.probeRedSince = null
    state.probeRedAlarmed = false
    state.zeroCostStrikes = 0
    state.relayDepth = 0
    state.progressRetry = 0
    state.stopped = null
    state.lastFailureAt = null
    state.lastFailureForm = null
    state.lastFailureTokens = 0
    state.episodeSpentTokens = 0
    state.relaySessionId = null
    state.lastSuccessAt = at
    state.cooldownUntil = 0
    state.nextChannel = 'fresh'
    state.pending = undefined
    state.attempt = undefined
    state.progressRetryAwaiting = false
    state.relaying = false
    state.episodeStartedAt = null
    return [{ kind: 'v2-clear', at, sessionId }]
  }

  /** The session is gone: drop the in-flight attempt and any deferred decision, keep the account. */
  onDisposed(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    state.attempt = undefined
    state.pending = undefined
  }

  /**
   * The shell withheld or failed the send: no attempt ran, so no outcome will
   * ever arrive - clear the in-flight marker instead of letting it deny the
   * next decision forever.
   */
  onAttemptWithheld(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    state.attempt = undefined
  }

  /**
   * One probe round result for a provider route: flips every session parked on
   * that route, releases the ones whose deadline already passed when the path
   * came back green, and raises the section-five false-red alarm when a red run
   * outlives {@link PROBE_RED_ALARM_MS}.
   * @returns probe records, possible alarm records, and released attempts.
   */
  onProbeResult(provider: string, result: ProbeResult): V2Record[] {
    const at = this.now()
    const key = routeKey(provider)
    const previous = this.routes.get(key)
    this.routes.set(key, {
      ok: result.ok,
      at,
      lastProbeAt: at,
      redSince: result.ok ? null : (previous?.redSince ?? at),
    })
    const records: V2Record[] = [
      {
        kind: 'v2-probe',
        at,
        provider,
        ok: result.ok,
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.ttfbMs === undefined ? {} : { ttfbMs: result.ttfbMs }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.attribution === undefined ? {} : { attribution: result.attribution }),
      },
    ]
    if (result.ok) {
      // Green path: clear the red markers of the sessions parked on this
      // route, then release every deferred decision whose deadline passed;
      // the others stay deferred (still green) for the wake timer.
      for (const state of this.sessions.values()) {
        if (state.pending === undefined) continue
        const route = state.route ?? this.currentRoute
        if (route === undefined || routeKey(route.provider) !== key) continue
        state.probeRedSince = null
        state.probeRedAlarmed = false
      }
      records.push(...this.releaseDue(at))
      return records
    }
    for (const [sessionId, state] of this.sessions) {
      if (state.pending === undefined) continue
      const route = state.route ?? this.currentRoute
      if (route === undefined || routeKey(route.provider) !== key) continue
      this.markRed(state, at)
      if (state.probeRedSince !== null && at - state.probeRedSince > PROBE_RED_ALARM_MS && !state.probeRedAlarmed) {
        state.probeRedAlarmed = true
        records.push({ kind: 'v2-alarm', at, sessionId, provider, redForMs: at - state.probeRedSince })
      }
    }
    return records
  }

  /**
   * The archive-relay chain reported back: success stamps the relay link and
   * seeds the new generation's depth, failure re-opens the scene so a later
   * failure may retry the chain (the intent itself already denied attempts
   * while it was in flight).
   * @returns a chain record when the session is still known.
   */
  onChainResult(input: { sessionId: string; ok: boolean; relaySessionId?: string; detail?: string }): V2Record[] {
    const at = this.now()
    const state = this.sessions.get(input.sessionId)
    if (state === undefined) return []
    if (input.ok) {
      state.relaying = true
      if (input.relaySessionId !== undefined) {
        state.relayDepth = Math.max(state.relayDepth, RELAY_DEPTH_LIMIT)
        state.relaySessionId = input.relaySessionId
        this.relaySeeds.set(input.relaySessionId, RELAY_DEPTH_LIMIT)
      }
    } else {
      state.relaying = false
    }
    return [
      {
        kind: 'v2-chain',
        at,
        sessionId: input.sessionId,
        ok: input.ok,
        ...(input.relaySessionId === undefined ? {} : { relaySessionId: input.relaySessionId }),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      },
    ]
  }

  // ── scheduling (the shell owns the timers) ───────────────────────────────

  /**
   * Routes that need a probe round now: parked sessions' providers whose
   * cached result is absent (immediate, event driven by the death) or older
   * than the 60s floor of the 60-120s cadence. Zero parked sessions returns
   * zero routes - the probe loop goes silent by construction.
   */
  routesNeedingProbe(at: number): ProbeTarget[] {
    const providers = new Map<string, { model?: string }>()
    for (const state of this.sessions.values()) {
      if (state.pending === undefined) continue
      const route = state.route ?? this.currentRoute
      if (route === undefined) continue
      const key = routeKey(route.provider)
      if (!providers.has(key)) providers.set(key, { model: route.model })
    }
    const targets: ProbeTarget[] = []
    for (const [provider, info] of providers) {
      const cached = this.routes.get(provider)
      if (cached !== undefined && at - cached.lastProbeAt < PROBE_MIN_INTERVAL_MS) continue
      const baseURL = this.resolveBaseURL({ provider, ...(info.model === undefined ? {} : { model: info.model }) })
      targets.push({ provider, ...(info.model === undefined ? {} : { model: info.model }), baseURL, immediate: cached === undefined })
    }
    return targets
  }

  /** Earliest deferred deadline (stagger plan or cooldown), or null when nothing waits. */
  nextWakeAt(): number | null {
    let earliest: number | null = null
    for (const state of this.sessions.values()) {
      if (state.pending === undefined) continue
      const deadline = Math.max(state.pending.plannedAt, state.cooldownUntil)
      if (earliest === null || deadline < earliest) earliest = deadline
    }
    return earliest
  }

  /**
   * Release every deferred decision whose deadline passed on a green path;
   * red or unprobed routes keep their sessions parked (no attempt, no
   * transcript event). Called by the shell's wake timer and after probe
   * results.
   * @param at - the firing time.
   * @returns attempt records for due, probe-green sessions.
   */
  releaseDue(at: number): V2Record[] {
    const records: V2Record[] = []
    if (!this.gate.ok) return records
    for (const state of this.sessions.values()) {
      const pending = state.pending
      if (pending === undefined) continue
      if (state.stopped !== null || state.relaying || state.attempt !== undefined) continue
      const route = state.route ?? this.currentRoute
      if (route === undefined) continue
      const cached = this.routes.get(routeKey(route.provider))
      if (cached === undefined || !cached.ok) continue
      const fireAt = Math.max(pending.plannedAt, state.cooldownUntil)
      if (at < fireAt) continue
      records.push(...this.openAttempt(state, at, fireAt, pending.code))
    }
    return records
  }

  // ── export (section seven contract) ──────────────────────────────────────

  /** The section-seven document; only sessions with real state appear. */
  stateSnapshot(): ReviveV2StateExport {
    const sessions: Record<string, ReviveV2SessionExport> = {}
    for (const [sessionId, state] of this.sessions) {
      sessions[sessionId] = {
        probe: this.probeField(state),
        probeRedSince: state.probeRedSince,
        probeRedAlarmed: state.probeRedAlarmed,
        zeroCostStrikes: state.zeroCostStrikes,
        relayDepth: state.relayDepth,
        progressRetry: state.progressRetry,
        stopped: state.stopped,
        lastFailureAt: state.lastFailureAt,
        lastFailureForm: state.lastFailureForm,
        lastFailureTokens: state.lastFailureTokens,
        episodeSpentTokens: state.episodeSpentTokens,
        relaySessionId: state.relaySessionId,
        lastSuccessAt: state.lastSuccessAt,
      }
    }
    return { at: this.now(), sessions }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * The exported probe field: `parked` while a deferred session waits on a
   * non-green path, otherwise the route's last probe result (green when the
   * session never needed one).
   */
  private probeField(state: SessionState): V2ProbeField {
    const route = state.route ?? this.currentRoute
    const cached = route === undefined ? undefined : this.routes.get(routeKey(route.provider))
    if (state.pending !== undefined && (cached === undefined || !cached.ok)) return 'parked'
    if (cached === undefined) return 'green'
    return cached.ok ? 'green' : 'red'
  }

  private markRed(state: SessionState, at: number): void {
    const route = state.route ?? this.currentRoute
    const cached = route === undefined ? undefined : this.routes.get(routeKey(route.provider))
    const redSince = cached?.redSince ?? at
    if (state.probeRedSince === null) state.probeRedSince = redSince
  }

  private openAttempt(state: SessionState, at: number, fireAt: number, code: string | undefined): V2Record[] {
    const sessionId = sessionIdOf(state, this.sessions)
    state.pending = undefined
    state.attempt = {
      at,
      spentTokens: 0,
      sawAssistant: false,
      sawToolCall: false,
      sawToolOk: false,
      outputTokens: 0,
      refusal: false,
    }
    return [
      {
        kind: 'v2-attempt',
        at,
        sessionId,
        fireAt,
        ...(code === undefined ? {} : { code }),
        channel: state.nextChannel,
      },
    ]
  }

  /**
   * One failed attempt triaged by its ACTUAL form (section three):
   * - zero token: strike plus cooldown, three strikes stop with the
   *   probe-false-green / classification-anomaly attribution;
   * - spend, no progress: the granted retry stops in place, a relay recidive
   *   keeps the scene, otherwise the archive-relay intent opens (no cooldown -
   *   the session is leaving);
   * - spend with progress: the one granted progress retry and its cooldown.
   * A form mismatch never blocks re-triage: a granted retry dying 0-token
   * re-joins the zero-cost channel (the discipline sentence).
   */
  private triageFailure(state: SessionState, at: number): V2Record[] {
    const attempt = state.attempt
    if (attempt === undefined) return []
    const form = classifyAttempt(attempt)
    const sessionId = sessionIdOf(state, this.sessions)
    state.lastFailureAt = at
    state.lastFailureForm = form
    state.lastFailureTokens = attempt.spentTokens
    if (state.episodeStartedAt === null) state.episodeStartedAt = at
    const wasAwaitingRetry = state.progressRetryAwaiting
    state.progressRetryAwaiting = false
    const tail: V2Record[] = []

    if (form === 'zero-token') {
      state.zeroCostStrikes += 1
      state.nextChannel = 'zero-cost'
      if (state.zeroCostStrikes >= ZERO_COST_STRIKE_LIMIT) {
        state.stopped = 'zero-cost-3strike'
        tail.push({
          kind: 'v2-stop',
          at,
          sessionId,
          stopped: 'zero-cost-3strike',
          attribution: 'probe-false-green-or-classification-anomaly',
        })
      } else {
        state.cooldownUntil = at + V2_COOLDOWN_MS
      }
    } else if (wasAwaitingRetry) {
      // The granted retry spent and failed: stop in place, never relay
      // (section three row four, the 1-chance clause).
      state.stopped = 'progress-retry-failed'
      tail.push({ kind: 'v2-stop', at, sessionId, stopped: 'progress-retry-failed' })
    } else if (form === 'spend-no-progress') {
      if (state.relayDepth >= RELAY_DEPTH_LIMIT) {
        state.stopped = 'relay-recidive'
        tail.push({ kind: 'v2-stop', at, sessionId, stopped: 'relay-recidive' })
      } else {
        state.relaying = true
        tail.push({
          kind: 'v2-archive-relay',
          at,
          sessionId,
          reason: {
            code: 'revive-failed-spend-no-progress',
            tokens: state.episodeSpentTokens,
            from: state.episodeStartedAt ?? at,
            to: at,
            form,
          },
        })
      }
    } else if (state.progressRetry < PROGRESS_RETRY_LIMIT) {
      // spend-progress: the one granted progress retry and its cooldown.
      state.progressRetry += 1
      state.progressRetryAwaiting = true
      state.nextChannel = 'progress-retry'
      state.cooldownUntil = at + V2_COOLDOWN_MS
    } else {
      state.stopped = 'progress-retry-failed'
      tail.push({ kind: 'v2-stop', at, sessionId, stopped: 'progress-retry-failed' })
    }

    // The failure record carries the POST-triage counters: what this failure
    // left behind, which is what the log line has to prove.
    const failure: V2Record = {
      kind: 'v2-failure',
      at,
      sessionId,
      form,
      tokens: attempt.spentTokens,
      zeroCostStrikes: state.zeroCostStrikes,
      relayDepth: state.relayDepth,
      progressRetry: state.progressRetry,
      episodeSpentTokens: state.episodeSpentTokens,
    }
    return [failure, ...tail]
  }

  /** Create-or-get one session entry; relay generations seed their depth here. */
  private stateOf(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {
        probeRedSince: null,
        probeRedAlarmed: false,
        zeroCostStrikes: 0,
        relayDepth: this.relaySeeds.get(sessionId) ?? 0,
        progressRetry: 0,
        stopped: null,
        lastFailureAt: null,
        lastFailureForm: null,
        lastFailureTokens: 0,
        episodeSpentTokens: 0,
        relaySessionId: null,
        lastSuccessAt: null,
        cooldownUntil: 0,
        nextChannel: 'fresh',
        progressRetryAwaiting: false,
        relaying: false,
        episodeStartedAt: null,
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }
}

/**
 * Classify one failed attempt (section three progress boolean): zero tokens
 * first (no spend at all), then progress = L1 activity AND L2 effectiveness.
 * L1 = the model produced an output block or asked for a tool; L2 = a tool
 * result landed without error, or output tokens arrived and were not a refusal.
 */
export function classifyAttempt(attempt: {
  spentTokens: number
  sawAssistant: boolean
  sawToolCall: boolean
  sawToolOk: boolean
  outputTokens: number
  refusal: boolean
}): V2FailureForm {
  if (attempt.spentTokens <= 0) return 'zero-token'
  const l1 = attempt.sawAssistant || attempt.sawToolCall
  const l2 = attempt.sawToolOk || (attempt.outputTokens > 0 && !attempt.refusal)
  return l1 && l2 ? 'spend-progress' : 'spend-no-progress'
}

/** Locate the session id that owns one state object (Map iteration pair). */
function sessionIdOf(state: SessionState, sessions: ReadonlyMap<string, SessionState>): string {
  for (const [id, candidate] of sessions) if (candidate === state) return id
  return 'unknown'
}
