/**
 * Canonical tests for the spend display (core/spend.ts): the stored ledger
 * value stays CNY, and the display currency is a rendering decision that can
 * never blank the card (issue #1937).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CNY_PER_USD, DEFAULT_SPEND_DISPLAY, formatSpend, resolveSpendDisplay } from '../src/core/spend.ts'

describe('resolveSpendDisplay', () => {
  it('operator who configured nothing gets the documented CNY default', () => {
    // Given no configured display
    // When the display resolves
    // Then every cost renders in CNY with the documented default rate kept for later switches
    expect(resolveSpendDisplay()).toEqual({ currency: 'CNY', cnyPerUsd: DEFAULT_CNY_PER_USD })
  })

  it('operator who chose USD keeps the chosen rate', () => {
    // Given a configured USD display with a custom rate
    // When the display resolves
    // Then the currency and rate pass through
    expect(resolveSpendDisplay({ currency: 'USD', cnyPerUsd: 7.1 })).toEqual({ currency: 'USD', cnyPerUsd: 7.1 })
  })

  it('operator whose stored rate is unusable gets the default rate instead of a broken card', () => {
    // Given a USD display whose rate is zero, negative, non-finite, or not a number
    for (const cnyPerUsd of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, '7.2']) {
      // When the display resolves
      const display = resolveSpendDisplay({ currency: 'USD', cnyPerUsd })
      // Then the currency is kept and the rate falls back to the documented default
      expect(display).toEqual({ currency: 'USD', cnyPerUsd: DEFAULT_CNY_PER_USD })
    }
  })

  it('operator whose stored currency is unknown reads costs in CNY', () => {
    // Given a display currency that is not one of the supported codes
    // When the display resolves
    // Then it reads as CNY rather than rendering an unsupported symbol
    expect(resolveSpendDisplay({ currency: 'EUR' }).currency).toBe('CNY')
  })
})

describe('formatSpend', () => {
  it('operator reading CNY sees the stored figure unchanged', () => {
    // Given a stored cost and the CNY display
    // When the cost is formatted
    // Then it renders with the yuan symbol and two decimals
    expect(formatSpend(12.34, DEFAULT_SPEND_DISPLAY)).toBe('¥12.34')
  })

  it('operator reading USD sees the same stored cost divided by the configured rate', () => {
    // Given the same stored cost and a USD display at 7.2 CNY per USD
    // When the cost is formatted
    // Then it renders in dollars, and the stored value is untouched
    expect(formatSpend(72, { currency: 'USD', cnyPerUsd: 7.2 })).toBe('$10.00')
  })

  it('operator sees zero rather than a broken figure for an unusable stored cost', () => {
    // Given costs that are not usable amounts
    for (const cost of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      // When they are formatted in either currency
      // Then both render a zero amount instead of NaN or a negative figure
      expect(formatSpend(cost, DEFAULT_SPEND_DISPLAY)).toBe('¥0.00')
      expect(formatSpend(cost, { currency: 'USD', cnyPerUsd: 7.2 })).toBe('$0.00')
    }
  })

  it('operator reading USD with an unusable rate still sees a defined amount', () => {
    // Given a USD display whose rate is zero (a hand-built document, not a resolved one)
    // When the cost is formatted
    // Then the documented default rate applies instead of dividing by zero
    expect(formatSpend(72, { currency: 'USD', cnyPerUsd: 0 })).toBe('$10.00')
  })
})
