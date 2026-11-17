/**
 * The L2 provider-path probe (design session-revival-v2-alert-inbox-1116,
 * section five): the mandatory gate that decides whether a revival attempt may
 * run at all. Three hard constraints, each a separate failure it prevents:
 *
 * 1. Same egress - the probe goes through the GLOBAL fetch slot, which is the
 *    dispatcher `@deepseek-ai/dsh-http-proxy` installs at host boot (the slot
 *    real model requests read) plus the process proxy env, so a probe that is
 *    green travels the same exit the real request would.
 * 2. Per route - the target is the current route's provider baseURL (resolved
 *    from the llm settings namespaces, wall follows route), never a fixed
 *    reference host.
 * 3. Event driven - the caller only probes while at least one session is
 *    parked, every 60 to 120 seconds (see the interval constants); zero parked
 *    sessions means zero probes.
 *
 * Any HTTP response at all (4xx and 5xx included) proves the path is alive and
 * opens the gate; only a connection-layer failure parks. L1 (TCP reachability
 * of a public reference) exists solely to say "local egress down" versus
 * "provider path down" - it never opens the gate. L3 (a 1-token real call) is
 * deliberately not built: even one input token costs money on output.
 * @module dsh-session-revive/v2-probe
 */

import { connect } from 'node:net'

/** Per-probe ceiling: a dead path must fail fast, not hold the park loop. */
export const PROBE_TIMEOUT_MS = 10_000

/** Lower bound of the parked re-probe cadence (design: 60-120s). */
export const PROBE_MIN_INTERVAL_MS = 60_000

/** Upper bound of the parked re-probe cadence (design: 60-120s). */
export const PROBE_MAX_INTERVAL_MS = 120_000

/**
 * L1 reference target: a domestic host with a stable route, TCP only. Used
 * for attribution text when the L2 probe fails, never for permission.
 */
export const L1_REFERENCE_HOST = 'api.deepseek.com'
export const L1_REFERENCE_PORT = 443
export const L1_TIMEOUT_MS = 5_000

/**
 * Suggested value for the section-eight TODO threshold N: a probe red run
 * longer than this sets `probeRedAlarmed` in the state export. Pending the
 * user ruling (section eight marks N as TODO); the constant lives here so the
 * machine reads one home for it. Two hours keeps a routine outage silent while
 * catching the drift case the design names - a misconfigured route parking
 * every session forever without a sound.
 */
export const PROBE_RED_ALARM_MS = 2 * 60 * 60 * 1000

/** Why a probe failed, after L1 attribution (attribution only, no verdict power). */
export type ProbeAttribution = 'local-egress-down' | 'provider-path-down' | 'route-unresolved' | 'invalid-base-url'

/** One L2 probe outcome. */
export interface ProbeResult {
  /** True when ANY HTTP response came back - 4xx/5xx still means the path is alive. */
  ok: boolean
  /** Response status when a response came back (kept for evidence). */
  status?: number
  /** Milliseconds from request start to response headers (TIMEOUT-class reference). */
  ttfbMs?: number
  /** Connection-layer failure detail when `ok` is false. */
  error?: string
  /** L1 attribution for failures; absent on success. Never grants permission. */
  attribution?: ProbeAttribution
}

/** The fetch shape the probe needs; the host passes global fetch. */
export type ProbeFetch = (
  url: string,
  init: { method: string; signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; body?: { cancel?: () => Promise<unknown> | unknown } | null }>

/**
 * One L2 probe round trip against a route's baseURL.
 *
 * The response body is never read: the status line is the whole answer, so the
 * body is cancelled immediately to free the socket. `fetch` throwing (DNS,
 * TCP, TLS, proxy, timeout) is the only red - a 401 or 404 is green by
 * construction because it proves the route answers.
 * @param baseURL - the route's provider base URL.
 * @param options - injectable fetch/clock for tests; defaults are host-live.
 * @returns the probe outcome.
 */
export async function probeRoute(
  baseURL: string,
  options: { fetchImpl?: ProbeFetch; timeoutMs?: number; now?: () => number } = {},
): Promise<ProbeResult> {
  const now = options.now ?? (() => Date.now())
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as ProbeFetch)
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    return { ok: false, error: `invalid base URL: ${baseURL.slice(0, 120)}`, attribution: 'invalid-base-url' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `non-http scheme: ${url.protocol}`, attribution: 'invalid-base-url' }
  }
  const started = now()
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
      // The probe never parses a body; identity avoids paying for a decoder.
      headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' },
    })
    const ttfbMs = now() - started
    try {
      await response.body?.cancel?.()
    } catch {
      // Cancelling a body the server already closed is harmless.
    }
    return { ok: true, status: response.status, ttfbMs }
  } catch (error) {
    return {
      ok: false,
      ttfbMs: now() - started,
      error: String(error instanceof Error ? error.message : error).slice(0, 200),
    }
  }
}

/**
 * L1 attribution for a failed L2 probe: can this machine still open a TCP
 * connection to a public reference? Answers "local egress down" versus
 * "provider path down" and NOTHING else - the caller never consults this to
 * open the gate (design: L1 has no permission, attribution only).
 * @param options - injectable connect/clock for tests.
 * @returns the attribution label to attach to a red probe record.
 */
export function attributeProbeFailure(
  options: {
    connectFn?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
    host?: string
    port?: number
    timeoutMs?: number
  } = {},
): Promise<ProbeAttribution> {
  const check =
    options.connectFn ?? ((host: string, port: number, timeoutMs: number) => tcpConnects(host, port, timeoutMs))
  return check(options.host ?? L1_REFERENCE_HOST, options.port ?? L1_REFERENCE_PORT, options.timeoutMs ?? L1_TIMEOUT_MS)
    .then((reachable) => (reachable ? 'provider-path-down' : 'local-egress-down'))
    .catch(() => 'local-egress-down')
}

/** Plain TCP connect probe (L1): resolves true only when the handshake lands. */
export function tcpConnects(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** A provider route as the machine tracks it: baseURL resolved per provider. */
export interface ProbeTarget {
  provider: string
  model?: string
  /** Absent means the settings could not resolve a base URL (fail closed). */
  baseURL?: string
}

/** Route key the machine caches probe results under (baseURL is provider-scoped). */
export function routeKey(provider: string): string {
  return provider
}
