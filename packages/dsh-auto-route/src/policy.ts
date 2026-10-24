/**
 * The decision layer: pure phase logic over a meter reading. Two phases only
 * — `baseline` (sessions on the OpenCode Go side) and `triggered` (policy
 * switched to the MiMo official side). Trigger fires when any window reads
 * `>= triggerRatio` (0.99 ruling value, unrounded ratio); restore fires when
 * every one of the three windows reads `< restoreRatio` (0.70) and the
 * minimum dwell (0 = off) has elapsed. Nothing here touches the network,
 * the clock (it receives `now`), or a Session — the controller applies the
 * returned state after the switch pass actually ran.
 * @module dsh-auto-route/policy
 */

import type { ResolvedConfig } from './config.ts'
import type { MeterReading, WindowKey } from './meters.ts'
import { WINDOW_KEYS } from './meters.ts'

/** Lifecycle phase of the policy. */
export type PolicyPhase = 'baseline' | 'triggered'

/** Ratios by window, as recorded with a decision. */
export type RatioSnapshot = Partial<Record<WindowKey, number>>

/** Per-edge switch bookkeeping (counts filled in by the controller). */
export interface EdgeRecord {
  readonly at: number
  readonly ratios: RatioSnapshot
  readonly switched: number
  readonly skipped: number
  readonly failed: number
  /** Whether the default model save was attempted (default follows policy). */
  readonly defaultSaved: boolean
}

/** Policy state the status endpoint serves (the badge's authority). */
export interface PolicyState {
  readonly phase: PolicyPhase
  /** Provider id the policy considers in force right now (badge text source). */
  readonly effectiveSource: string
  /** When the current phase began (dwell clock). */
  readonly phaseSince: number
  readonly lastDecision?: 'trigger' | 'restore'
  readonly lastDecisionAt?: number
  readonly lastTrigger?: EdgeRecord
  readonly lastRestore?: EdgeRecord
  readonly lastReading?: MeterReading
}

/** What the controller must do after a decision (discriminated on `action`). */
export type Decision =
  | { readonly action: 'switch'; readonly reason: string; readonly state: PolicyState }
  | { readonly action: 'restore'; readonly reason: string; readonly state: PolicyState }
  | { readonly action: 'hold'; readonly reason: string; readonly state: PolicyState }

/** Fresh state at controller boot: baseline on the OpenCode Go side. */
export function initialPolicyState(baselineSource: string, now: number): PolicyState {
  return { phase: 'baseline', effectiveSource: baselineSource, phaseSince: now }
}

function ratiosOf(reading: MeterReading): RatioSnapshot {
  const ratios: RatioSnapshot = {}
  for (const key of WINDOW_KEYS) {
    const window = reading.windows[key]
    if (window !== undefined) ratios[key] = window.ratio
  }
  return ratios
}

/**
 * Decide one poll's edge. Pure: the input state is never mutated.
 * @param state - current policy state.
 * @param reading - the fresh meter reading (already fetched successfully).
 * @param config - resolved policy parameters.
 * @param now - wall-clock ms for the transition timestamps.
 * @returns `switch` on the baseline→triggered edge, `restore` on the
 *   triggered→baseline edge, otherwise `hold` with the input state. A
 *   reading that lacks a window can still trigger (one window is enough) but
 *   never restores — "all three below" cannot be asserted from incomplete
 *   data, so an incomplete reading fails safe toward staying triggered.
 */
export function decide(state: PolicyState, reading: MeterReading, config: ResolvedConfig, now: number): Decision {
  const ratios = ratiosOf(reading)
  const present = (Object.values(ratios) as number[]).filter(ratio => Number.isFinite(ratio))

  if (state.phase === 'baseline') {
    const hit = present.find(ratio => ratio >= config.triggerRatio)
    if (hit !== undefined) {
      return {
        action: 'switch',
        reason: `a window reached ${hit.toFixed(6)} >= trigger ${config.triggerRatio}`,
        state: {
          ...state,
          phase: 'triggered',
          effectiveSource: config.switchTo.provider,
          phaseSince: now,
          lastDecision: 'trigger',
          lastDecisionAt: now,
          lastTrigger: { at: now, ratios, switched: 0, skipped: 0, failed: 0, defaultSaved: false },
          lastReading: reading,
        },
      }
    }
    return { action: 'hold', reason: 'below trigger line', state: { ...state, lastReading: reading } }
  }

  // Triggered phase: restore needs the dwell gate (0 = off) plus all three
  // windows strictly under the hysteresis line.
  if (now - state.phaseSince < config.minDwellMs) {
    return { action: 'hold', reason: `minimum dwell not elapsed (${now - state.phaseSince}ms < ${config.minDwellMs}ms)`, state: { ...state, lastReading: reading } }
  }
  const missing = WINDOW_KEYS.filter(key => reading.windows[key] === undefined)
  if (missing.length > 0) {
    return { action: 'hold', reason: `reading lacks ${missing.join('/')}; cannot assert all windows recovered`, state: { ...state, lastReading: reading } }
  }
  const above = present.filter(ratio => ratio >= config.restoreRatio)
  if (above.length === 0) {
    return {
      action: 'restore',
      reason: `every window is below restore ${config.restoreRatio}`,
      state: {
        ...state,
        phase: 'baseline',
        effectiveSource: config.restoreTo.provider,
        phaseSince: now,
        lastDecision: 'restore',
        lastDecisionAt: now,
        lastRestore: { at: now, ratios, switched: 0, skipped: 0, failed: 0, defaultSaved: false },
        lastReading: reading,
      },
    }
  }
  return { action: 'hold', reason: `${above.length} window(s) still at or above restore ${config.restoreRatio}`, state: { ...state, lastReading: reading } }
}
