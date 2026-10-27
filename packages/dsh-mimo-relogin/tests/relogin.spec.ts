/**
 * Route-level behavior of the MiMo re-login kit, with every external seam
 * injected: the renewal chain replays through a stubbed fetch (the exact
 * 302/307 sequence observed live on 2026-10-27), CDP reads hand back jars,
 * and the credential seam is an in-memory map. The rules under test:
 * loopback fence first; no write without a passing balance probe (account
 * paste excepted — its proof is the renew consuming it); secrets never in
 * hops/reports; refresh poke shapes the response's mimo row.
 */
import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { makeReloginRoutes, type ReloginOptions } from '../src/host/routes.ts'

const OPTIONS: ReloginOptions = {
  chromePath: 'C:/chrome.exe',
  profile: 'D:/profile',
  port: 9224,
  platformUrl: 'https://platform.xiaomimimo.com/',
}

const PLATFORM = 'https://platform.xiaomimimo.com'
const ACCOUNT = 'https://account.xiaomi.com'

interface FakeReqOptions {
  remote?: string
  host?: string
  method?: string
  body?: unknown
}

function fakeReq(options: FakeReqOptions = {}): IncomingMessage {
  const text = options.body === undefined ? '' : JSON.stringify(options.body)
  const stream = Readable.from([Buffer.from(text)]) as unknown as IncomingMessage
  stream.socket = { remoteAddress: options.remote ?? '127.0.0.1' } as never
  stream.headers = { host: options.host ?? '127.0.0.1:3080', 'content-type': 'application/json' }
  stream.method = options.method ?? 'POST'
  return stream
}

interface FakeRes {
  status?: number
  body?: string
  headers?: OutgoingHttpHeaders
  /** The ServerResponse stand-in handlers receive: the SAME object, so writeHead/end land in the fields above. */
  res: ServerResponse
}

function fakeRes(): FakeRes {
  const out: FakeRes = { res: undefined as unknown as ServerResponse }
  const server = {
    writeHead: (status: number, headers?: OutgoingHttpHeaders) => { out.status = status; out.headers = headers; return server },
    end: (chunk?: unknown) => { out.body = chunk === undefined ? '' : String(chunk) },
  }
  out.res = server as unknown as ServerResponse
  return out
}

/** In-memory credential seam: resolve/set/describe over one map. */
function fakeCredentials(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    seam: {
      resolve: async (ref: string) => (store.has(ref) ? { value: store.get(ref) } : undefined),
      set: async (ref: string, value: string) => { store.set(ref, value) },
      describe: async (ref: string) => ({ configured: store.has(ref) }),
    },
  }
}

const PLATFORM_REF = 'MIMO_PLATFORM_COOKIE'
const ACCOUNT_REF = 'MIMO_ACCOUNT_COOKIES'
const STORED_PLATFORM = 'api-platform_serviceToken=old-token; userId=42'
const STORED_ACCOUNT = 'passToken=pass-value; userId=42'

function ctxWith(seam: object | undefined): Context {
  return {
    get: (name: string) => (name === 'credentials' ? seam : undefined),
  } as unknown as Context
}

/** fetch stub replaying the observed chain plus balance/refresh endpoints. */
function renewFetch(overrides: { serviceLogin?: () => Response, balanceStatus?: number } = {}) {
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
      headers.append('set-cookie', 'api-platform_slh=s; Path=/')
      return new Response(null, { status: 307, headers })
    }
    if (url.includes('/console/balance')) {
      return new Response('<html><title>MiMo</title></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    if (url.includes('/api/v1/balance')) {
      const status = overrides.balanceStatus ?? 200
      return new Response(JSON.stringify(status === 200 ? { code: 0, data: { balance: '1.23', currency: 'CNY' } } : { message: 'Unauthorized' }), { status, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/dsh-usage/refresh')) {
      return new Response(JSON.stringify({ providers: [{ provider: 'mimo', balance: { currency: 'CNY', totalBalance: '1.23', updatedAt: 1 } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  })
}

const routeOf = (routes: ReturnType<typeof makeReloginRoutes>, path: string) => {
  const route = routes.find((candidate) => candidate.path === path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  return route
}

describe('mimo-relogin routes', () => {
  it('refuses non-loopback callers before any work', async () => {
    const routes = makeReloginRoutes(ctxWith(undefined), OPTIONS)
    const res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/status').handler(fakeReq({ remote: '10.9.8.7' }), res.res)
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({ ok: false })
  })

  it('reports chrome down and stored flags through status', async () => {
    const { seam } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM })
    const routes = makeReloginRoutes(ctxWith(seam), OPTIONS, { alive: async () => false })
    const res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/status').handler(fakeReq({ method: 'POST' }), res.res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body ?? '{}')).toEqual({ ok: true, chrome: false, stored: { platform: true, account: false } })
  })

  it('renews silently through the ticket chain, rotates the token and pokes the overview', async () => {
    const { seam, store } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM, [ACCOUNT_REF]: STORED_ACCOUNT })
    const fetchImpl = renewFetch()
    const routes = makeReloginRoutes(ctxWith(seam), OPTIONS, { fetchImpl, alive: async () => false })
    const res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/renew').handler(fakeReq(), res.res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body ?? '{}')
    expect(body.ok).toBe(true)
    expect(body.verdict).toBe('ok')
    expect(body.balance).toMatchObject({ status: 200, balance: '1.23', currency: 'CNY' })
    expect(body.mimo).toMatchObject({ provider: 'mimo' })
    // The rotated token landed in the store; the hop list never carries tickets.
    expect(store.get(PLATFORM_REF)).toContain('api-platform_serviceToken=new-token')
    expect(JSON.stringify(body.hops)).not.toContain('ticket')
    expect(body.hops.map((hop: { path: string }) => hop.path)).toContain('/sts')
  }, 20_000)

  it('answers 409 interactive when serviceLogin asks for credentials, storing nothing', async () => {
    const { seam, store } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM, [ACCOUNT_REF]: STORED_ACCOUNT })
    const fetchImpl = renewFetch({
      serviceLogin: () => new Response('<html><input type="password" name="pwd"></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    const routes = makeReloginRoutes(ctxWith(seam), OPTIONS, { fetchImpl, alive: async () => false })
    const res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/renew').handler(fakeReq(), res.res)
    expect(res.status).toBe(409)
    const body = JSON.parse(res.body ?? '{}')
    expect(body.ok).toBe(false)
    expect(body.verdict).toBe('interactive')
    expect(store.get(PLATFORM_REF)).toBe(STORED_PLATFORM)
  }, 20_000)

  it('renew without stored account cookies points at the capture flow', async () => {
    const { seam } = fakeCredentials({ [PLATFORM_REF]: STORED_PLATFORM })
    const routes = makeReloginRoutes(ctxWith(seam), OPTIONS, { alive: async () => false })
    const res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/renew').handler(fakeReq(), res.res)
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body ?? '{}').error).toContain('抓取')
  })

  it('capture stores both jars only after the balance probe passes', async () => {
    const { seam, store } = fakeCredentials()
    const jars = {
      platform: new Map([['api-platform_serviceToken', 'fresh'], ['userId', '42']]),
      account: new Map([['passToken', 'pass-value']]),
    }
    const fetchImpl = renewFetch()
    const routes = makeReloginRoutes(ctxWith(seam), OPTIONS, { fetchImpl, alive: async () => true, readJars: async () => jars })
    const res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/capture').handler(fakeReq(), res.res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body ?? '{}')
    expect(body.ok).toBe(true)
    expect(body.balance).toMatchObject({ balance: '1.23' })
    expect(body.cookies.platform).toContain('api-platform_serviceToken')
    expect(store.get(PLATFORM_REF)).toContain('api-platform_serviceToken=fresh')
    expect(store.get(ACCOUNT_REF)).toContain('passToken=pass-value')
  }, 20_000)

  it('capture fails closed when the harvested jar does not answer the balance probe', async () => {
    const { seam, store } = fakeCredentials()
    const jars = { platform: new Map([['api-platform_serviceToken', 'stale']]), account: new Map() }
    const fetchImpl = renewFetch({ balanceStatus: 401 })
    const routes = makeReloginRoutes(ctxWith(seam), OPTIONS, { fetchImpl, alive: async () => true, readJars: async () => jars })
    const res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/capture').handler(fakeReq(), res.res)
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body ?? '{}').ok).toBe(false)
    expect(store.size).toBe(0)
  }, 20_000)

  it('capture refuses a debug window that never signed in to the platform', async () => {
    const { seam, store } = fakeCredentials()
    const jars = { platform: new Map([['userId', '42']]), account: new Map() }
    const routes = makeReloginRoutes(ctxWith(seam), OPTIONS, { alive: async () => true, readJars: async () => jars })
    const res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/capture').handler(fakeReq(), res.res)
    expect(res.status).toBe(409)
    expect(store.size).toBe(0)
  })

  it('paste validates the slot and the single-line cookie, and gates the platform half on the probe', async () => {
    const { seam, store } = fakeCredentials()
    const routes = makeReloginRoutes(ctxWith(seam), OPTIONS, { fetchImpl: renewFetch(), alive: async () => false })
    // Bad slot.
    let res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/paste').handler(fakeReq({ body: { slot: 'nope', cookie: 'a=b' } }), res.res)
    expect(res.status).toBe(400)
    // Newline smuggling.
    res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/paste').handler(fakeReq({ body: { slot: 'platform', cookie: 'a=b\r\nX: y' } }), res.res)
    expect(res.status).toBe(400)
    // Platform paste failing the probe stores nothing.
    res = fakeRes()
    const badRoutes = makeReloginRoutes(ctxWith(seam), OPTIONS, { fetchImpl: renewFetch({ balanceStatus: 401 }), alive: async () => false })
    await routeOf(badRoutes, '/api/mimo-relogin/paste').handler(fakeReq({ body: { slot: 'platform', cookie: 'api-platform_serviceToken=zz' } }), res.res)
    expect(res.status).toBe(502)
    expect(store.size).toBe(0)
    // Account paste lands without a probe (its proof is renew).
    res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/paste').handler(fakeReq({ body: { slot: 'account', cookie: STORED_ACCOUNT } }), res.res)
    expect(res.status).toBe(200)
    expect(store.get(ACCOUNT_REF)).toBe(STORED_ACCOUNT)
  }, 20_000)

  it('open reports the window mode from the opener seam', async () => {
    const { seam } = fakeCredentials()
    const ensureWindow = vi.fn(async (): Promise<{ mode: 'tab' | 'launched' | 'failed', ready: boolean, error?: string }> => ({ mode: 'launched', ready: false }))
    const routes = makeReloginRoutes(ctxWith(seam), OPTIONS, { ensureWindow, alive: async () => false })
    let res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/open').handler(fakeReq(), res.res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({ ok: true, mode: 'launched', ready: false })
    ensureWindow.mockResolvedValueOnce({ mode: 'failed', ready: false, error: 'spawn refused' })
    res = fakeRes()
    await routeOf(routes, '/api/mimo-relogin/open').handler(fakeReq(), res.res)
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body ?? '{}').ok).toBe(false)
  })
})
