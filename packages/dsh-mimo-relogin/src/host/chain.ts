/**
 * The silent renewal chain (proven live 2026-10-27 against the platform):
 *
 *   GET /api/v1/genLoginUrl            (platform jar)  → 302 | JSON url
 *   GET account.xiaomi.com/pass/serviceLogin (account jar carries passToken)
 *                                             → 302 (NO form while passToken lives)
 *   GET platform /sts?...&ticket=<one-time>   → 307 + Set-Cookie serviceToken (rotated)
 *   GET /console/balance                      → 200 landed
 *   GET /api/v1/balance                       → 200?
 *
 * Fully headless: cookies only, no browser, no interaction. The account jar
 * is the 30-day root credential (passToken); when IT expires the chain lands
 * on the credential form instead and the verdict says `interactive` — that is
 * the once-a-month (or sooner) manual re-login the kit's capture flow covers.
 * All fetches route through the injected fetchImpl so tests replay the chain.
 * @module dsh-mimo-relogin/host/chain
 */
import { ACCOUNT_HOST, PLATFORM_HOST } from './cdp.ts'
import { probeBalance, assembleHeader, type Jar } from './probe.ts'

/** One walked hop, redacted: secret query params never reach logs or reports. */
export interface ChainHop {
  /** Host the request went to. */
  host: string
  /** Path only (query dropped — tickets and signs live there). */
  path: string
  /** HTTP status. */
  status: number
  /** Cookie names this hop set or rotated (values withheld). */
  setCookies?: string[]
}

/** Result of one renewal attempt. */
export interface ChainOutcome {
  /** `ok` = balance answers with the rotated jar; `interactive` = the account host wants a form; `failed`/`no-url` = chain broke (see note). */
  verdict: 'ok' | 'interactive' | 'failed' | 'no-url'
  /** Every hop walked, for the page's debug list. */
  hops: ChainHop[]
  /** Final platform jar (rotated serviceToken when ok). */
  platformJar: Jar
  /** Final account jar (fresh ptn_count etc when the chain touched it). */
  accountJar: Jar
  /** Balance probe against the final jar. */
  balance?: { status: number, balance?: string, currency?: string }
  /** Short diagnosis for a non-ok verdict. */
  note?: string
}

/** Redact secret-shaped query params before any URL reaches a log/report. */
export function redactUrl(raw: string): string {
  return String(raw).replace(
    /([?&](?:code|access_token|refresh_token|id_token|ticket|sign|auth|state|nonce|sid|pwd)=)[^&#]*/gi,
    '$1<redacted>',
  )
}

const LOGIN_FORM_MARKERS = /type=["']password|login-form|serviceLogin/i
const MAX_HOPS = 9

interface RenewOptions {
  /** Platform origin (from config). */
  platformUrl: string
  /** Stored platform jar (its cookies ride genLoginUrl and /sts). */
  platformJar: Jar
  /** Stored account jar (passToken rides serviceLogin). */
  accountJar: Jar
  /** Injectable fetch; defaults to the runtime global. */
  fetchImpl?: typeof fetch
}

const setCookieNames = (headers: Headers, jar: Jar): string[] => {
  const changes: string[] = []
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  for (const line of raw) {
    const match = /^([^=]+)=([^;]*)/.exec(line)
    if (match === null) continue
    const [, name, value] = match
    if (value === '') { jar.delete(name); continue }
    const rotated = jar.has(name) && jar.get(name) !== value
    jar.set(name, value)
    if (rotated || name === 'api-platform_serviceToken' || name === 'passToken') changes.push(`${name}${rotated ? ' (rotated)' : ' (new)'}`)
  }
  return changes
}

/**
 * Walk the full renewal chain once.
 * @param options - platform origin and both stored jars.
 * @returns the outcome with hops, final jars and the balance probe.
 */
export async function renewChain(options: RenewOptions): Promise<ChainOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch
  const origin = new URL(options.platformUrl).origin
  const platformJar = new Map(options.platformJar)
  const accountJar = new Map(options.accountJar)
  const hops: ChainHop[] = []
  const request = (url: string, jar: Jar): Promise<Response> => fetchImpl(url, {
    redirect: 'manual',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      accept: '*/*',
      referer: `${origin}/`,
      ...(jar.size > 0 ? { cookie: assembleHeader(jar) } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  })

  // 1. genLoginUrl — a fresh signed serviceLogin URL (sign is per-request).
  let loginUrl: string | undefined
  const genUrl = `${origin}/api/v1/genLoginUrl?currentPath=%2Fconsole%2Fbalance`
  try {
    const gen = await request(genUrl, platformJar)
    if (gen.status >= 300 && gen.status < 400) {
      const location = gen.headers.get('location')
      if (location !== null) loginUrl = new URL(location, genUrl).href
    } else {
      const text = await gen.text()
      try {
        const body = JSON.parse(text) as { url?: unknown, data?: unknown, loginUrl?: unknown }
        const candidate = typeof body.url === 'string' ? body.url
          : typeof body.loginUrl === 'string' ? body.loginUrl
            : typeof body.data === 'string' ? body.data
              : typeof body.data === 'object' && body.data !== null && typeof (body.data as { url?: unknown }).url === 'string'
                ? (body.data as { url: string }).url : undefined
        if (candidate !== undefined && candidate.includes('serviceLogin')) loginUrl = candidate
      } catch { /* non-json body falls through */ }
    }
  } catch (error) {
    return { verdict: 'no-url', hops, platformJar, accountJar, note: `genLoginUrl unreachable: ${String(error)}` }
  }
  if (loginUrl === undefined) {
    return { verdict: 'no-url', hops, platformJar, accountJar, note: 'genLoginUrl returned no serviceLogin URL (logged in already, or the endpoint needs the platform jar)' }
  }

  // 2. Walk: serviceLogin → /sts → console, host-scoped jars, form detection.
  let url: string | undefined = loginUrl
  for (let i = 0; i < MAX_HOPS && url !== undefined; i++) {
    const target: URL = new URL(url)
    const jar = target.hostname.endsWith(ACCOUNT_HOST) ? accountJar
      : target.hostname.endsWith(PLATFORM_HOST) ? platformJar : new Map<string, string>()
    let response: Response
    try {
      response = await request(target.href, jar)
    } catch (error) {
      return { verdict: 'failed', hops, platformJar, accountJar, note: `hop ${i} unreachable: ${String(error)}` }
    }
    const setCookies = setCookieNames(response.headers, jar)
    hops.push({ host: target.hostname, path: target.pathname, status: response.status, ...(setCookies.length > 0 ? { setCookies } : {}) })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null) return { verdict: 'failed', hops, platformJar, accountJar, note: `hop ${i}: ${response.status} without Location` }
      url = new URL(location, target.href).href
      continue
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/html')) {
      const body = await response.text()
      if (target.hostname === PLATFORM_HOST) break // landed on the console
      if (LOGIN_FORM_MARKERS.test(body)) {
        return { verdict: 'interactive', hops, platformJar, accountJar, note: 'the account host asks for credentials — passToken is gone; log in once through the capture window' }
      }
      continue // intermediate account page — keep walking
    }
    await response.text() // consume non-html bodies
    if (target.hostname === PLATFORM_HOST) break
    return { verdict: 'failed', hops, platformJar, accountJar, note: `hop ${i}: unexpected ${contentType || 'empty'} response on ${target.hostname}` }
  }

  // 3. Balance probe with the rotated jar — the only accepted success proof.
  const balance = await probeBalance(origin, platformJar, fetchImpl)
  if (balance.status !== 200 || balance.balance === undefined) {
    return { verdict: 'failed', hops, platformJar, accountJar, balance, note: `chain walked but the balance probe answered HTTP ${balance.status}` }
  }
  return { verdict: 'ok', hops, platformJar, accountJar, balance }
}
