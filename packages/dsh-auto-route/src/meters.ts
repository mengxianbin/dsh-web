/**
 * Go meter source: absolute micro-cent meters from
 * `GET https://opencode.ai/console/api/go/status` behind a bearer key. The key
 * is read from a named env var into process memory only — it never appears in
 * a log line, a status payload, or an error message. Ratios are computed from
 * the raw micro-cents pair (unrounded), which is the ruling's authoritative
 * trigger source; the overview endpoint's rounded percent is not consulted.
 * @module dsh-auto-route/meters
 */

/** The three windows the 2026-10-24 ruling keys on. */
export const WINDOW_KEYS = ['fiveHour', 'week', 'month'] as const

/** One window identifier. */
export type WindowKey = (typeof WINDOW_KEYS)[number]

/** One absolute window meter. `used`/`limit` are USD; `ratio` is unrounded. */
export interface WindowMeter {
  readonly key: WindowKey
  readonly used: number
  readonly limit: number
  readonly ratio: number
  readonly resetsAt?: string
}

/** One poll's worth of windows plus the time it was taken. */
export interface MeterReading {
  readonly at: number
  readonly windows: Partial<Record<WindowKey, WindowMeter>>
}

/** Meter-source failure (network, status, shape, missing key). Carries no secret. */
export class MeterError extends Error {
  override readonly name = 'MeterError'
}

/** Meter fetch inputs; `fetchImpl` and `now` exist for tests. */
export interface MeterSourceOptions {
  readonly url: string
  /** Bearer key value, or undefined when the env var is absent. */
  readonly key: string | undefined
  /** Env var name (for the missing-key message only, never the value). */
  readonly meterKeyEnv: string
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

/** micro-cents → USD (value / 1e8), matching the ruling's unit note. */
function usd(microCents: number): number {
  return microCents / 1e8
}

/**
 * Parse a micro-cents field into a finite number, else undefined.
 * The live go/status endpoint answers `usedMicroCents`/`limitMicroCents` as
 * JSON **strings** (verified live 2026-10-30), so a bare `typeof` number
 * check silently drops every window and the controller never fires; mirror
 * the dsh-usage adapter's `toNum` coercion so both shapes parse.
 */
function toNum(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Poll the Go meter endpoint once.
 * @param options - URL, bearer key, and test seams.
 * @returns every window the response described with a usable positive limit.
 * @throws MeterError on a missing key, a non-200 answer, an unusable body,
 *   or no window with a positive limit — callers treat that as "no reading",
 *   never as "zero usage".
 */
export async function fetchGoMeters(options: MeterSourceOptions): Promise<MeterReading> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  if (options.key === undefined || options.key === '') {
    throw new MeterError(`meter source key is not set: configure the ${options.meterKeyEnv} environment variable (read into process memory only)`)
  }
  let response: Response
  try {
    response = await fetchImpl(options.url, {
      headers: { authorization: `Bearer ${options.key}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new MeterError(`meter source unreachable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new MeterError(`meter source answered HTTP ${response.status}`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new MeterError('meter source answered a non-JSON body')
  }
  const meters = (body as { access?: { meters?: unknown } } | null)?.access?.meters
  if (typeof meters !== 'object' || meters === null) {
    throw new MeterError('meter source response carried no access.meters')
  }
  const record = meters as Record<string, unknown>
  const windows: Partial<Record<WindowKey, WindowMeter>> = {}
  for (const key of WINDOW_KEYS) {
    const entry = record[key]
    if (typeof entry !== 'object' || entry === null) continue
    const { usedMicroCents, limitMicroCents, resetsAt } = entry as { usedMicroCents?: unknown; limitMicroCents?: unknown; resetsAt?: unknown }
    const used = toNum(usedMicroCents)
    const limit = toNum(limitMicroCents)
    if (used === undefined) continue
    if (limit === undefined || limit <= 0) continue
    windows[key] = {
      key,
      used: usd(used),
      limit: usd(limit),
      ratio: used / limit,
      ...(typeof resetsAt === 'string' ? { resetsAt } : {}),
    }
  }
  if (Object.values(windows).every(window => window === undefined)) {
    throw new MeterError('meter source response carried no window with a positive limit')
  }
  return { at: now(), windows }
}
