import { describe, expect, it } from 'vitest'
import { fetchGoMeters, MeterError } from '../src/meters.ts'

/** A go/status-shaped body in micro-cents (value / 1e8 = USD). */
function body(overrides: Record<string, unknown> = {}, meters?: unknown): unknown {
  return {
    access: {
      meters: meters ?? {
        fiveHour: { usedMicroCents: 0.3141e8, limitMicroCents: 12e8, resetsAt: '2026-10-24T19:27:10Z' },
        week: { usedMicroCents: 28.77e8, limitMicroCents: 30e8, resetsAt: '2026-10-26T00:00:00Z' },
        month: { usedMicroCents: 32.8685e8, limitMicroCents: 60e8, resetsAt: '2026-11-17T10:29:32Z' },
      },
    },
    ...overrides,
  }
}

function fetchReturning(payload: unknown, status = 200): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    captured.init = init
    return new Response(JSON.stringify(payload), { status })
  }) as unknown as typeof fetch
}

// Holder object: TS control-flow does not track closure assignments on a plain let.
const captured: { init?: RequestInit } = {}

const KEY = 'test-key-not-a-secret'

describe('fetchGoMeters — parsing (unrounded ratios, USD units)', () => {
  it('reads all three windows with unrounded ratios and reset stamps', async () => {
    captured.init = undefined
    const reading = await fetchGoMeters({ url: 'https://example.invalid/status', key: KEY, meterKeyEnv: 'K', fetchImpl: fetchReturning(body()) })
    expect(reading.windows.week).toEqual({
      key: 'week', used: 28.77, limit: 30, ratio: 28.77 / 30, resetsAt: '2026-10-26T00:00:00Z',
    })
    expect(reading.windows.week?.ratio).toBeCloseTo(0.959, 6)
    expect(reading.windows.fiveHour?.ratio).toBeCloseTo(0.0261750, 6)
    expect(reading.windows.month?.limit).toBe(60)
    expect(typeof reading.at).toBe('number')
    const headers = (captured.init as RequestInit | undefined)?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('drops windows whose limit is zero or malformed, keeping the rest', async () => {
    const reading = await fetchGoMeters({
      url: 'u', key: KEY, meterKeyEnv: 'K',
      fetchImpl: fetchReturning(body({}, {
        fiveHour: { usedMicroCents: 1, limitMicroCents: 0 },
        week: { usedMicroCents: 'oops', limitMicroCents: 30e8 },
        month: { usedMicroCents: 5e8, limitMicroCents: 10e8 },
      })),
    })
    expect(reading.windows.fiveHour).toBeUndefined()
    expect(reading.windows.week).toBeUndefined()
    expect(reading.windows.month?.ratio).toBe(0.5)
  })
})

describe('fetchGoMeters — failures never read as zero usage', () => {
  it('fails closed when no usable window survives parsing', async () => {
    await expect(fetchGoMeters({
      url: 'u', key: KEY, meterKeyEnv: 'K',
      fetchImpl: fetchReturning(body({}, { fiveHour: { usedMicroCents: 1, limitMicroCents: 0 } })),
    })).rejects.toThrow(MeterError)
  })

  it('names the env var (never a value) when the key is absent', async () => {
    await expect(fetchGoMeters({ url: 'u', key: undefined, meterKeyEnv: 'OC_GO_CC_API_KEY' }))
      .rejects.toThrow('OC_GO_CC_API_KEY')
    await expect(fetchGoMeters({ url: 'u', key: undefined, meterKeyEnv: 'OC_GO_CC_API_KEY' }))
      .rejects.not.toThrow(/Bearer/)
  })

  it('reports non-200 answers as MeterError with the status only', async () => {
    await expect(fetchGoMeters({ url: 'u', key: KEY, meterKeyEnv: 'K', fetchImpl: fetchReturning({}, 503) }))
      .rejects.toThrow('HTTP 503')
  })

  it('reports a non-JSON body as MeterError', async () => {
    const fetchImpl = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    await expect(fetchGoMeters({ url: 'u', key: KEY, meterKeyEnv: 'K', fetchImpl }))
      .rejects.toThrow('non-JSON')
  })

  it('reports a body without access.meters as MeterError', async () => {
    await expect(fetchGoMeters({ url: 'u', key: KEY, meterKeyEnv: 'K', fetchImpl: fetchReturning({ access: {} }) }))
      .rejects.toThrow('access.meters')
  })

  it('wraps network errors as MeterError', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(fetchGoMeters({ url: 'u', key: KEY, meterKeyEnv: 'K', fetchImpl }))
      .rejects.toThrow('ECONNREFUSED')
  })
})
