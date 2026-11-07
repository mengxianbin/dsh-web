import { describe, expect, it, vi } from 'vitest'
import {
  Config,
  DURABILITY_WARN_RE,
  NUDGE_TEXT,
  REVIVE_CODES,
  STOP_CAUSES,
  STAGGER_DEFAULT_MS,
  STAGGER_MIN_MS,
  WALL_CODES,
  classifyFailure,
  conditionOverrideNotice,
  nudgeTextFor,
  resolveConfig,
} from '../src/config.ts'

describe('resolveConfig', () => {
  it('defaults to shadow mode so the plugin only logs until the switch flips', () => {
    expect(resolveConfig({})).toEqual({
      enabled: true,
      mode: 'shadow',
      staggerMs: STAGGER_DEFAULT_MS,
      conditions: { revive: REVIVE_CODES, wall: WALL_CODES },
      conditionOverrides: [],
    })
  })

  it('keeps an explicit switch and a compliant stagger without warning', () => {
    const warn = vi.fn()
    expect(resolveConfig({ enabled: false, mode: 'live', staggerMs: 30_000 }, warn)).toEqual({
      enabled: false,
      mode: 'live',
      staggerMs: 30_000,
      conditions: { revive: REVIVE_CODES, wall: WALL_CODES },
      conditionOverrides: [],
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

  it('accepts condition-list arrays and rejects a non-array list', () => {
    expect(() => Config({ reviveCodes: ['TRANSPORT'] })).not.toThrow()
    expect(() => Config({ wallCodes: ['QUOTA'] })).not.toThrow()
    expect(() => Config({ reviveCodes: 'TRANSPORT' } as unknown as Parameters<typeof Config>[0])).toThrow()
  })
})

describe('condition lists (拍板账⑨ 条件清单配置化)', () => {
  it('keeps the code defaults word-for-word equal to the ruled design values', () => {
    expect(new Set(REVIVE_CODES)).toEqual(new Set(['TRANSPORT', 'TIMEOUT']))
    expect(new Set(WALL_CODES)).toEqual(
      new Set([
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
        'INVALID_MODEL_CONTEXT',
        'INVALID_MODEL_INFO',
        'INVALID_MODEL_MAX_TOKENS',
        'INVALID_MODEL_REASONING',
        'INVALID_CREDENTIAL',
        'MISSING_CREDENTIAL',
        'ACCOUNT_SIGN_IN_REQUIRED',
        'ACCOUNT_TOKEN_INVALID',
      ]),
    )
    // Unconfigured = the ruled sets themselves, identity-equal (zero behavior diff).
    const resolved = resolveConfig({})
    expect(resolved.conditions.revive).toBe(REVIVE_CODES)
    expect(resolved.conditions.wall).toBe(WALL_CODES)
    expect(resolved.conditionOverrides).toEqual([])
    expect(conditionOverrideNotice(resolved)).toBeUndefined()
  })

  it('replaces a list wholesale from profile config and records which key overrode', () => {
    const resolved = resolveConfig({ reviveCodes: ['A', 'B'] })
    expect([...resolved.conditions.revive]).toEqual(['A', 'B'])
    expect(resolved.conditions.wall).toBe(WALL_CODES) // sibling list untouched
    expect(resolved.conditionOverrides).toEqual(['reviveCodes'])
    const both = resolveConfig({ reviveCodes: ['X'], wallCodes: ['QUOTA'] })
    expect([...both.conditions.revive]).toEqual(['X'])
    expect([...both.conditions.wall]).toEqual(['QUOTA'])
    expect(both.conditionOverrides).toEqual(['reviveCodes', 'wallCodes'])
  })

  it('builds the loud override notice with effective and ruled lists side by side', () => {
    const notice = conditionOverrideNotice(resolveConfig({ reviveCodes: ['A'] }))
    expect(notice).toBeDefined()
    expect(notice).toContain('reviveCodes')
    expect(notice).toContain('effective revive=[A]')
    expect(notice).toContain('ruled defaults revive=[TRANSPORT,TIMEOUT]')
    expect(notice).toContain('§4.1')
  })

  it('classifies against the effective lists; stop causes stay code-ruled', () => {
    const custom = { revive: new Set(['WEIRD']), wall: new Set(['BLOCKED']) }
    expect(classifyFailure('WEIRD', custom)).toBe('revive')
    expect(classifyFailure('BLOCKED', custom)).toBe('wall')
    expect(classifyFailure('QUOTA', custom)).toBe('other') // replaced wall list
    expect(classifyFailure('TRANSPORT', custom)).toBe('other') // replaced revive list
    // The §7 triage ruling is not configurable: stop causes fold regardless.
    expect(classifyFailure('max-tokens', custom)).toBe('revive')
    expect(classifyFailure('durability-flush', { revive: new Set(), wall: new Set() })).toBe('revive')
    // The default argument keeps the ruled behavior for every un-configured call.
    expect(classifyFailure('QUOTA')).toBe('wall')
    expect(classifyFailure('TRANSPORT')).toBe('revive')
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
