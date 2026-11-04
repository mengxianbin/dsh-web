/**
 * The controller: one poll loop that fetches Go meters, asks the pure policy
 * layer for an edge, and applies it — the in-flight leg batch-switches the
 * active session set through `sessionController.selectModel`, the default leg
 * moves only the deployment default (so new sessions follow), and the shared
 * restore edge brings both home. Every edge is pre-flighted against the live
 * model catalog — an unavailable target blocks the edge and stays visible on
 * the status endpoint instead of half-switching anything. Host wiring lives
 * in `src/index.ts`; this class takes every dependency by injection so the
 * closed loop runs in tests without a Host.
 * @module dsh-auto-route/controller
 */

import type { ModelTarget, ResolvedConfig } from './config.ts'
import type { ActiveSetTracker } from './active-set.ts'
import { decide, initialPolicyState, type Decision, type EdgeRecord, type PolicyState } from './policy.ts'
import type { MeterReading, WindowMeter } from './meters.ts'
import { ManualLockTracker, type ManualLockEntry } from './manual-lock.ts'
import type { LockStore } from './lock-store.ts'

/** Minimal logger surface (the Host logger satisfies it). */
export interface ControllerLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** One programmatic model switch (structurally satisfied by sessionController). */
export interface SwitchApi {
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
}

/** Model catalog shape used for the edge pre-flight. */
export interface CatalogApi {
  modelCatalog(): Promise<{ groups: readonly { id: string; models: readonly { id: string }[] }[] }>
}

/** Default-model persistence (so the deployment default follows the policy). */
export interface DefaultModelApi {
  saveSelection(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
  /**
   * The deployment default as it currently resolves, for the reconcile
   * default-leg drift check. Optional — a save-only host skips that check.
   * Route only (provider/model): effort-only default drift does not move
   * quota, same scope as the manual-lock classifier.
   */
  currentSelection?(): { provider: string; model: string } | undefined
}

/** Everything the controller needs; all host-specific, all optional where noted. */
export interface AutoRouteDeps {
  readonly config: ResolvedConfig
  readonly tracker: ActiveSetTracker
  readonly logger: ControllerLogger
  /** One meter poll; throws MeterError (or anything) to mean "no reading". */
  meters(): Promise<MeterReading>
  readonly sessions: SwitchApi
  readonly catalog?: CatalogApi
  readonly defaultModel?: DefaultModelApi
  readonly now?: () => number
  /**
   * Durable store for manual-lock entries (ruling A, 2026-11-01: 锁持久化).
   * Omission keeps the pre-A in-memory behavior.
   */
  readonly lockStore?: LockStore
  /**
   * Publish every completed tick's poll verdict (2026-11-04 ruling: the
   * 安康盾 sustained-failure plane rides this per-tick report — the harness
   * reader judges both streak age and writer liveness from it). Omission
   * keeps the status-endpoint-only behavior.
   */
  onPoll?(lastPoll: { at: number; ok: boolean; error?: string; failingSince?: number }): void
}

/** Per-session result of one switch pass. */
export interface SwitchOutcome {
  readonly sessionId: string
  readonly status: 'switched' | 'skipped' | 'failed'
  readonly detail?: string
}

/** One edge's executed pass (status payload). */
export interface OutcomeRecord {
  readonly at: number
  readonly action: 'switch' | 'default-switch' | 'restore'
  readonly results: readonly SwitchOutcome[]
  readonly defaultSaved: boolean
}

/** Blocked-edge diagnostics (target missing from the catalog). */
export interface TargetProblem {
  readonly at: number
  readonly action: 'switch' | 'default-switch' | 'restore' | 'reconcile'
  readonly provider: string
  readonly model: string
  readonly reason: string
}

/**
 * One reconcile pass (2026-11-01 ruling A: 稳态对账). Stamped on every
 * successful hold poll so the status endpoint can prove the leg is alive;
 * `switched`/`defaultRestored` count what that pass actually changed.
 */
export interface ReconcileRecord {
  readonly at: number
  /** Active-set sessions the fold let the pass judge (locked/unknown excluded). */
  readonly checked: number
  readonly switched: number
  /** Skipped because the observed route already matched the target. */
  readonly aligned: number
  readonly skippedLocked: number
  /** No fold observation yet since boot — left alone, judged on first use. */
  readonly skippedUnknown: number
  readonly failed: number
  /** The deployment default was off-target and re-saved this pass. */
  readonly defaultRestored: boolean
  /** Why this pass could not restore a drifted default (per-pass, not sticky). */
  readonly defaultError?: string
  /**
   * Session leg paused this pass: the two policy latches disagree (dead zone
   * 95–99), so neither side is unambiguously "the" session target — the
   * design deliberately tolerates mixed sides there and the next edge
   * re-aligns. The default leg still runs.
   */
  readonly sessionLegPaused: boolean
}

/** The status endpoint's payload — the badge's authority for current source. */
export interface AutoRouteStatusView {
  readonly service: 'dsh-auto-route'
  readonly policy: {
    readonly phase: PolicyState['phase']
    readonly effectiveSource: string
    /** What a brand-new session inherits — may diverge from `effectiveSource` in the dead zone. */
    readonly defaultsSource: string
    readonly phaseSince: number
    readonly lastDecision?: 'default-switch' | 'trigger' | 'restore'
    readonly lastDecisionAt?: number
    readonly lines: {
      readonly triggerRatio: number
      readonly defaultRatio: number
      readonly restoreRatio: number
      readonly minDwellMs: number
      readonly pollIntervalMs: number
      readonly activeWindowMs: number
      /** Steady-state reconcile leg on/off (2026-11-01 ruling A). */
      readonly reconcile: boolean
    }
    readonly targets: { readonly switchTo: ModelTarget; readonly restoreTo: ModelTarget }
    readonly readingAt?: number
    readonly windows?: readonly WindowMeter[]
    /**
     * Last meter poll. On a failure streak `failingSince` stamps the FIRST
     * consecutive failure (epoch ms) so a reader can tell a one-off blip from
     * a sustained outage; it is absent while polls succeed (cleared on the
     * first good read after a streak).
     */
    readonly lastPoll?: { readonly at: number; readonly ok: boolean; readonly error?: string; readonly failingSince?: number }
    readonly lastDefaultSwitch?: EdgeRecord
    readonly lastTrigger?: EdgeRecord
    readonly lastRestore?: EdgeRecord
    /** Latest reconcile pass (absent while `reconcile: false`). */
    readonly lastReconcile?: ReconcileRecord
    readonly targetProblem?: TargetProblem
    readonly lastOutcome?: OutcomeRecord
    readonly activeSet: {
      readonly tracked: number
      readonly entries: readonly { sessionId: string; running: boolean; lastRequestAt?: number; subagent?: boolean; selection?: string }[]
    }
    /** Human-touched sessions — both edges skip them until realigned (A case). */
    readonly manualLocks: readonly ManualLockEntry[]
    readonly balanceGuardrail: {
      readonly enabled: boolean
      readonly minBalance?: number
      readonly note?: string
    }
  }
}

/** Classify one selectModel rejection: subagent ownership is "skipped", rest "failed". */
function classify(error: unknown): { status: 'skipped' | 'failed'; detail: string } {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 200)
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code.includes('subagent')) return { status: 'skipped', detail }
  if (/subagent/i.test(detail)) return { status: 'skipped', detail }
  return { status: 'failed', detail }
}

/** Auto-routing policy controller (poll → decide → switch, with status). */
export class AutoRouteController {
  private readonly now: () => number
  private state: PolicyState
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight = false
  private stopped = false
  private lastPoll?: { at: number; ok: boolean; error?: string; failingSince?: number }
  private targetProblem?: TargetProblem
  private lastOutcome?: OutcomeRecord
  /** Latest reconcile pass (ruling A); absent until the first hold poll. */
  private lastReconcile?: ReconcileRecord
  /**
   * Signature of the last default-drift restore already logged. Suppresses
   * log spam when a restore keeps failing (or not sticking) with the same
   * shape every 45 s poll; cleared once the default reads aligned again.
   */
  private lastDefaultDriftLog?: string
  /**
   * Manual-lock ledger (A case, 2026-10-27): human touches skip both edges.
   * Lock ENTRIES persist through `deps.lockStore` (ruling A, 2026-11-01).
   */
  private readonly locks: ManualLockTracker

  constructor(private readonly deps: AutoRouteDeps) {
    this.now = deps.now ?? Date.now
    this.locks = new ManualLockTracker(deps.lockStore)
    // Baseline = the restore side: at boot the deployment default is on opencode-go.
    this.state = initialPolicyState(deps.config.restoreTo.provider, this.now())
  }

  /** Arm the loop: mount line first, an early first poll, then the cadence. */
  start(): void {
    const { config } = this.deps
    this.deps.logger.info(
      `dsh-auto-route: mounted — poll=${config.pollIntervalMs}ms trigger>=${config.triggerRatio} default>=${config.defaultRatio} restore<${config.restoreRatio}`
      + ` dwell=${config.minDwellMs}ms activeWindow=${config.activeWindowMs}ms`
      + ` switchTo=${config.switchTo.provider}/${config.switchTo.model}`
      + ` restoreTo=${config.restoreTo.provider}/${config.restoreTo.model}`
      + ` reconcile=${config.reconcile ? 'on' : 'off (edge-only; 2026-11-01 ruling A default is on)'}`
      + ` balanceGuardrail=${config.balanceGuardrail.enabled ? 'on' : 'off (2026-10-27 ruling: no cash gate)'}`,
    )
    this.stopped = false
    this.schedule(500)
  }

  /** Disarm the loop (Host teardown). */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => { void this.runOnce() }, delay)
  }

  private async runOnce(): Promise<void> {
    try {
      await this.tick()
    } finally {
      this.schedule(this.deps.config.pollIntervalMs)
    }
  }

  /**
   * One poll cycle. Safe to call concurrently (a second call during an
   * in-flight poll is a no-op); tests drive it directly with a fake clock.
   */
  async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    const now = this.now()
    this.deps.tracker.prune(now, this.deps.config.activeWindowMs)
    try {
      const reading = await this.deps.meters()
      this.lastPoll = { at: now, ok: true }
      const staged: PolicyState = { ...this.state, lastReading: reading }
      const decision = decide(staged, reading, this.deps.config, now)
      if (decision.action !== 'hold') {
        await this.execute(decision)
      }
      // hold: keep phase and edges untouched; only the reading carried over.
      if (decision.action === 'hold') {
        this.state = decision.state
        // Steady-state reconcile (2026-11-01 ruling A): only on a hold that
        // had a successful reading — an edge tick just aligned the set itself,
        // and a failed poll must make no decisions at all (坏读数零决策).
        if (this.deps.config.reconcile) await this.reconcile(now)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // Streak bookkeeping: the first consecutive failure stamps
      // `failingSince`, later failures of the same streak keep it (a
      // sustained-outage reader measures from the streak start, not the
      // latest miss); a success above rewrites lastPoll without it.
      const failingSince = this.lastPoll?.ok === false && this.lastPoll.failingSince !== undefined
        ? this.lastPoll.failingSince
        : now
      this.lastPoll = { at: now, ok: false, error: detail.slice(0, 300), failingSince }
      this.deps.logger.warn(`dsh-auto-route: meter poll failed (state untouched): ${detail.slice(0, 300)}`)
    } finally {
      this.inFlight = false
      // Report after every completed tick (success or failure): the reader
      // treats a quiet writer as a dead loop, so the heartbeat must not skip.
      if (this.lastPoll !== undefined) this.deps.onPoll?.(this.lastPoll)
    }
  }

  /**
   * Apply one edge: pre-flight the target, run the leg's effect, stamp the
   * edge record. The phase only advances when the pre-flight passed — a
   * blocked edge leaves the state as-is and surfaces on the status endpoint.
   *
   * - `default-switch` — default leg alone: move the deployment default and
   *   stop; running sessions are never touched.
   * - `switch` — in-flight leg: batch-select the active set; the default
   *   follows too (decide() already engaged the default leg on this edge).
   * - `restore` — shared down-edge: the session pass runs only when the
   *   in-flight leg had engaged; a default-only restore must not stomp
   *   sessions the policy never moved. The default always returns.
   *
   * @param decision - the edge decision with its next state.
   */
  private async execute(decision: Extract<Decision, { action: 'switch' | 'default-switch' | 'restore' }>): Promise<void> {
    const { config } = this.deps
    // Which legs were up BEFORE this decision (read before state advances).
    const wasTriggered = this.state.phase === 'triggered'
    const target = decision.action === 'restore' ? config.restoreTo : config.switchTo
    const now = this.now()
    const preflight = await this.preflight(target)
    if (!preflight.ok) {
      this.targetProblem = { at: now, action: decision.action, provider: target.provider, model: target.model, reason: preflight.reason }
      this.deps.logger.error(
        `dsh-auto-route: ${decision.action} blocked — target ${target.provider}/${target.model} unavailable (${preflight.reason}); staying ${this.state.phase}`,
      )
      return
    }
    this.targetProblem = undefined

    const runSessionPass = decision.action === 'switch' || (decision.action === 'restore' && wasTriggered)
    const active = runSessionPass ? this.deps.tracker.snapshot(now, config.activeWindowMs) : []
    const results = await this.sweep(active, target, decision.action)

    // Default follows the policy. selectModel saves it as a side effect when
    // sessions switched; the explicit save covers the empty-set edge, the
    // default-only edge, and the default-only restore (and makes the
    // default's state observable either way).
    let defaultSaved = false
    if (this.deps.defaultModel !== undefined) {
      try {
        await this.deps.defaultModel.saveSelection({
          provider: target.provider,
          model: target.model,
          ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
        })
        defaultSaved = true
      } catch (error) {
        this.deps.logger.warn(`dsh-auto-route: default model not saved for ${target.provider}/${target.model}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (active.length === 0) {
      this.deps.logger.warn('dsh-auto-route: active set empty and no default-model service — the deployment default stays put until a session switches')
    }

    // decide() stamps the edge shell for the matching action; the fallback
    // keeps the record complete even if that invariant is ever refactored.
    const shell = (decision.action === 'switch'
      ? decision.state.lastTrigger
      : decision.action === 'default-switch'
        ? decision.state.lastDefaultSwitch
        : decision.state.lastRestore)
      ?? { at: now, ratios: {}, switched: 0, skipped: 0, failed: 0, defaultSaved: false }
    const edge: EdgeRecord = {
      ...shell,
      switched: results.filter(result => result.status === 'switched').length,
      skipped: results.filter(result => result.status === 'skipped').length,
      failed: results.filter(result => result.status === 'failed').length,
      defaultSaved,
    }
    this.state = decision.action === 'switch'
      ? { ...decision.state, lastTrigger: edge }
      : decision.action === 'default-switch'
        ? { ...decision.state, lastDefaultSwitch: edge }
        : { ...decision.state, lastRestore: edge }
    this.lastOutcome = { at: now, action: decision.action, results, defaultSaved }
    this.deps.logger.info(
      `dsh-auto-route: ${decision.action} applied — effectiveSource=${this.state.effectiveSource} defaultsSource=${this.state.defaultsSource}`
      + ` active=${active.length} switched=${edge.switched} skipped=${edge.skipped} failed=${edge.failed} defaultSaved=${String(defaultSaved)}`,
    )
  }

  /**
   * Switch one batch of sessions to a target through the manual-lock
   * machinery. Shared by the edges (`execute`) and the reconcile leg, so both
   * paths classify human locks identically and book the controller's own
   * writes as `auto`.
   * @param sessionIds - sessions to switch (already filtered by the caller).
   * @param target - provider/model/effort to install.
   * @param action - label for failure logs (`switch`/`restore`/`reconcile`).
   * @returns per-session outcomes.
   */
  private async sweep(sessionIds: readonly string[], target: ModelTarget, action: string): Promise<SwitchOutcome[]> {
    const value = `${target.provider}/${target.model}`
    const results: SwitchOutcome[] = []
    for (const sessionId of sessionIds) {
      // A case (2026-10-27): a human-touched session is locked — both edges
      // skip it (visible as skipped/manual-lock) until its selection realigns.
      if (this.locks.isLocked(sessionId)) {
        results.push({ sessionId, status: 'skipped', detail: 'manual-lock' })
        continue
      }
      this.locks.expect(sessionId, value)
      try {
        await this.deps.sessions.selectModel({
          sessionId,
          provider: target.provider,
          model: target.model,
          ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
        })
        this.locks.confirm(sessionId, value)
        results.push({ sessionId, status: 'switched' })
      } catch (error) {
        this.locks.abort(sessionId)
        const classified = classify(error)
        results.push({ sessionId, status: classified.status, detail: classified.detail })
        this.deps.logger.warn(`dsh-auto-route: ${classified.status} session ${sessionId} during ${action}: ${classified.detail}`)
      }
    }
    return results
  }

  /**
   * Steady-state reconcile (2026-11-01 ruling A: 稳态对账 + 锁持久化).
   * Runs after every successful hold poll and re-asserts BOTH policy legs
   * against reality — this is the half the edge-only design was missing: an
   * edge fires once, so anything that drifted AFTER the edge (a session born
   * on the wrong side, a default rewritten by the harness's selectModel side
   * effect, a session left stranded because it was idle at edge time) stayed
   * wrong until the next edge, which might be hours away.
   *
   * Three guards keep it from fighting the other rulings:
   * - Manual locks are skipped (A case 2026-10-27 survives, now across restarts).
   * - Dead zone (latches disagree): the session leg pauses — neither side is
   *   unambiguously the target there; the default leg still runs.
   * - Unknown folds are left alone: a session with no observation since boot
   *   is judged on its first request, never switched blind.
   *
   * @param now - epoch ms of this poll.
   */
  private async reconcile(now: number): Promise<void> {
    try {
      const { config, tracker } = this.deps
      const deadZone = this.state.phase !== this.state.defaultsPhase
      // When the latches agree both legs name the same target, so ONE target
      // serves the whole pass; in the dead zone only the default leg runs and
      // it wants the defaultsPhase side.
      const target = this.state.defaultsPhase === 'triggered' ? config.switchTo : config.restoreTo
      const targetValue = `${target.provider}/${target.model}`

      // --- session leg (paused in the dead zone: neither side is cleanly
      // "the" in-flight target there, and pulling mimo-born sessions to go
      // would undo the default leg's hedge) ---
      const active = tracker.snapshot(now, config.activeWindowMs)
      const candidates: string[] = []
      let aligned = 0
      let skippedLocked = 0
      let skippedUnknown = 0
      if (!deadZone) {
        for (const sessionId of active) {
          if (this.locks.isLocked(sessionId)) { skippedLocked++; continue }
          const observed = tracker.effectiveRoute(sessionId)
          if (observed === undefined) { skippedUnknown++; continue }
          if (observed === targetValue) { aligned++; continue }
          candidates.push(sessionId)
        }
      }
      // Sessions the fold could judge — the pass's real workload, fixed before
      // the sweep (a lock raced in mid-pass still counts as judged).
      const checked = candidates.length + aligned

      // --- default-leg drift (the harness's selectModel side effect rewrites
      // the deployment default on every human session switch) ---
      let defaultDrift: { read: string } | undefined
      const readDefault = this.deps.defaultModel?.currentSelection?.()
      if (this.deps.defaultModel !== undefined && readDefault !== undefined) {
        const read = `${readDefault.provider}/${readDefault.model}`
        if (read !== targetValue) defaultDrift = { read }
      }

      // One pre-flight per pass (the two legs never name different targets
      // outside the dead zone, where only the default leg runs). Also runs
      // unconditionally while a reconcile-originated block is unresolved, so
      // recovery is detected and the stale problem cleared.
      const needsPreflight = candidates.length > 0 || defaultDrift !== undefined || this.targetProblem?.action === 'reconcile'
      if (needsPreflight) {
        const preflight = await this.preflight(target)
        if (!preflight.ok) {
          const problem: TargetProblem = { at: now, action: 'reconcile', provider: target.provider, model: target.model, reason: preflight.reason }
          const changed = this.targetProblem?.reason !== problem.reason || this.targetProblem?.action !== 'reconcile'
          this.targetProblem = problem
          if (changed) {
            this.deps.logger.error(
              `dsh-auto-route: reconcile blocked — target ${targetValue} unavailable (${preflight.reason}); leaving sessions and default as they are`,
            )
          }
          this.lastReconcile = {
            at: now, checked, switched: 0, aligned, skippedLocked, skippedUnknown, failed: 0,
            defaultRestored: false, sessionLegPaused: deadZone,
          }
          return
        }
        if (this.targetProblem?.action === 'reconcile') this.targetProblem = undefined
      }

      const results = candidates.length === 0 ? [] : await this.sweep(candidates, target, 'reconcile')
      const switched = results.filter(result => result.status === 'switched').length
      const failed = results.filter(result => result.status === 'failed').length
      // sweep() skips locks itself; a lock raced in between counts as skippedLocked here.
      skippedLocked += results.filter(result => result.status === 'skipped').length
      if (switched > 0) {
        this.deps.logger.info(
          `dsh-auto-route: reconcile — ${switched}/${candidates.length} active session(s) pulled to ${targetValue}`
          + ` (locked=${skippedLocked} unknown=${skippedUnknown} aligned=${aligned})`,
        )
      }

      // --- default leg: restore the drift, deduping repeated identical
      // restores so a not-sticking write can warn no louder than once ---
      let defaultRestored = false
      let defaultError: string | undefined
      if (defaultDrift !== undefined) {
        const driftKey = `${defaultDrift.read}->${targetValue}`
        try {
          await this.deps.defaultModel?.saveSelection({
            provider: target.provider,
            model: target.model,
            ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
          })
          defaultRestored = true
          if (this.lastDefaultDriftLog !== driftKey) {
            this.lastDefaultDriftLog = driftKey
            this.deps.logger.info(
              `dsh-auto-route: reconcile — deployment default ${defaultDrift.read} drifted from policy; restored to ${targetValue}`,
            )
          }
        } catch (error) {
          defaultError = (error instanceof Error ? error.message : String(error)).slice(0, 200)
          if (this.lastDefaultDriftLog !== `error:${driftKey}`) {
            this.lastDefaultDriftLog = `error:${driftKey}`
            this.deps.logger.warn(`dsh-auto-route: reconcile could not restore the default to ${targetValue}: ${defaultError}`)
          }
        }
      } else {
        this.lastDefaultDriftLog = undefined // recovered — a future drift of the same shape logs again
      }

      this.lastReconcile = {
        at: now,
        checked,
        switched,
        aligned,
        skippedLocked,
        skippedUnknown,
        failed,
        defaultRestored,
        ...(defaultError === undefined ? {} : { defaultError }),
        sessionLegPaused: deadZone,
      }
    } catch (error) {
      // Reconcile is self-contained: a failure here must never mark the meter
      // poll itself as failed (the reading succeeded and state carries it).
      this.deps.logger.warn(`dsh-auto-route: reconcile pass failed (state untouched): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Ask the live catalog whether the edge's target is actually routable.
   * @param target - provider/model the edge would install.
   * @returns pass (or no catalog to ask) or the concrete reason it cannot.
   */
  private async preflight(target: ModelTarget): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.deps.catalog === undefined) return { ok: true }
    try {
      const catalog = await this.deps.catalog.modelCatalog()
      const group = catalog.groups.find(candidate => candidate.id === target.provider)
      if (group === undefined) return { ok: false, reason: `provider "${target.provider}" is not routable in the model catalog` }
      if (!group.models.some(model => model.id === target.model)) {
        return { ok: false, reason: `model "${target.model}" is not offered by provider "${target.provider}"` }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `model catalog unreadable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * Host hook: classify one durable model/selection event (A case, 2026-10-27
   * 人工锁定优先). A human touch locks the session — both edges skip it —
   * until the selection realigns with the ledger or the live policy target.
   * @param sessionId - session whose selection changed.
   * @param selection - the new durable selection.
   * @param now - wall-clock ms (tests inject; defaults to the controller clock).
   */
  onSelectionEvent(sessionId: string, selection: { readonly provider: string; readonly model: string }, now?: number): void {
    const target = this.state.phase === 'triggered' ? this.deps.config.switchTo : this.deps.config.restoreTo
    const verdict = this.locks.observe(
      sessionId,
      `${selection.provider}/${selection.model}`,
      now ?? this.now(),
      `${target.provider}/${target.model}`,
    )
    if (verdict === 'manual-lock' || verdict === 'manual-relock') {
      this.deps.logger.info(
        `dsh-auto-route: manual lock session ${sessionId} → ${selection.provider}/${selection.model}`
        + ` (${verdict}; both edges skip it until realigned)`,
      )
    }
  }

  /** The status endpoint's payload (badge + triage). */
  status(): AutoRouteStatusView {
    const { config } = this.deps
    const windows = this.state.lastReading === undefined
      ? undefined
      : (Object.values(this.state.lastReading.windows) as (WindowMeter | undefined)[]).filter((window): window is WindowMeter => window !== undefined)
    return {
      service: 'dsh-auto-route',
      policy: {
        phase: this.state.phase,
        effectiveSource: this.state.effectiveSource,
        defaultsSource: this.state.defaultsSource,
        phaseSince: this.state.phaseSince,
        ...(this.state.lastDecision === undefined ? {} : { lastDecision: this.state.lastDecision }),
        ...(this.state.lastDecisionAt === undefined ? {} : { lastDecisionAt: this.state.lastDecisionAt }),
        lines: {
          triggerRatio: config.triggerRatio,
          defaultRatio: config.defaultRatio,
          restoreRatio: config.restoreRatio,
          minDwellMs: config.minDwellMs,
          pollIntervalMs: config.pollIntervalMs,
          activeWindowMs: config.activeWindowMs,
          reconcile: config.reconcile,
        },
        targets: { switchTo: config.switchTo, restoreTo: config.restoreTo },
        ...(this.state.lastReading === undefined ? {} : { readingAt: this.state.lastReading.at }),
        ...(windows === undefined ? {} : { windows }),
        ...(this.lastPoll === undefined ? {} : { lastPoll: this.lastPoll }),
        ...(this.state.lastDefaultSwitch === undefined ? {} : { lastDefaultSwitch: this.state.lastDefaultSwitch }),
        ...(this.state.lastTrigger === undefined ? {} : { lastTrigger: this.state.lastTrigger }),
        ...(this.state.lastRestore === undefined ? {} : { lastRestore: this.state.lastRestore }),
        ...(this.lastReconcile === undefined ? {} : { lastReconcile: this.lastReconcile }),
        ...(this.targetProblem === undefined ? {} : { targetProblem: this.targetProblem }),
        ...(this.lastOutcome === undefined ? {} : { lastOutcome: this.lastOutcome }),
        activeSet: { tracked: this.deps.tracker.size, entries: this.deps.tracker.view(50) },
        manualLocks: this.locks.snapshot(),
        balanceGuardrail: {
          enabled: config.balanceGuardrail.enabled,
          ...(config.balanceGuardrail.minBalance === undefined ? {} : { minBalance: config.balanceGuardrail.minBalance }),
          ...(config.balanceGuardrail.enabled ? {} : { note: 'disabled by the 2026-10-27 ruling — no cash gate, burn to balance' }),
        },
      },
    }
  }
}
