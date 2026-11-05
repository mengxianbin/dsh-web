import { describe, expect, it, vi } from 'vitest'
import {
  Config,
  STAGGER_DEFAULT_MS,
  STAGGER_MIN_MS,
  classifyFailure,
  resolveConfig,
} from '../src/config.ts'

describe('resolveConfig', () => {
  it('defaults to shadow mode so the plugin only logs until the switch flips', () => {
    expect(resolveConfig({})).toEqual({ enabled: true, mode: 'shadow', staggerMs: STAGGER_DEFAULT_MS })
  })

  it('keeps an explicit switch and a compliant stagger without warning', () => {
    const warn = vi.fn()
    expect(resolveConfig({ enabled: false, mode: 'live', staggerMs: 30_000 }, warn)).toEqual({
      enabled: false,
      mode: 'live',
      staggerMs: 30_000,
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('clamps a stagger below the10s design floor and reports it', () => {
    const warn = vi.fn()
    expect(resolveConfig({ staggerMs: 1_000 }, warn).staggerMs).toBe(STAGGER_MIN_MS)
    expect(warn).toHaveBeenCalledWith(1_000, STAGGER_MIN_MS)
    expect(resolveConfig({ staggerMs: Number.NaN }, vi.fn()).staggerMs).toBe(STAGGER_MIN_MS)
    expect(resolveConfig({ staggerMs: STAGGER_MIN_MS }, vi.fn()).staggerMs).toBe(STAGGER_MIN_MS)
  })
})

describe('Config schema', () => {
  it('validates the shape and rejects an unknown mode', () => {
    expect(() => Config({})).not.toThrow()
    expect(() => Config({ mode: 'live' })).not.toThrow()
    expect(() => Config({ mode: 'auto' } as unknown as Parameters<typeof Config>[0])).toThrow()
    expect(() => Config({ staggerMs: 'fast' } as unknown as Parameters<typeof Config>[0])).toThrow()
  })
})

describe('classifyFailure', () => {
  it('maps revive-class codes, the design wall list and its categories, and the rest', () => {
    expect(classifyFailure('TRANSPORT')).toBe('revive')
    expect(classifyFailure('TIMEOUT')).toBe('revive')
    for (const code of [
      // design §4.2 literal list
      'QUOTA',
      'AUTH',
      'INVALID_REQUEST',
      'MALFORMED_RESPONSE',
      'NO_ADAPTER',
      'UNKNOWN_MODEL',
      'content_filter',
      // model-config and auth families behind those category labels
      'MODEL_UNSUPPORTED',
      'INVALID_CONFIG',
      'INVALID_CREDENTIAL',
      'ACCOUNT_SIGN_IN_REQUIRED',
    ]) {
      expect(classifyFailure(code)).toBe('wall')
    }
    // Codes outside both lists are observed but never revived and never suspend.
    for (const code of ['PI_AI_ERROR', 'RATE_LIMIT', 'SERVER', 'ABORTED', 'UNKNOWN']) {
      expect(classifyFailure(code)).toBe('other')
    }
  })
})
