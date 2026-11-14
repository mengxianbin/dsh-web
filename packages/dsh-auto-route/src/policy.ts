/**
 * The decision layer: pure latch logic over a meter reading. Two independent
 * latches share one down-edge:
 *
 * - **In-flight leg** (`phase`): `baseline` keeps sessions on the OpenCode Go
 *   side, `triggered` has switched the active set to the MiMo official route.
 *   Its up-edge fires when any window reads `>= triggerRatio` (0.99 ruling
 *   value, unrounded ratio).
 * - **Default leg** (`defaultsPhase`): `triggered` means the global default
 *   model already points at `switchTo`, so new/rotated sessions are born on
 *   that side. Its up-edge fires when any window reads `>= defaultRatio`
 *   (0.95, ruling 2026-10-27) and moves the default model **only** — the
 *   active set keeps running.
 * - **Shared down-edge** (`restore`): when *every* window reads `<
 *   restoreRatio` (0.95, revised from 0.70 by the 2026-10-27 ruling) and the
 *   minimum dwell (0 = off) has elapsed, both latches reset together.
 *
 * An in-flight trigger always implies the default leg (a reading that jumps
 * past both lines fires one `switch` that sets both). The dwell clock anchors
 * on the default leg's engagement — the earlier of the two. Nothing here
 * touches the network, the clock (it receives `now`), or a Session — the
 * controller applies the returned state after the edge actually ran.
 * @module dsh-auto-route/policy
 */

import type { ResolvedConfig } from './config.ts'
import type { MeterReading, WindowKey } from './meters.ts'
import { WINDOW_KEYS } from './meters.ts'

/** Lifecycle phase of one latch. */
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
  /** In-flight leg: has the active set been switched? */
  readonly phase: PolicyPhase
  /** Provider id the in-flight leg considers in force (badge text source). */
  readonly effectiveSource: string
  /** Default leg: does the global default model already point at `switchTo`? */
  readonly defaultsPhase: PolicyPhase
  /** Provider id the default model is on (what a brand-new session inherits). */
  readonly defaultsSource: string
  /** When the in-flight leg's current phase began. */
  readonly phaseSince: number
  /** When the default leg engaged — the dwell anchor (the earlier edge). */
  readonly defaultsSince: number
  readonly lastDecision?: 'default-switch' | 'trigger' | 'restore'
  readonly lastDecisionAt?: number
  readonly lastDefaultSwitch?: EdgeRecord
  readonly lastTrigger?: EdgeRecord
  readonly lastRestore?: EdgeRecord
  readonly lastReading?: MeterReading
}

/** What the controller must do after a decision (discriminated on `action`). */
export type Decision =
  | { readonly action: 'switch'; readonly reason: string; readonly state: PolicyState }
  | { readonly action: 'default-switch'; readonly reason: string; readonly state: PolicyState }
  | { readonly action: 'restore'; readonly reason: string; readonly state: PolicyState }
  | { readonly action: 'hold'; readonly reason: string; readonly state: PolicyState }

/** Fresh state at controller boot: both legs baseline on the OpenCode Go side. */
export function initialPolicyState(baselineSource: string, now: number): PolicyState {
  return {
    phase: 'baseline',
    effectiveSource: baselineSource,
    defaultsPhase: 'baseline',
    defaultsSource: baselineSource,
    phaseSince: now,
    defaultsSince: now,
  }
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
 * @returns `switch` on the in-flight up-edge (both latches engaged),
 *   `default-switch` on the default-only up-edge (active set untouched),
 *   `restore` on the shared down-edge, otherwise `hold` with the input state.
 *   A reading that lacks a window can still raise either up-edge (one window
 *   is enough) but never restores — "all three below" cannot be asserted from
 *   incomplete data, so an incomplete reading fails safe toward staying up.
 */
export function decide(state: PolicyState, reading: MeterReading, config: ResolvedConfig, now: number): Decision {
  const ratios = ratiosOf(reading)
  const present = (Object.values(ratios) as number[]).filter(ratio => Number.isFinite(ratio))
  const defaultsOn = state.defaultsPhase === 'triggered'

  if (state.phase === 'baseline') {
    // In-flight up-edge outranks the default line: a reading that jumped past
    // both fires one switch, and the switch implies the default leg.
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
          ...(defaultsOn
            ? {}
            : { defaultsPhase: 'triggered' as const, defaultsSource: config.switchTo.provider, defaultsSince: now }),
          lastDecision: 'trigger',
          lastDecisionAt: now,
          lastTrigger: { at: now, ratios, switched: 0, skipped: 0, failed: 0, defaultSaved: false },
          lastReading: reading,
        },
      }
    }
    if (!defaultsOn) {
      const defaultHit = present.find(ratio => ratio >= config.defaultRatio)
      if (defaultHit !== undefined) {
        return {
          action: 'default-switch',
          reason: `a window reached ${defaultHit.toFixed(6)} >= default line ${config.defaultRatio}`,
          state: {
            ...state,
            defaultsPhase: 'triggered',
            defaultsSource: config.switchTo.provider,
            defaultsSince: now,
            lastDecision: 'default-switch',
            lastDecisionAt: now,
            lastDefaultSwitch: { at: now, ratios, switched: 0, skipped: 0, failed: 0, defaultSaved: false },
            lastReading: reading,
          },
        }
      }
      return { action: 'hold', reason: 'below the trigger and default lines', state: { ...state, lastReading: reading } }
    }
    // Default leg alone is up (the 95–99 dead zone): fall through to the
    // shared down-edge check; the in-flight leg cannot fire from here without
    // re-entering this block on a later poll.
  }

  // Shared down-edge (either latch up): needs the dwell gate plus a complete
  // reading — "all three below" cannot be asserted from partial data.
  if (now - state.defaultsSince < config.minDwellMs) {
    return { action: 'hold', reason: `minimum dwell not elapsed (${now - state.defaultsSince}ms < ${config.minDwellMs}ms)`, state: { ...state, lastReading: reading } }
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
        defaultsPhase: 'baseline',
        defaultsSource: config.restoreTo.provider,
        phaseSince: now,
        defaultsSince: now,
        lastDecision: 'restore',
        lastDecisionAt: now,
        lastRestore: { at: now, ratios, switched: 0, skipped: 0, failed: 0, defaultSaved: false },
        lastReading: reading,
      },
    }
  }
  return { action: 'hold', reason: `${above.length} window(s) still at or above restore ${config.restoreRatio}`, state: { ...state, lastReading: reading } }
}
