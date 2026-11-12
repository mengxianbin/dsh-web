import { describe, expect, it } from 'vitest'
import { faceValue, formatDay, formatDenomination, voucherData, voucherSerial, TOKENS_PER_WHALE_YUAN } from '../src/client/voucher.ts'
import { adapterFor } from '../src/core/adapters.ts'
import { emptyTotals, type UsageProviderSummary, type UsageWindowSummary } from '../src/core/types.ts'

/**
 * The voucher's pure face: every-provider summation over a usage window with
 * the spend estimate still locked to the priced family, the 1,000,000:1
 * whale-yuan exchange, the banknote denomination formatting, the deterministic
 * serial, and the observed-since day. The canvas draw itself is composition,
 * verified visually.
 */

function row(provider: string, inputTokens: number, calls = 1, cost = 0): UsageProviderSummary {
  return { provider, totals: { ...emptyTotals(), inputTokens, calls, cost }, models: [] }
}

function windowOf(providers: UsageProviderSummary[]): UsageWindowSummary {
  return { from: '2025-12-01', to: '2026-01-01', totals: emptyTotals(), providers }
}

describe('voucherData', () => {
  it('user gets no note for an absent window or a ledger without usage', () => {
    // Given no window at all, an empty window, and a window whose only row is zero
    // When the bank asks for the facts to stamp
    // Then nothing mints, because a zero-token note would be a zero-denomination note
    expect(voucherData(undefined)).toBeUndefined()
    expect(voucherData(windowOf([]))).toBeUndefined()
    expect(voucherData(windowOf([row('kimi-coding', 0)]))).toBeUndefined()
  })

  it('user sees the whole official family fold into one note across its route aliases', () => {
    // Given the catalog alias and the live route of the priced family
    // When the bank mints
    // Then both rows sum into one face value, one call count and one spend estimate
    const data = voucherData(windowOf([
      row('deepseek', 100_000, 3, 1.25),
      row('deepseek-official', 50_000, 2, 0.75),
    ]))
    expect(data).toMatchObject({ tokens: 150_000, calls: 5, cost: 2, from: '2025-12-01', to: '2026-01-01' })
  })

  // Minting used to be the official family plus a hardcoded 'mimo' route id, so
  // a profile whose usage sat on subscription routes saw an empty bank.
  it('user minting from a subscription-only profile gets a note from its own tokens', () => {
    // Given a window whose only usage sits on coding-subscription routes
    // When the bank mints
    // Then the tokens and calls of every provider sum into the face value
    const data = voucherData(windowOf([
      row('kimi-coding', 4_000_000, 30),
      row('zai-coding', 2_000_000, 12),
      row('minimax', 1_000_000, 5),
    ]))
    // And none of the unpriced rows adds anything to the spend estimate
    expect(data).toMatchObject({ tokens: 7_000_000, calls: 47, cost: 0 })
  })

  it('user sees a non-official provider contribute tokens and calls but never spend', () => {
    // Given the official family row beside relay and subscription rows that
    // each carry a non-zero cost, which a priced host would never stamp on them
    const data = voucherData(windowOf([
      row('deepseek-official', 500_000, 1, 0.1),
      row('mimo', 3_000_000, 9, 9.99),
      row('kimi-coding', 500_000, 3, 4.44),
    ]))
    // When the bank mints
    // Then tokens and calls merge across every provider while cost stays the priced family's
    expect(data).toMatchObject({ tokens: 4_000_000, calls: 13, cost: 0.1 })
  })

  // #1772: the account route minted nowhere, so a user signed in to a DeepSeek
  // account saw a permanently empty bank while spending against it.
  it('user on the signed-in account route sees their tokens mint alongside the key route', () => {
    // Given a usage window holding the account route and an official key route
    const data = voucherData(windowOf([
      row('deepseek-account', 12_000_000, 40, 3.5),
      row('deepseek-official', 50_000, 2, 0.75),
    ]))
    // When the bank mints
    // Then the account route counts toward the face value, spend and calls
    expect(data).toMatchObject({ tokens: 12_050_000, calls: 42, cost: 4.25 })
  })

  it('user sees cache tokens count as minted whale yuan', () => {
    // Given a row whose tokens sit entirely in the cache buckets
    const data = voucherData(windowOf([{
      provider: 'deepseek',
      totals: { ...emptyTotals(), inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, calls: 1 },
      models: [],
    }]))
    // When the bank mints
    // Then every bucket joins the face value
    expect(data?.tokens).toBe(100)
  })
})

// #1772 split: minting widens the bank only, so every credential and probe
// decision keeps reading adapterFor(), which stays blind to the ledger.
describe('minting is an accounting decision, not a probe decision', () => {
  it('user mints a gateway route without granting it a credential or balance probe', () => {
    // Given the relay route whose ledger rows now mint
    // When the adapter table is asked what it can probe
    // Then no adapter claims the route, so minting reaches no credential or balance endpoint
    expect(adapterFor('mimo')).toBeUndefined()
    expect(voucherData(windowOf([row('mimo', 1_000_000, 2)]))?.tokens).toBe(1_000_000)
  })
})

describe('faceValue (1,000,000 tokens = 1 whale yuan)', () => {
  it('exchanges at the anti-inflation rate and rounds to whole yuan', () => {
    expect(TOKENS_PER_WHALE_YUAN).toBe(1_000_000)
    expect(faceValue(1_234_567_890)).toBe(1235)
    expect(faceValue(1_086_000_000_000)).toBe(1_086_000)
    expect(faceValue(1_000_000)).toBe(1)
  })

  it('keeps the smallest denomination at 1 instead of a zero note', () => {
    expect(faceValue(42)).toBe(1)
    expect(faceValue(999_999)).toBe(1)
  })
})

describe('formatDenomination', () => {
  it('prints full digits with thousands separators', () => {
    expect(formatDenomination(0)).toBe('0')
    expect(formatDenomination(999)).toBe('999')
    expect(formatDenomination(1234)).toBe('1,234')
    expect(formatDenomination(1_234_567)).toBe('1,234,567')
    expect(formatDenomination(1_234_567_890)).toBe('1,234,567,890')
  })

  it('rounds fractional accumulations away', () => {
    expect(formatDenomination(1234.6)).toBe('1,235')
  })
})

describe('voucherSerial', () => {
  it('derives a deterministic zero-padded serial from the face value', () => {
    expect(voucherSerial(42)).toBe('000000042')
    expect(voucherSerial(123_456_789)).toBe('123456789')
    expect(voucherSerial(1_000_000_000)).toBe('000000000')
    expect(voucherSerial(1_000_000_042)).toBe('000000042')
  })
})

describe('formatDay', () => {
  it('formats the observation start as a deterministic local day', () => {
    expect(formatDay(new Date(2026, 0, 2, 12).getTime())).toBe('2026-01-02')
    expect(formatDay(new Date(2026, 8, 10, 7, 30).getTime())).toBe('2026-09-10')
  })
})
