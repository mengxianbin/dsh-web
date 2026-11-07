import { describe, expect, it, vi } from 'vitest'
import {
  Config,
  DURABILITY_WARN_RE,
  NUDGE_TEXT,
  STOP_CAUSES,
  STAGGER_DEFAULT_MS,
  STAGGER_MIN_MS,
  classifyFailure,
  nudgeTextFor,
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

  it('folds the two stop causes into revive class without touching the ruled REVIVE_CODES literal (design §7.2)', () => {
    expect(new Set(STOP_CAUSES)).toEqual(new Set(['max-tokens', 'durability-flush']))
    expect(classifyFailure('max-tokens')).toBe('revive')
    expect(classifyFailure('durability-flush')).toBe('revive')
    // Case-sensitive on purpose: compaction's MAX_TOKENS is not a stop cause.
    expect(classifyFailure('MAX_TOKENS')).toBe('other')
    // Network codes keep their class.
    expect(classifyFailure('TRANSPORT')).toBe('revive')
    expect(classifyFailure('TIMEOUT')).toBe('revive')
  })
})

describe('cause-tagged nudge texts (design §7.2(4))', () => {
  it('keeps the plain continue for network causes and unknown causes', () => {
    expect(nudgeTextFor('TRANSPORT')).toBe(NUDGE_TEXT)
    expect(nudgeTextFor('TIMEOUT')).toBe(NUDGE_TEXT)
    expect(nudgeTextFor(undefined)).toBe(NUDGE_TEXT)
    expect(nudgeTextFor('QUOTA')).toBe(NUDGE_TEXT)
  })

  it('tells the model to resume the goal first for both stop causes', () => {
    for (const cause of ['max-tokens', 'durability-flush']) {
      const text = nudgeTextFor(cause)
      expect(text).not.toBe(NUDGE_TEXT)
      expect(text).toContain('update_goal action=resume')
      expect(text.startsWith('继续')).toBe(true)
    }
    expect(nudgeTextFor('max-tokens')).toContain('token 上限')
    expect(nudgeTextFor('durability-flush')).toContain('检查点')
  })
})

describe('durability warn signature (design §7.1)', () => {
  it('captures the agent id from the exact driver warn line and ignores everything else', () => {
    const line =
      'goal-round-driver: durability checkpoint failed for agent "f9e3c2d1-0000-4000-8000-1234567890ab": Error: disk full'
    const hit = DURABILITY_WARN_RE.exec(line)
    expect(hit?.[1]).toBe('f9e3c2d1-0000-4000-8000-1234567890ab')
    expect(DURABILITY_WARN_RE.test('dsh-session-revive {"mode":"shadow"}')).toBe(false)
    expect(DURABILITY_WARN_RE.test('goal-round-driver: armed a session')).toBe(false)
  })
})
