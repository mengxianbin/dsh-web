import { describe, expect, it } from 'vitest'
import {
  L1_REFERENCE_HOST,
  L1_REFERENCE_PORT,
  PROBE_MAX_INTERVAL_MS,
  PROBE_MIN_INTERVAL_MS,
  PROBE_RED_ALARM_MS,
  PROBE_TIMEOUT_MS,
  attributeProbeFailure,
  probeRoute,
  routeKey,
  tcpConnects,
  type ProbeFetch,
} from '../src/v2-probe.ts'

/** A fetch double: records the URL, returns the scripted response or throws. */
interface FakeFetch {
  fetch: ProbeFetch
  calls: string[]
  cancelledCount(): number
}

function fakeFetch(behavior: { status?: number; throw?: unknown } = {}): FakeFetch {
  const calls: string[] = []
  let cancelled = 0
  const fetch: ProbeFetch = async (url) => {
    calls.push(url)
    if (behavior.throw !== undefined) throw behavior.throw
    return {
      status: behavior.status ?? 200,
      body: {
        cancel: () => {
          cancelled += 1
        },
      },
    }
  }
  return { fetch, calls, cancelledCount: () => cancelled }
}

describe('L2 probe verdicts (any response = alive)', () => {
  it('treats a 200 as green and records the TTFB', async () => {
    const { fetch, calls, cancelledCount } = fakeFetch({ status: 200 })
    let clock = 1_000
    const result = await probeRoute('https://api.example.com/v1', {
      fetchImpl: fetch,
      now: () => {
        clock += 40
        return clock
      },
    })
    expect(result).toMatchObject({ ok: true, status: 200 })
    expect(result.ttfbMs).toBe(40)
    expect(calls).toEqual(['https://api.example.com/v1'])
    expect(cancelledCount()).toBe(1)
  })

  it('treats 401, 404 and 500 as GREEN: the path answered, the gate opens', async () => {
    for (const status of [401, 404, 500]) {
      const { fetch } = fakeFetch({ status })
      const result = await probeRoute('https://api.example.com/v1', { fetchImpl: fetch })
      expect(result).toMatchObject({ ok: true, status })
      expect(result.attribution).toBeUndefined()
    }
  })

  it('marks only a connection-layer failure red', async () => {
    const { fetch } = fakeFetch({ throw: new TypeError('fetch failed') })
    const result = await probeRoute('https://api.example.com/v1', { fetchImpl: fetch })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('fetch failed')
    // probeRoute attributes nothing itself; L1 attribution is the caller's.
    expect(result.attribution).toBeUndefined()
  })

  it('fails closed on an invalid or non-http base URL without calling fetch', async () => {
    const bad = fakeFetch()
    const invalid = await probeRoute('not a url', { fetchImpl: bad.fetch })
    expect(invalid).toMatchObject({ ok: false, attribution: 'invalid-base-url' })
    const scheme = await probeRoute('ftp://api.example.com/v1', { fetchImpl: bad.fetch })
    expect(scheme).toMatchObject({ ok: false, attribution: 'invalid-base-url' })
    expect(bad.calls).toEqual([])
  })
})

describe('L1 attribution (never grants permission)', () => {
  it('answers provider-path-down when the reference host is reachable', async () => {
    const attribution = await attributeProbeFailure({ connectFn: async () => true })
    expect(attribution).toBe('provider-path-down')
  })

  it('answers local-egress-down when the reference host is unreachable', async () => {
    const attribution = await attributeProbeFailure({ connectFn: async () => false })
    expect(attribution).toBe('local-egress-down')
  })

  it('degrades to local-egress-down when the check itself throws', async () => {
    const attribution = await attributeProbeFailure({
      connectFn: async () => {
        throw new Error('resolver blew up')
      },
    })
    expect(attribution).toBe('local-egress-down')
  })

  it('targets the ruled reference host and port', async () => {
    let seen: { host: string; port: number } | undefined
    await attributeProbeFailure({
      connectFn: async (host, port) => {
        seen = { host, port }
        return true
      },
    })
    expect(seen).toEqual({ host: L1_REFERENCE_HOST, port: L1_REFERENCE_PORT })
  })

  it('tcpConnects resolves false for an unroutable port instead of throwing', async () => {
    await expect(tcpConnects('127.0.0.1', 1, 500)).resolves.toBe(false)
  })
})

describe('cadence and alarm constants (design sections five and eight)', () => {
  it('bounds the parked re-probe cadence to 60-120 seconds', () => {
    expect(PROBE_MIN_INTERVAL_MS).toBe(60_000)
    expect(PROBE_MAX_INTERVAL_MS).toBe(120_000)
    expect(PROBE_MIN_INTERVAL_MS).toBeLessThan(PROBE_MAX_INTERVAL_MS)
  })

  it('keeps the per-probe timeout bounded', () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(PROBE_MIN_INTERVAL_MS)
  })

  it('carries the suggested N (pending user ruling) as a positive threshold', () => {
    expect(PROBE_RED_ALARM_MS).toBeGreaterThan(0)
  })

  it('keys the route cache by provider', () => {
    expect(routeKey('mimo')).toBe('mimo')
  })
})
