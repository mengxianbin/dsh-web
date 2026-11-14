/**
 * Cookie-jar and balance-probe primitives shared by the renew, capture and
 * paste paths: the browser's domain-matching rules in miniature (a cookie is
 * attached when its domain equals the host or is a dot-suffix of it), header
 * assembly in the exact shape the dsh-usage MiMo adapter sends, and the one
 * balance probe every write path runs BEFORE storing — a captured or pasted
 * jar that does not answer /api/v1/balance never reaches the credential
 * store.
 * @module dsh-mimo-relogin/host/probe
 */

/** One host-scoped cookie jar: name → value, exactly what a browser would attach. */
export type Jar = Map<string, string>

/** Cookie values are never logged; callers print these instead. */
export interface BalanceProbe {
  /** HTTP status of the balance request (0 = network failure). */
  status: number
  /** Spendable total when the platform answered with code 0. */
  balance?: string
  /** ISO 4217 currency code alongside the total. */
  currency?: string
}

/** Chrome cookie-domain matching for one target host (leading dot stripped). */
export function domainMatch(cookieDomain: string | undefined, host: string): boolean {
  const domain = String(cookieDomain ?? '').replace(/^\./, '')
  return domain === host || host.endsWith('.' + domain)
}

/** Assemble a Cookie request header from a jar (insertion order retained). */
export function assembleHeader(jar: Jar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * Parse a stored Cookie header string back into a jar. Used for the managed
 * credential value; pairs split on ';' with the FIRST '=' separating name
 * from value (values may contain '=' — base64 padding).
 */
export function jarFromHeader(header: string): Jar {
  const jar: Jar = new Map()
  for (const pair of header.split(';')) {
    const trimmed = pair.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    jar.set(trimmed.slice(0, eq), trimmed.slice(eq + 1))
  }
  return jar
}

/**
 * GET /api/v1/balance with the assembled header — the same endpoint the
 * dsh-usage adapter probes, so a pass here means the stored value will serve
 * the sidebar glance on its next cycle.
 * @param platformUrl - platform origin (trailing slash tolerated).
 * @param jar - host-scoped platform jar.
 * @param fetchImpl - injectable fetch (tests stub the whole chain).
 */
export async function probeBalance(platformUrl: string, jar: Jar, fetchImpl: typeof fetch): Promise<BalanceProbe> {
  const origin = new URL(platformUrl).origin
  try {
    const response = await fetchImpl(`${origin}/api/v1/balance`, {
      headers: { cookie: assembleHeader(jar), accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return { status: response.status }
    const body = await response.json().catch(() => undefined) as { code?: number, data?: { balance?: unknown, currency?: unknown } } | undefined
    if (body?.code !== 0 || typeof body.data !== 'object' || body.data === null) return { status: response.status }
    const { balance, currency } = body.data
    if (typeof balance !== 'string') return { status: response.status }
    return { status: response.status, balance, ...(typeof currency === 'string' ? { currency } : {}) }
  } catch {
    return { status: 0 }
  }
}
