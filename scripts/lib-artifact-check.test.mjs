/**
 * Unit tests for the committed-lib fingerprint guard: which files reach a
 * bundle, and that the fingerprint is order-independent and content-sensitive.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprintEntries, isBundledSource } from './lib-artifact-check.mjs'

describe('isBundledSource', () => {
  it('keeps shipped sources', () => {
    assert.equal(isBundledSource('client/index.ts'), true)
    assert.equal(isBundledSource('client/runtime/shell-rendering.ts'), true)
    assert.equal(isBundledSource('reviewed-hooks.generated.ts'), true)
  })

  it('drops tests wherever they sit', () => {
    assert.equal(isBundledSource('client/gameplay-hud.test.tsx'), false)
    assert.equal(isBundledSource('client/work-tick-gate.test.ts'), false)
    assert.equal(isBundledSource('tests/routes.spec.ts'), false)
    assert.equal(isBundledSource('client/tests/helper.ts'), false)
    assert.equal(isBundledSource('gameplay.spec.ts'), false)
  })
})

describe('fingerprintEntries', () => {
  it('is independent of input order', () => {
    const a = fingerprintEntries([['b.ts', '2'], ['a.ts', '1']])
    const b = fingerprintEntries([['a.ts', '1'], ['b.ts', '2']])
    assert.equal(a, b)
  })

  it('tracks content and membership', () => {
    const base = fingerprintEntries([['a.ts', '1']])
    assert.notEqual(base, fingerprintEntries([['a.ts', '2']]))
    assert.notEqual(base, fingerprintEntries([['a.ts', '1'], ['b.ts', '1']]))
    assert.notEqual(base, fingerprintEntries([['b.ts', '1']]))
  })
})
