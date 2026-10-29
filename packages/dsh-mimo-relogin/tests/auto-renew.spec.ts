/**
 * The resident auto-renew loop (L3 self-heal), replayed entirely through
 * injected seams: the chain walks through a stubbed fetch (the exact
 * 302/307 sequence observed live on 2026-10-27), the timer is a recording
 * stub, and the log is captured. The rules under test:
 * - first attempt fires after the startup grace, then one per interval,
 *   clamped to a 24h floor whatever Config asks for;
 * - `ok` rotates and stores both jars (the shared renew core, fail-closed);
 * - `interactive` (passToken gone) PAUSES the loop — no further attempt is
 *   scheduled — until `rearm()` after a manual store;
 * - `failed` / missing credentials stay visible (warn/error log) and keep
 *   the cadence without hammering;
 * - dispose cancels the pending attempt.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { startAutoRenew, type AutoRenewLogLevel } from '../src/host/auto-renew.ts'
import { performRenew, ACCOUNT_REF, PLATFORM_REF } from '../src/host/renew-core.ts'

const OPTIONS = { platformUrl: 'https://platform.xiaomimimo.com/', intervalMs: 86_400_000 }

const PLATFORM = 'https://platform.xiaomimimo.com'
const ACCOUNT = 'https://account.xiaomi.com'

const STORED_PLATFORM = 'api-platform_serviceToken=old-token; userId=42'
const STORED_ACCOUNT = 'passToken=pass-value; userId=42'

/** In-memory credential seam: resolve/set/describe over one map. */
function fakeCredentials(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    seam: {
      resolve: async (ref: string) => (store.has(ref) ? { value: store.get(ref) } : undefined),
      set: async (ref: string, value: string) => { store.set(ref, value) },
      describe: async () => ({ configured: true }),
    },
  }
}

function ctxWith(seam: object | undefined): Context {
  return {
    get: (name: string) => (name === 'credentials' ? seam : undefined),
  } as unknown as Context
}

/** fetch stub replaying the observed chain plus the balance endpoint. */
function renewFetch(overrides: { serviceLogin?: () => Response } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? (input.url) : input)
    if (url.includes('/api/v1/genLoginUrl')) {
      return new Response(null, { status: 302, headers: { location: `${ACCOUNT}/pass/serviceLogin?callback=x` } })
    }
    if (url.includes('/pass/serviceLogin')) {
      if (overrides.serviceLogin) return overrides.serviceLogin()
      return new Response(null, { status: 302, headers: { location: `${PLATFORM}/sts?ticket=one-time` } })
    }
    if (url.includes('/sts')) {
      const headers = new Headers({ location: `${PLATFORM}/console/balance` })
      headers.append('set-cookie', 'api-platform_serviceToken=new-token; Path=/; HttpOnly')
      return new Response(null, { status: 307, headers })
    }
    if (url.includes('/console/balance')) {
      return new Response('<html><title>MiMo</title></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    if (url.includes('/api/v1/balance')) {
      return new Response(JSON.stringify({ code: 0, data: { balance: '1.23', currency: 'CNY' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  })
}

/** A recording timer seam: each scheduled attempt is captured, never fired. */
function fakeTimers() {
  const scheduled: Array<{ fn: () => void, ms: number }> = []
  const cancelled: Array<() => void> = []
  return {
    scheduled,
    cancelled,
    schedule: (fn: () => void, ms: number) => {
      const entry = { fn, ms }
      scheduled.push(entry)
      return () => { cancelled.push(entry.fn as () => void) }
    },
    /** Fire a pending attempt and drain the async cycle it kicks off. */
    async fire(index = 0): Promise<void> {
      const entry = scheduled[index]
      if (entry === undefined) throw new Error(`no scheduled attempt at ${index}`)
      entry.fn()
      // The scheduled fn voids its cycle; every stubbed fetch resolves
      // immediately, so one macrotask hop drains the whole microtask chain.
      await new Promise((resolve) => { setImmediate(resolve) })
    },
  }
}

function fakeLog() {
  const lines: Array<{ level: AutoRenewLogLevel, message: string }> = []
  return {
    lines,
    log: (level: AutoRenewLogLevel, message: string) => { lines.push({ level, message }) },
    text: (): string => lines.map((line) => `${line.level}: ${line.message}`).join('\n'),
  }
}

describe('startAutoRenew', () => {
  it('arms with a startup grace, then renews on the interval: stores the rotated jar and logs ok', async () => {
    const { seam, store } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM, [ACCOUNT_REF]: STORED_ACCOUNT })
    const timers = fakeTimers()
    const logger = fakeLog()
    const fetchImpl = renewFetch()
    startAutoRenew(ctxWith(seam), { ...OPTIONS, startupDelayMs: 5_000 }, { fetchImpl, ...timers, ...logger })

    // Armed line names both delays; the first attempt waits out the grace.
    expect(logger.lines[0]?.level).toBe('info')
    expect(logger.lines[0]?.message).toContain('first attempt in 5s')
    expect(logger.lines[0]?.message).toContain('every 24h')
    expect(timers.scheduled).toHaveLength(1)
    expect(timers.scheduled[0]?.ms).toBe(5_000)

    await timers.fire()
    // The rotated serviceToken landed in the store (shared renew core).
    expect(store.get(PLATFORM_REF)).toContain('api-platform_serviceToken=new-token')
    expect(logger.text()).toContain('ok: serviceToken rotated')
    expect(logger.text()).toContain('balance 1.23 CNY')
    // Exactly one follow-up attempt, one full interval out.
    expect(timers.scheduled).toHaveLength(2)
    expect(timers.scheduled[1]?.ms).toBe(86_400_000)
  })

  it('clamps the cadence to a 24h floor whatever the config asks for', async () => {
    const { seam } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM, [ACCOUNT_REF]: STORED_ACCOUNT })
    const timers = fakeTimers()
    const logger = fakeLog()
    const fetchImpl = renewFetch()
    startAutoRenew(ctxWith(seam), { ...OPTIONS, intervalMs: 3_600_000, startupDelayMs: 1_000 }, { fetchImpl, ...timers, ...logger })
    // The arming line already reports the clamped cadence…
    expect(logger.lines[0]?.message).toContain('every 24h')
    // …and the reschedule after the first attempt honours the floor too.
    await timers.fire()
    expect(timers.scheduled[1]?.ms).toBe(86_400_000)
  })

  it('pauses on verdict interactive — no retry until rearm() re-arms it', async () => {
    const { seam, store } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM, [ACCOUNT_REF]: STORED_ACCOUNT })
    const timers = fakeTimers()
    const logger = fakeLog()
    const fetchImpl = renewFetch({
      // The account host asks for credentials: passToken is gone.
      serviceLogin: () => new Response('<html><input type="password" name="pwd"></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    const handle = startAutoRenew(ctxWith(seam), OPTIONS, { fetchImpl, ...timers, ...logger })

    await timers.fire()
    expect(store.get(PLATFORM_REF)).toBe(STORED_PLATFORM) // nothing stored
    expect(logger.text()).toContain('PAUSED: passToken expired (verdict interactive)')
    // No follow-up attempt was scheduled: the loop is latched off.
    expect(timers.scheduled).toHaveLength(1)
    // rearm() (wired to the manual store routes) schedules the next attempt.
    handle.rearm()
    expect(timers.scheduled).toHaveLength(2)
    expect(timers.scheduled[1]?.ms).toBe(86_400_000)
    expect(logger.text()).toContain('re-armed after a successful manual credential store')
  })

  it('skips with a visible warning when no account cookies are stored, keeping the cadence', async () => {
    const { seam } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM })
    const timers = fakeTimers()
    const logger = fakeLog()
    const fetchImpl = renewFetch()
    startAutoRenew(ctxWith(seam), OPTIONS, { fetchImpl, ...timers, ...logger })

    await timers.fire()
    expect(fetchImpl).not.toHaveBeenCalled() // never reached the platform
    expect(logger.lines.some((line) => line.level === 'warn' && line.message.includes('no account cookies stored'))).toBe(true)
    expect(timers.scheduled).toHaveLength(2)
    expect(timers.scheduled[1]?.ms).toBe(86_400_000)
  })

  it('logs a broken chain as an error and keeps the interval (no hammering)', async () => {
    const { seam } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM, [ACCOUNT_REF]: STORED_ACCOUNT })
    const timers = fakeTimers()
    const logger = fakeLog()
    // genLoginUrl never answers → verdict no-url.
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    startAutoRenew(ctxWith(seam), OPTIONS, { fetchImpl: fetchImpl as unknown as typeof fetch, ...timers, ...logger })

    await timers.fire()
    expect(logger.lines.some((line) => line.level === 'error' && line.message.includes('failed (no-url)'))).toBe(true)
    expect(timers.scheduled).toHaveLength(2)
    expect(timers.scheduled[1]?.ms).toBe(86_400_000)
  })

  it('dispose cancels the pending attempt and the loop stops for good', async () => {
    const { seam } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM, [ACCOUNT_REF]: STORED_ACCOUNT })
    const timers = fakeTimers()
    const logger = fakeLog()
    const fetchImpl = renewFetch()
    const handle = startAutoRenew(ctxWith(seam), OPTIONS, { fetchImpl, ...timers, ...logger })

    handle.dispose()
    expect(timers.cancelled).toHaveLength(1)
    // rearm() after dispose stays a no-op (nothing reschedules).
    handle.rearm()
    expect(timers.scheduled).toHaveLength(1)
  })
})

describe('performRenew (shared core)', () => {
  it('stores both jars only on an ok verdict and reports the balance', async () => {
    const { seam, store } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM, [ACCOUNT_REF]: STORED_ACCOUNT })
    const result = await performRenew(ctxWith(seam), OPTIONS.platformUrl, renewFetch())
    expect(result.status).toBe('ok')
    expect(store.get(PLATFORM_REF)).toContain('new-token')
    expect(store.get(ACCOUNT_REF)).toContain('passToken=pass-value')
    if (result.status === 'ok') expect(result.balance).toMatchObject({ status: 200, balance: '1.23' })
  })

  it('reports no-account without touching the platform or the store', async () => {
    const { seam, store } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM })
    const fetchImpl = renewFetch()
    const result = await performRenew(ctxWith(seam), OPTIONS.platformUrl, fetchImpl)
    expect(result).toEqual({ status: 'no-account' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.get(PLATFORM_REF)).toBe(STORED_PLATFORM)
  })

  it('maps an interactive verdict through without storing', async () => {
    const { seam, store } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM, [ACCOUNT_REF]: STORED_ACCOUNT })
    const fetchImpl = renewFetch({
      serviceLogin: () => new Response('<html><input type="password"></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    const result = await performRenew(ctxWith(seam), OPTIONS.platformUrl, fetchImpl)
    expect(result.status).toBe('chain')
    if (result.status === 'chain') expect(result.verdict).toBe('interactive')
    expect(store.get(PLATFORM_REF)).toBe(STORED_PLATFORM)
  })
})
