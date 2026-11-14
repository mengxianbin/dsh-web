import {
  BREAKER_WINDOW_MS,
  CONTEXT_LIMIT_TOKENS,
  QUOTA_MAX,
  QUOTA_WINDOW_MS,
  RULED_CONDITIONS,
  WAVE_COOLDOWN_MS,
  WAVE_WINDOW_MS,
  classifyFailure,
  type ConditionLists,
  type FailureClass,
} from './config.ts'

/** One detection of a `turn/end` error, always emitted. */
export interface DetectRecord {
  kind: 'detect'
  at: number
  sessionId: string
  code: string
  cls: FailureClass
  /** `session.header.origin`, kept for evidence (subagent children are in scope). */
  origin?: string
}

/** Actions the revival flow can take for one error. */
export type DecisionAction = 'revive' | 'hold' | 'skip'

/** Why the flow acted the way it did; `ok` means a revival was planned. */
export type DecisionReason =
  | 'ok'
  | 'breaker-stopped'
  | 'breaker-trip'
  | 'wall-suspended'
  | 'context-limit'
  | 'wave-hold'
  | 'quota-exhausted'
  | 'wall-class'
  | 'non-revive-class'

/** One decision: revival, wave hold, or a zero-consumption skip. */
export interface DecisionRecord {
  kind: 'decision'
  at: number
  sessionId: string
  chainId: string
  action: DecisionAction
  reason: DecisionReason
  code?: string
  /** Revivals consumed on this chain before/without this decision (never rises on a skip). */
  quotaUsed?: number
  quotaLimit?: number
  /** When the nudge would fire (revive only; staggered by the global slot). */
  plannedAt?: number
  /** Wall suspension end; `null` means the provider stated no reset time. */
  resetsAt?: number | null
  /** Folded context watermark; `null` when no usage was observed yet. */
  contextTokens?: number | null
  wave?: { cause: string; count: number; releaseAt: number }
  breaker?: { revivedAt: number; diedAt: number; gapMs: number }
}

/** Evidence record for a breaker trip: revive -> die again inside the window. */
export interface BreakerRecord {
  kind: 'breaker'
  at: number
  event: 'trip'
  sessionId: string
  revivedAt: number
  diedAt: number
  gapMs: number
  code: string
}

/** Wave lifecycle: `open` when the window reaches same-cause count 2, `release` when held sessions were let go. */
export interface WaveRecord {
  kind: 'wave'
  at: number
  event: 'open' | 'release'
  cause: string
  count: number
  held?: number
  releaseAt?: number
}

/** A success (or another event) cleared per-session state worth reporting. */
export interface StateRecord {
  kind: 'state'
  at: number
  event: 'clear'
  sessionId: string
  cleared: string[]
}

/** Free-form runtime log emitted by the plugin shell (nudge outcomes). */
export interface LogRecord {
  kind: 'log'
  at: number
  event: string
  sessionId?: string
  detail?: Record<string, unknown>
}

/**
 * Synthetic decision code for a 拍板⑩ route-switch release: the revival was
 * triggered by a `model/selection` event, not by an error, so no
 * `LlmFailure.code` applies. Deliberately not a stop cause — the nudge stays
 * the plain continue — and the wave probe never sees it (a selection is not a
 * network error), so it cannot open or join a wave.
 */
export const ROUTE_SWITCH_CODE = 'route-switch'

/**
 * Synthetic decision code for a 拍板账⑪ boot-sweep revival: the trigger is the
 * activation-time orphan-turn scan, not an error, so no `LlmFailure.code`
 * applies. Deliberately not a stop cause — the nudge stays the plain continue
 * and the wave probe never sees it (a sweep is not a network error), so it
 * cannot open or join a wave. Sweep decisions write evidence lines only:
 * the ruled account's `counters` and `quota` stay untouched (零额度 = 免计数,
 * status counters/quota 零增).
 */
export const BOOT_SWEEP_CODE = 'boot-sweep'

/** Every structured line the policy or shell can produce. */
export type PolicyRecord = DetectRecord | DecisionRecord | BreakerRecord | WaveRecord | StateRecord | LogRecord

/** Bounded introspection payload behind `GET /api/session-revive/status`. */
export interface PolicySnapshot {
  counters: Record<string, number>
  skipReasons: Record<string, number>
  held: number
  suspended: number
  tripped: string[]
  waves: Array<{ cause: string; count: number; lastErrorAt: number; held: number }>
  quota: Array<{ chainId: string; used: number }>
  /** Effective condition lists this policy classifies with (拍板账⑨ status 回显生效清单). */
  conditions: { revive: string[]; wall: string[]; overridden: string[] }
}

interface SessionState {
  /** Last revival decision (shadow-simulated or live); drives the breaker. */
  lastRevivalAt?: number
  /** Breaker tripped: this session auto-revives no more until restart. */
  tripped: boolean
  /** Wall suspension end; `Infinity` = provider stated no reset, hold until a success clears it. */
  suspendedUntil?: number
  /**
   * Route whose wall error opened the suspension (拍板⑩ 墙随路由走): the
   * provider/model the failing request used, captured from the session's
   * folded request header at wall time. A later `model/selection` whose
   * provider differs releases the hold. Only meaningful while suspended;
   * an absent route (no header folded yet) fails closed — the release
   * cannot prove the provider left the walled route, so the hold stands.
   */
  wallRoute?: { provider: string; model?: string }
  /** Latest folded watermark: inputTokens + cacheReadTokens of the last usage seen. */
  contextTokens?: number
}

interface WaveState {
  /** Same-cause error timestamps, pruned to the 15 min window. */
  errors: number[]
  lastErrorAt: number
  /** Sessions held by this wave: sessionId -> heldAt, released in that order. */
  held: Map<string, number>
}

/**
 * Pure revival policy: quota window, wall suspension, circuit breaker,
 * same-cause waves with cooldown release, the 1M watermark, and the global
 * stagger slot. Time is explicit — every entry point takes the event
 * timestamp — so tests drive it with a fake clock and the host only supplies
 * `event.time` / `Date.now()`. State updates are identical in shadow and
 * live: shadow runs the full decision account and only the send is suppressed.
 * Timestamps are expected to be non-decreasing (`event.time` is one clock, so
 * production feeds them in order; tests keep the same monotonic contract).
 */
export class RevivalPolicy {
  private readonly states = new Map<string, SessionState>()
  /** Global spacing between planned revivals, from resolved config (floor 10s). */
  private readonly staggerMs: number
  /** Effective condition lists classification runs against (拍板账⑨ 配置化). */
  private readonly conditions: ConditionLists
  /** Config keys that replaced a ruled default; echoed by the status snapshot. */
  private readonly conditionOverrides: string[]
  /**
   * Rolling consumption stamps per quota chain. Chains are session-scoped:
   * the relay line that could merge two sessions into one chain was cut
   * on 2026-11-09 and is never built.
   */
  private readonly quota = new Map<string, number[]>()
  private readonly waves = new Map<string, WaveState>()
  private lastPlannedAt = 0
  private readonly counters: Record<string, number> = {
    detected: 0,
    reviveClass: 0,
    wallClass: 0,
    otherClass: 0,
    revived: 0,
    held: 0,
    skipped: 0,
    breakerTrips: 0,
    waveOpens: 0,
    waveReleases: 0,
    cleared: 0,
  }
  private readonly skipReasons: Record<string, number> = {}

  /**
   * @param options.staggerMs - global spacing between planned revivals (>= 10s floor, applied by the caller).
   * @param options.conditions - effective condition lists to classify with (defaults to the ruled design values).
   * @param options.conditionOverrides - config keys that replaced a ruled default; echoed in the status snapshot.
   */
  constructor(options: { staggerMs: number; conditions?: ConditionLists; conditionOverrides?: string[] }) {
    this.staggerMs = options.staggerMs
    this.conditions = options.conditions ?? RULED_CONDITIONS
    this.conditionOverrides = options.conditionOverrides ?? []
  }

  /**
   * Fold the latest observed context size for a session. Latest wins; called
   * from every `assistant/message` usage block (inputTokens + cacheReadTokens,
   * the same context definition as the design's statistics scan).
   */
  recordUsage(sessionId: string, contextTokens: number): void {
    this.stateOf(sessionId).contextTokens = contextTokens
  }

  /**
   * A turn ended without an error: the session demonstrably runs, so a wall
   * suspension and a wave hold both lose their subject and are cleared.
   * @param sessionId - the session that completed a turn.
   * @param at - event timestamp.
   * @returns records to log (only when something was actually cleared).
   */
  onSuccess(sessionId: string, at: number): PolicyRecord[] {
    const state = this.states.get(sessionId)
    if (state === undefined) return []
    const cleared: string[] = []
    if (state.suspendedUntil !== undefined) {
      state.suspendedUntil = undefined
      state.wallRoute = undefined
      cleared.push('suspended')
    }
    if (this.dropHeld(sessionId)) cleared.push('held')
    if (cleared.length === 0) return []
    this.counters.cleared += 1
    return [{ kind: 'state', at, sessionId, event: 'clear', cleared }]
  }

  /**
   * One `turn/end` error. Every error is detected and classified first; only
   * revive-class codes enter the revival flow, wall-class codes record a
   * zero-consumption suspension, other codes are observed and skipped.
   */
  onError(input: {
    sessionId: string
    code: string
    providerRetryAfterMs?: number
    at: number
    origin?: string
    /** Route the failing request used (folded `request/header`); anchors the 拍板⑩ wall route. */
    route?: { provider: string; model?: string }
  }): PolicyRecord[] {
    const { sessionId, code, providerRetryAfterMs, at, origin, route } = input
    const cls = classifyFailure(code, this.conditions)
    this.counters.detected += 1
    if (cls === 'revive') this.counters.reviveClass += 1
    else if (cls === 'wall') this.counters.wallClass += 1
    else this.counters.otherClass += 1
    const records: PolicyRecord[] = [
      { kind: 'detect', at, sessionId, code, cls, ...(origin === undefined ? {} : { origin }) },
    ]
    const chainId = sessionId

    if (cls === 'wall') {
      // Design §4.2: zero consumption, no revival, suspend until resetsAt.
      // A provider-stated retry-after anchors the hold; an absent one means
      // the reset is unknown, so the hold runs until a successful turn
      // proves recovery (the 2026-11-01 "不烧重试" ruling, conservative side).
      const stated =
        providerRetryAfterMs !== undefined && Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs >= 0
          ? at + providerRetryAfterMs
          : Number.POSITIVE_INFINITY
      const state = this.stateOf(sessionId)
      state.suspendedUntil = Math.max(state.suspendedUntil ?? Number.NEGATIVE_INFINITY, stated)
      // 拍板⑩ 墙随路由走: remember which route this wall hit so a later
      // `model/selection` can prove the provider left it. A header-less wall
      // cannot have changed route (no new request ran), so a known route sticks.
      if (route !== undefined) state.wallRoute = route
      records.push(this.skipRecord(sessionId, chainId, 'wall-class', at, code, {
        resetsAt: state.suspendedUntil === Number.POSITIVE_INFINITY ? null : state.suspendedUntil,
      }))
      return records
    }

    if (cls !== 'revive') {
      records.push(this.skipRecord(sessionId, chainId, 'non-revive-class', at, code))
      return records
    }

    // Revive-class: feed the wave probe first (the probe watches the network,
    // independent of this session's own disposition), then decide.
    const wave = this.waveOf(code, at)
    if (wave.opened) {
      this.counters.waveOpens += 1
      records.push({
        kind: 'wave',
        at,
        event: 'open',
        cause: code,
        count: wave.count,
        releaseAt: at + WAVE_COOLDOWN_MS,
      })
    }
    records.push(...this.decide({ sessionId, code, at, allowWaveHold: true }))
    return records
  }

  /**
   * One durable `model/selection` event (拍板⑩ 墙随路由走): a wall-suspended
   * session whose provider left the walled route has lost the wall's subject —
   * the hold releases and the session rejoins the normal revival flow,
   * consuming exactly one quota stamp through the unchanged gates (stagger,
   * breaker, 1M watermark; a new route that also walls is capped by the
   * quota can + the 10-minute breaker). A selection that keeps the provider —
   * or a wall whose route was never observed (fail closed) — keeps the
   * zero-consumption hold (§4.2 row 2 as-is); sessions that are not
   * suspended never trigger.
   * @param input - the selection's session, provider/model, and event time.
   * @returns records to log (empty when nothing applies).
   */
  onModelSelection(input: { sessionId: string; provider: string; model?: string; at: number }): PolicyRecord[] {
    const { sessionId, provider, model, at } = input
    const state = this.states.get(sessionId)
    if (state === undefined || state.suspendedUntil === undefined) return []
    const routeLabel = (route: { provider: string; model?: string }): string =>
      route.model === undefined ? route.provider : `${route.provider}/${route.model}`
    const selection = model === undefined ? provider : `${provider}/${model}`
    const wallRoute = state.wallRoute
    if (wallRoute === undefined || wallRoute.provider === provider) {
      // Route unchanged (or the walled route never observed): the "a revival
      // would hit the same wall" premise still holds, so §4.2 row 2 stands.
      return [
        {
          kind: 'log',
          at,
          event: 'wall-route-unchanged',
          sessionId,
          detail: {
            selection,
            wallRoute: wallRoute === undefined ? 'unknown' : routeLabel(wallRoute),
            resetsAt: state.suspendedUntil === Number.POSITIVE_INFINITY ? null : state.suspendedUntil,
          },
        },
      ]
    }
    // provider 已切离撞墙路由 → 挂起解除、按可复活类照常计 1 次额度复活
    // (拍板⑩): the wall's premise died with its route, so the hold goes
    // first, any pending wave hold goes with it (the quiet period watched the
    // old route), and the unchanged gates decide the revival below.
    const resetsAt = state.suspendedUntil === Number.POSITIVE_INFINITY ? null : state.suspendedUntil
    state.suspendedUntil = undefined
    state.wallRoute = undefined
    const cleared = ['suspended']
    if (this.dropHeld(sessionId)) cleared.push('held')
    this.counters.cleared += 1
    return [
      { kind: 'state', at, sessionId, event: 'clear', cleared },
      { kind: 'log', at, event: 'wall-route-release', sessionId, detail: { from: routeLabel(wallRoute), to: selection, resetsAt } },
      ...this.decide({ sessionId, code: ROUTE_SWITCH_CODE, at, allowWaveHold: false }),
    ]
  }

  /**
   * One confirmed boot-sweep orphan (拍板⑪ 重启自动复活 + 重启这一次不算额度):
   * the same gates as a fresh revival — breaker, wall suspension, the 1M
   * watermark, and the global stagger slot — but the quota can is neither
   * read nor stamped and the ruled account's `counters` stay untouched, so a
   * sweep leaves the status snapshot byte-identical (status counters/quota
   * 零增); the decision line itself is the evidence. The breaker still arms
   * (`lastRevivalAt`) so a sweep revival that dies again inside 10 minutes
   * trips through the normal error path as usual. The wave probe stays out:
   * the sweep feeds it no errors and `boot-sweep` cannot open or join a wave
   * (same isolation as {@link ROUTE_SWITCH_CODE}), which keeps 拍板⑪'s
   * "免计数不免四闸" — breaker / stagger / watermark / probe all still bound
   * this revival, the probe simply has nothing to hold it on.
   * @param input - the confirmed orphan's session and the decision time.
   * @returns records to log (always at least one decision).
   */
  onBootSweep(input: { sessionId: string; at: number }): PolicyRecord[] {
    const { sessionId, at } = input
    const records: PolicyRecord[] = []
    const state = this.stateOf(sessionId)
    const chainId = sessionId

    if (state.tripped) {
      records.push(this.sweepSkip(sessionId, chainId, 'breaker-stopped', at))
      return records
    }

    // Breaker: a sweep re-entry inside 10 minutes of the last revival would
    // double-drive the session — trip instead (evidence line, no counter: the
    // sweep keeps out of the ruled account).
    if (state.lastRevivalAt !== undefined && at - state.lastRevivalAt < BREAKER_WINDOW_MS) {
      state.tripped = true
      this.dropHeld(sessionId)
      const revivedAt = state.lastRevivalAt
      const gapMs = at - revivedAt
      records.push({ kind: 'breaker', at, event: 'trip', sessionId, revivedAt, diedAt: at, gapMs, code: BOOT_SWEEP_CODE })
      records.push(
        this.sweepSkip(sessionId, chainId, 'breaker-trip', at, {
          breaker: { revivedAt, diedAt: at, gapMs },
        }),
      )
      return records
    }

    // Wall suspension: an unexpired hold keeps its subject (§4.2 row 2); an
    // expired one falls through exactly like the error path does.
    if (state.suspendedUntil !== undefined) {
      if (at < state.suspendedUntil) {
        records.push(
          this.sweepSkip(sessionId, chainId, 'wall-suspended', at, {
            resetsAt: state.suspendedUntil === Number.POSITIVE_INFINITY ? null : state.suspendedUntil,
          }),
        )
        return records
      }
      state.suspendedUntil = undefined
      state.wallRoute = undefined
    }

    // 1M watermark: the sweep folds the orphan's last observed usage before
    // deciding, so an oversized orphan parks with evidence instead of waking
    // into a context overflow (an unknown watermark adds no boundary).
    if (state.contextTokens !== undefined && state.contextTokens >= CONTEXT_LIMIT_TOKENS) {
      records.push(this.sweepSkip(sessionId, chainId, 'context-limit', at, { contextTokens: state.contextTokens }))
      return records
    }

    // Revival: arm the breaker and take the global stagger slot, but never
    // touch the quota can or the counters (零额度).
    state.lastRevivalAt = at
    const plannedAt = Math.max(at, this.lastPlannedAt + this.staggerMs)
    this.lastPlannedAt = plannedAt
    records.push({
      kind: 'decision',
      at,
      sessionId,
      chainId,
      action: 'revive',
      reason: 'ok',
      code: BOOT_SWEEP_CODE,
      quotaUsed: this.usedOf(chainId, at),
      quotaLimit: QUOTA_MAX,
      plannedAt,
      contextTokens: state.contextTokens ?? null,
    })
    return records
  }

  /**
   * Absolute ms timestamp of the earliest wave whose held set still waits for
   * cooldown, or null when nothing is pending. The host arms one timer to it.
   */
  nextWakeAt(): number | null {
    let earliest: number | null = null
    for (const wave of this.waves.values()) {
      if (wave.held.size === 0) continue
      const deadline = wave.lastErrorAt + WAVE_COOLDOWN_MS
      if (earliest === null || deadline < earliest) earliest = deadline
    }
    return earliest
  }

  /**
   * Release every wave whose cooldown has elapsed. Released sessions re-run
   * the full decision checks at release time (breaker, suspension, watermark,
   * quota) but never re-enter a hold — the quiet period is what released them.
   * @param at - the release timestamp (host passes the timer's firing time).
   */
  releaseDue(at: number): PolicyRecord[] {
    const records: PolicyRecord[] = []
    for (const [cause, wave] of [...this.waves.entries()]) {
      if (wave.held.size === 0) continue
      if (at - wave.lastErrorAt < WAVE_COOLDOWN_MS) continue
      const entries = [...wave.held.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      wave.held.clear()
      this.counters.waveReleases += 1
      records.push({ kind: 'wave', at, event: 'release', cause, count: wave.errors.length, held: entries.length })
      for (const [sessionId] of entries) {
        records.push(...this.decide({ sessionId, code: cause, at, allowWaveHold: false }))
      }
    }
    return records
  }

  /** Drop everything held or remembered for a session that is gone. */
  forget(sessionId: string): void {
    this.states.delete(sessionId)
    // Chains are session-scoped, so the can dies with the session.
    this.quota.delete(sessionId)
    for (const wave of this.waves.values()) wave.held.delete(sessionId)
  }

  /** Bounded introspection for the status endpoint; `at` prunes the quota windows. */
  snapshot(at: number): PolicySnapshot {
    let held = 0
    const waves: PolicySnapshot['waves'] = []
    for (const [cause, wave] of this.waves) {
      held += wave.held.size
      if (wave.errors.length >= 2 || wave.held.size > 0) {
        waves.push({ cause, count: wave.errors.length, lastErrorAt: wave.lastErrorAt, held: wave.held.size })
      }
    }
    const quota: PolicySnapshot['quota'] = []
    for (const [chainId, stamps] of this.quota) {
      quota.push({ chainId, used: stamps.filter((t) => at - t < QUOTA_WINDOW_MS).length })
      if (quota.length >= 50) break
    }
    let suspended = 0
    const tripped: string[] = []
    for (const [sessionId, state] of this.states) {
      if (state.suspendedUntil !== undefined) suspended += 1
      if (state.tripped && tripped.length < 50) tripped.push(sessionId)
    }
    return {
      counters: { ...this.counters },
      skipReasons: { ...this.skipReasons },
      held,
      suspended,
      tripped,
      waves: waves.slice(0, 20),
      quota,
      conditions: {
        revive: [...this.conditions.revive],
        wall: [...this.conditions.wall],
        overridden: [...this.conditionOverrides],
      },
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private stateOf(sessionId: string): SessionState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = { tripped: false }
      this.states.set(sessionId, state)
    }
    return state
  }

  private waveOf(code: string, at: number): { count: number; opened: boolean } {
    let wave = this.waves.get(code)
    if (wave === undefined) {
      wave = { errors: [], lastErrorAt: at, held: new Map() }
      this.waves.set(code, wave)
    }
    wave.errors = wave.errors.filter((t) => at - t < WAVE_WINDOW_MS)
    wave.errors.push(at)
    wave.lastErrorAt = at
    const count = wave.errors.length
    return { count, opened: count === 2 }
  }

  private dropHeld(sessionId: string): boolean {
    for (const wave of this.waves.values()) {
      if (wave.held.delete(sessionId)) return true
    }
    return false
  }

  private usedOf(chainId: string, at: number): number {
    const stamps = this.quota.get(chainId)
    if (stamps === undefined) return 0
    const kept = stamps.filter((t) => at - t < QUOTA_WINDOW_MS)
    if (kept.length !== stamps.length) this.quota.set(chainId, kept)
    return kept.length
  }

  private skipRecord(
    sessionId: string,
    chainId: string,
    reason: DecisionReason,
    at: number,
    code?: string,
    extra?: Partial<DecisionRecord>,
  ): DecisionRecord {
    this.counters.skipped += 1
    this.skipReasons[reason] = (this.skipReasons[reason] ?? 0) + 1
    return {
      kind: 'decision',
      at,
      sessionId,
      chainId,
      action: 'skip',
      reason,
      quotaUsed: this.usedOf(chainId, at),
      quotaLimit: QUOTA_MAX,
      ...(code === undefined ? {} : { code }),
      ...extra,
    }
  }

  /**
   * A zero-consumption skip for the boot-sweep path: the same evidence shape
   * as {@link RevivalPolicy.skipRecord} minus every account mutation — the
   * sweep's parks leave `counters` and `skipReasons` byte-identical too
   * (拍板⑪ status 零增), because the sweep's own decision line already names
   * the reason and the `boot-sweep` code.
   */
  private sweepSkip(
    sessionId: string,
    chainId: string,
    reason: DecisionReason,
    at: number,
    extra?: Partial<DecisionRecord>,
  ): DecisionRecord {
    return {
      kind: 'decision',
      at,
      sessionId,
      chainId,
      action: 'skip',
      reason,
      code: BOOT_SWEEP_CODE,
      quotaUsed: this.usedOf(chainId, at),
      quotaLimit: QUOTA_MAX,
      ...extra,
    }
  }

  /**
   * The revival decision path shared by fresh errors and wave releases:
   * breaker -> suspension -> watermark -> (hold) -> quota -> revive. The
   * wave window itself was already fed by the caller; `allowWaveHold:false`
   * is the release leg, which must not put a session back on hold.
   */
  private decide(input: {
    sessionId: string
    code: string
    at: number
    allowWaveHold: boolean
  }): PolicyRecord[] {
    const { sessionId, code, at, allowWaveHold } = input
    const records: PolicyRecord[] = []
    const state = this.stateOf(sessionId)
    const chainId = sessionId

    if (state.tripped) {
      records.push(this.skipRecord(sessionId, chainId, 'breaker-stopped', at, code))
      return records
    }

    // Breaker: died again within 10 min of a revival -> suspected loop,
    // stop this session for good and leave evidence for the morning report.
    if (state.lastRevivalAt !== undefined && at - state.lastRevivalAt < BREAKER_WINDOW_MS) {
      state.tripped = true
      this.dropHeld(sessionId)
      const revivedAt = state.lastRevivalAt
      const gapMs = at - revivedAt
      this.counters.breakerTrips += 1
      records.push({ kind: 'breaker', at, event: 'trip', sessionId, revivedAt, diedAt: at, gapMs, code })
      records.push(
        this.skipRecord(sessionId, chainId, 'breaker-trip', at, code, {
          breaker: { revivedAt, diedAt: at, gapMs },
        }),
      )
      return records
    }

    // Wall suspension: held until resetsAt (or until a success clears an
    // unknown reset); an expired hold falls through to the later checks.
    if (state.suspendedUntil !== undefined) {
      if (at < state.suspendedUntil) {
        records.push(
          this.skipRecord(sessionId, chainId, 'wall-suspended', at, code, {
            resetsAt: state.suspendedUntil === Number.POSITIVE_INFINITY ? null : state.suspendedUntil,
          }),
        )
        return records
      }
      state.suspendedUntil = undefined
      state.wallRoute = undefined
    }

    // 1M watermark: park with evidence; an unknown watermark (no usage seen
    // yet) does not add the boundary (design: 读不到不加该分界).
    if (state.contextTokens !== undefined && state.contextTokens >= CONTEXT_LIMIT_TOKENS) {
      records.push(
        this.skipRecord(sessionId, chainId, 'context-limit', at, code, { contextTokens: state.contextTokens }),
      )
      return records
    }

    if (allowWaveHold) {
      const wave = this.waves.get(code)
      if (wave !== undefined && wave.errors.length >= 2) {
        if (!wave.held.has(sessionId)) {
          wave.held.set(sessionId, at)
          this.counters.held += 1
        }
        records.push({
          kind: 'decision',
          at,
          sessionId,
          chainId,
          action: 'hold',
          reason: 'wave-hold',
          code,
          quotaUsed: this.usedOf(chainId, at),
          quotaLimit: QUOTA_MAX,
          wave: { cause: code, count: wave.errors.length, releaseAt: wave.lastErrorAt + WAVE_COOLDOWN_MS },
        })
        return records
      }
    }

    const stamps = (this.quota.get(chainId) ?? []).filter((t) => at - t < QUOTA_WINDOW_MS)
    if (stamps.length >= QUOTA_MAX) {
      this.quota.set(chainId, stamps)
      records.push(
        this.skipRecord(sessionId, chainId, 'quota-exhausted', at, code, {
          quotaUsed: stamps.length,
          quotaLimit: QUOTA_MAX,
        }),
      )
      return records
    }

    stamps.push(at)
    this.quota.set(chainId, stamps)
    state.lastRevivalAt = at
    const plannedAt = Math.max(at, this.lastPlannedAt + this.staggerMs)
    this.lastPlannedAt = plannedAt
    this.counters.revived += 1
    records.push({
      kind: 'decision',
      at,
      sessionId,
      chainId,
      action: 'revive',
      reason: 'ok',
      code,
      quotaUsed: stamps.length,
      quotaLimit: QUOTA_MAX,
      plannedAt,
      contextTokens: state.contextTokens ?? null,
    })
    return records
  }
}
