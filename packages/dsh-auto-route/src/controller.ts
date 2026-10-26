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
  readonly action: 'switch' | 'default-switch' | 'restore'
  readonly provider: string
  readonly model: string
  readonly reason: string
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
    }
    readonly targets: { readonly switchTo: ModelTarget; readonly restoreTo: ModelTarget }
    readonly readingAt?: number
    readonly windows?: readonly WindowMeter[]
    readonly lastPoll?: { readonly at: number; readonly ok: boolean; readonly error?: string }
    readonly lastDefaultSwitch?: EdgeRecord
    readonly lastTrigger?: EdgeRecord
    readonly lastRestore?: EdgeRecord
    readonly targetProblem?: TargetProblem
    readonly lastOutcome?: OutcomeRecord
    readonly activeSet: {
      readonly tracked: number
      readonly entries: readonly { sessionId: string; running: boolean; lastRequestAt?: number; subagent?: boolean }[]
    }
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
  private lastPoll?: { at: number; ok: boolean; error?: string }
  private targetProblem?: TargetProblem
  private lastOutcome?: OutcomeRecord

  constructor(private readonly deps: AutoRouteDeps) {
    this.now = deps.now ?? Date.now
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
      if (decision.action === 'hold') this.state = decision.state
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.lastPoll = { at: now, ok: false, error: detail.slice(0, 300) }
      this.deps.logger.warn(`dsh-auto-route: meter poll failed (state untouched): ${detail.slice(0, 300)}`)
    } finally {
      this.inFlight = false
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
    const results: SwitchOutcome[] = []
    for (const sessionId of active) {
      try {
        await this.deps.sessions.selectModel({
          sessionId,
          provider: target.provider,
          model: target.model,
          ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
        })
        results.push({ sessionId, status: 'switched' })
      } catch (error) {
        const classified = classify(error)
        results.push({ sessionId, status: classified.status, detail: classified.detail })
        this.deps.logger.warn(`dsh-auto-route: ${classified.status} session ${sessionId} during ${decision.action}: ${classified.detail}`)
      }
    }

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
        },
        targets: { switchTo: config.switchTo, restoreTo: config.restoreTo },
        ...(this.state.lastReading === undefined ? {} : { readingAt: this.state.lastReading.at }),
        ...(windows === undefined ? {} : { windows }),
        ...(this.lastPoll === undefined ? {} : { lastPoll: this.lastPoll }),
        ...(this.state.lastDefaultSwitch === undefined ? {} : { lastDefaultSwitch: this.state.lastDefaultSwitch }),
        ...(this.state.lastTrigger === undefined ? {} : { lastTrigger: this.state.lastTrigger }),
        ...(this.state.lastRestore === undefined ? {} : { lastRestore: this.state.lastRestore }),
        ...(this.targetProblem === undefined ? {} : { targetProblem: this.targetProblem }),
        ...(this.lastOutcome === undefined ? {} : { lastOutcome: this.lastOutcome }),
        activeSet: { tracked: this.deps.tracker.size, entries: this.deps.tracker.view(50) },
        balanceGuardrail: {
          enabled: config.balanceGuardrail.enabled,
          ...(config.balanceGuardrail.minBalance === undefined ? {} : { minBalance: config.balanceGuardrail.minBalance }),
          ...(config.balanceGuardrail.enabled ? {} : { note: 'disabled by the 2026-10-27 ruling — no cash gate, burn to balance' }),
        },
      },
    }
  }
}
