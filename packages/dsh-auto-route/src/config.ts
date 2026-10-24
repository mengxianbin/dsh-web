/**
 * Deployment policy for the auto-route controller: every ruling parameter is
 * a configurable field with the 2026-10-24 ruling value as its default. The
 * schema below only validates shapes and types; `resolveConfig` owns every
 * default and every range, so there is exactly one place a value can come
 * from. @module dsh-auto-route/config
 */

import z from 'schemastery'

/** One switch target: a provider route plus the exact model on it. */
export interface ModelTarget {
  readonly provider: string
  readonly model: string
  /** Optional reasoning effort; absent selects the model's own default. */
  readonly reasoningEffort?: string
}

/** A partially-spelled target in a plugin row; missing fields fall back to the default. */
export type ModelTargetInput = {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** MiMo balance guardrail — off until its data source is confirmed. */
export interface BalanceGuardrailConfig {
  /** Master switch. The 2026-10-24 ruling keeps this OFF. */
  readonly enabled: boolean
  /** Minimum remaining balance to keep switching; unset while the dependency is open. */
  readonly minBalance?: number
}

/** Plugin config as the profile patch may spell it (every field optional). */
export interface Config {
  readonly enabled?: boolean
  /** Poll cadence; the ruling range is 30–60 s and resolveConfig clamps into it. */
  readonly pollIntervalMs?: number
  /** Trigger line: any window `used/limit >= triggerRatio` switches (ruling: 0.99). */
  readonly triggerRatio?: number
  /** Restore hysteresis: every window must read `< restoreRatio` (ruling: 0.70). */
  readonly restoreRatio?: number
  /** Shortest triggered-phase stay before a restore is allowed; 0 = off (ruling). */
  readonly minDwellMs?: number
  /** Request recency that keeps a session in the active set (ruling: 30 min). */
  readonly activeWindowMs?: number
  /** Target on trigger (ruling: MiMo official route). */
  readonly switchTo?: ModelTargetInput
  /** Target on restore (ruling: back to opencode-go). */
  readonly restoreTo?: ModelTargetInput
  /** Go meter source (absolute micro-cent meters, unrounded ratios). */
  readonly meterUrl?: string
  /** Env var holding the bearer key; read into process memory only, never logged. */
  readonly meterKeyEnv?: string
  /** Balance guardrail policy; default disabled pending session-276c5584. */
  readonly balanceGuardrail?: { readonly enabled?: boolean; readonly minBalance?: number }
}

/**
 * Schemastery shape for the plugin row: type validation only. Object keys
 * are permissive by default here (absent fields pass through untouched), so
 * every default, range, and clamp lives in `resolveConfig` alone — a value
 * can come from exactly one place.
 */
export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  pollIntervalMs: z.number(),
  triggerRatio: z.number(),
  restoreRatio: z.number(),
  minDwellMs: z.number(),
  activeWindowMs: z.number(),
  switchTo: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
  }),
  restoreTo: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
  }),
  meterUrl: z.string(),
  meterKeyEnv: z.string(),
  balanceGuardrail: z.object({
    enabled: z.boolean(),
    minBalance: z.number(),
  }),
})

/** Fully-resolved policy (defaults applied, ranges enforced). */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly pollIntervalMs: number
  readonly triggerRatio: number
  readonly restoreRatio: number
  readonly minDwellMs: number
  readonly activeWindowMs: number
  readonly switchTo: ModelTarget
  readonly restoreTo: ModelTarget
  readonly meterUrl: string
  readonly meterKeyEnv: string
  readonly balanceGuardrail: BalanceGuardrailConfig
}

/** Lower poll bound: 30 s (2026-10-24 ruling). */
export const POLL_MIN_MS = 30_000
/** Upper poll bound: 60 s (2026-10-24 ruling). */
export const POLL_MAX_MS = 60_000

/**
 * Apply every default and enforce every range.
 * @param config - raw plugin config (fields may be absent).
 * @param clampPoll - reports an out-of-range poll interval that was clamped.
 * @returns the resolved policy.
 * @throws RangeError on ratios outside (0, 1] or negative durations — a
 *   violated parameter refuses to mount rather than silently diverging from
 *   the ruling.
 */
export function resolveConfig(config: Config, clampPoll?: (raw: number, clamped: number) => void): ResolvedConfig {
  const ratio = (value: number | undefined, fallback: number, field: string): number => {
    const resolved = value ?? fallback
    if (!Number.isFinite(resolved) || resolved <= 0 || resolved > 1) {
      throw new RangeError(`dsh-auto-route: ${field} must be in (0, 1], got ${String(value)}`)
    }
    return resolved
  }
  const duration = (value: number | undefined, fallback: number, field: string): number => {
    const resolved = value ?? fallback
    if (!Number.isFinite(resolved) || resolved < 0) {
      throw new RangeError(`dsh-auto-route: ${field} must be a non-negative finite number, got ${String(value)}`)
    }
    return resolved
  }
  let poll = duration(config.pollIntervalMs, 45_000, 'pollIntervalMs')
  if (poll < POLL_MIN_MS || poll > POLL_MAX_MS) {
    const clamped = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, poll))
    clampPoll?.(poll, clamped)
    poll = clamped
  }
  const target = (value: ModelTargetInput | undefined, fallback: ModelTarget, field: string): ModelTarget => {
    const provider = value?.provider ?? fallback.provider
    const model = value?.model ?? fallback.model
    if (provider === '' || model === '') {
      throw new RangeError(`dsh-auto-route: ${field} needs a non-empty provider and model`)
    }
    // An explicit target keeps the fallback's effort unless it names its own;
    // omitting the whole target takes the fallback verbatim.
    const effort = value?.reasoningEffort ?? fallback.reasoningEffort
    return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
  }
  return {
    enabled: config.enabled ?? true,
    pollIntervalMs: poll,
    triggerRatio: ratio(config.triggerRatio, 0.99, 'triggerRatio'),
    restoreRatio: ratio(config.restoreRatio, 0.70, 'restoreRatio'),
    minDwellMs: duration(config.minDwellMs, 0, 'minDwellMs'),
    activeWindowMs: duration(config.activeWindowMs, 30 * 60_000, 'activeWindowMs'),
    switchTo: target(config.switchTo, { provider: 'mimo', model: 'mimo-v2.6-flash' }, 'switchTo'),
    restoreTo: target(config.restoreTo, { provider: 'opencode-go', model: 'mimo-v2.6-flash', reasoningEffort: 'high' }, 'restoreTo'),
    meterUrl: config.meterUrl ?? 'https://opencode.ai/console/api/go/status',
    meterKeyEnv: config.meterKeyEnv ?? 'OC_GO_CC_API_KEY',
    balanceGuardrail: { enabled: config.balanceGuardrail?.enabled ?? false, ...config.balanceGuardrail?.minBalance === undefined ? {} : { minBalance: config.balanceGuardrail.minBalance } },
  }
}
