import { describe, expect, it } from 'vitest'
import { Config, POLL_MAX_MS, POLL_MIN_MS, resolveConfig } from '../src/config.ts'

describe('resolveConfig — ruling defaults (2026-10-24 参数包 · 2026-10-27 修订)', () => {
  it('fills every parameter with its ruling value', () => {
    const config = resolveConfig({})
    expect(config.enabled).toBe(true)
    expect(config.pollIntervalMs).toBe(45_000)
    expect(config.triggerRatio).toBe(0.99)
    expect(config.defaultRatio).toBe(0.95)
    expect(config.restoreRatio).toBe(0.95)
    expect(config.minDwellMs).toBe(0)
    expect(config.activeWindowMs).toBe(30 * 60_000)
    expect(config.switchTo).toEqual({ provider: 'mimo', model: 'mimo-v2.6-flash' })
    expect(config.restoreTo).toEqual({ provider: 'opencode-go', model: 'mimo-v2.6-flash', reasoningEffort: 'high' })
    expect(config.meterUrl).toBe('https://opencode.ai/console/api/go/status')
    expect(config.meterKeyEnv).toBe('OC_GO_CC_API_KEY')
    expect(config.balanceGuardrail).toEqual({ enabled: false })
  })
})

describe('resolveConfig — ranges', () => {
  it('clamps an out-of-range poll interval into 30–60 s and reports it', () => {
    const notes: [number, number][] = []
    const low = resolveConfig({ pollIntervalMs: 10_000 }, (raw, clamped) => notes.push([raw, clamped]))
    expect(low.pollIntervalMs).toBe(POLL_MIN_MS)
    const high = resolveConfig({ pollIntervalMs: 300_000 }, (raw, clamped) => notes.push([raw, clamped]))
    expect(high.pollIntervalMs).toBe(POLL_MAX_MS)
    expect(notes).toEqual([[10_000, POLL_MIN_MS], [300_000, POLL_MAX_MS]])
  })

  it('refuses ratios outside (0, 1] instead of silently diverging from the ruling', () => {
    expect(() => resolveConfig({ triggerRatio: 1.5 })).toThrow(RangeError)
    expect(() => resolveConfig({ triggerRatio: 0 })).toThrow(RangeError)
    expect(() => resolveConfig({ defaultRatio: Number.NaN })).toThrow(RangeError)
    expect(() => resolveConfig({ restoreRatio: Number.NaN })).toThrow(RangeError)
  })

  it('refuses negative durations and empty targets', () => {
    expect(() => resolveConfig({ minDwellMs: -1 })).toThrow(RangeError)
    expect(() => resolveConfig({ activeWindowMs: -5 })).toThrow(RangeError)
    expect(() => resolveConfig({ switchTo: { provider: '', model: 'x' } })).toThrow(RangeError)
  })

  it('keeps a partially-spelled target (effort falls back, model falls back)', () => {
    const config = resolveConfig({ switchTo: { provider: 'mimo' } })
    expect(config.switchTo).toEqual({ provider: 'mimo', model: 'mimo-v2.6-flash' })
  })
})

describe('Config schema (schemastery row validation)', () => {
  it('accepts an empty or absent row (permissive keys, defaults live in resolveConfig)', () => {
    // Schemastery materializes the nested object shells; flat keys stay absent.
    const shells = { switchTo: {}, restoreTo: {}, balanceGuardrail: {} }
    expect(Config(undefined)).toEqual(shells)
    expect(Config({})).toEqual(shells)
  })

  it('accepts a fully-spelled row', () => {
    expect(Config({ enabled: false, pollIntervalMs: 30_000, triggerRatio: 0.5 }).triggerRatio).toBe(0.5)
  })

  it('rejects wrong types (row validation still bites)', () => {
    expect(() => Config({ enabled: 'yes' } as unknown as Config)).toThrow()
    expect(() => Config({ triggerRatio: '99%' } as unknown as Config)).toThrow()
    expect(() => Config({ switchTo: { provider: 7 } } as unknown as Config)).toThrow()
  })
})
