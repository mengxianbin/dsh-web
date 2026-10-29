/**
 * The kit's loopback route family: page, status and the four actions (renew /
 * capture / open / paste). Every handler passes the shared loopback fence
 * first; every write path runs the balance probe BEFORE the credential store
 * touches a value (the account paste has no probe — its proof is the renew
 * that consumes it). After a successful store the kit pokes dsh-usage's
 * refresh route on the SAME host the page came from, so the sidebar glance
 * and this page's poll show the new balance within seconds instead of waiting
 * out the60s cycle; a failed poke degrades to the poll (still bounded by the
 * cycle).
 * @module dsh-mimo-relogin/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { isLoopbackRequest } from './loopback.ts'
import { readJsonBody, writeJson } from './http.ts'
import { cdpAlive, readJars, type BrowserJars } from './cdp.ts'
import { performRenew, ACCOUNT_REF, PLATFORM_REF, credentialsOf, type CredentialsSeam } from './renew-core.ts'
import { ensurePlatformWindow, type OpenOutcome } from './chrome.ts'
import { assembleHeader, jarFromHeader, probeBalance, type Jar } from './probe.ts'
import { PAGE_HTML, PAGE_PATH } from './page.ts'

/** Cap for one dsh-usage refresh poke (its worst case probes every provider serially). */
const REFRESH_POKE_TIMEOUT_MS = 30_000
/** Paste cap: a full multi-domain Cookie header stays far below this. */
const PASTE_MAX_CHARS = 16_384

/** Plugin options resolved from Config at apply time (restart to change). */
export interface ReloginOptions {
  /** Chrome executable for the cold-start path. */
  chromePath: string
  /** Dedicated debug profile directory. */
  profile: string
  /** Debug port (chrome-debug convention: 9224). */
  port: number
  /** Platform origin. */
  platformUrl: string
}

/** Injected seams so tests replay the world without CDP or a live dsh. */
export interface ReloginDeps {
  /** Injectable fetch (chain, probes, refresh poke). */
  fetchImpl?: typeof fetch
  /** Jar reader (default: CDP Storage.getCookies). */
  readJars?: (port: number) => Promise<BrowserJars | undefined>
  /** Chrome liveness (default: CDP /json/version). */
  alive?: (port: number) => Promise<boolean>
  /** Window opener (default: attach-or-spawn). */
  ensureWindow?: (options: { chromePath: string, profile: string, port: number, platformUrl: string }) => Promise<OpenOutcome>
  /**
   * Auto-renew hook: a successful manual store (renew / capture / account
   * paste) re-arms a loop paused on an interactive verdict (FORK
   * mimo-relogin-l3). Absent in tests that do not run the loop.
   */
  autoRenew?: { rearm(): void }
}

/** The Host header of a fence-passed request (validated loopback by isLoopbackRequest). */
function hostOf(req: IncomingMessage): string | undefined {
  return typeof req.headers.host === 'string' ? req.headers.host : undefined
}

/** Fence + method gate shared by the action routes. @returns true when the response is already answered. */
function refused(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return true
  }
  if (req.method !== method) {
    writeJson(res, 405, { ok: false, error: 'method not allowed' })
    return true
  }
  return false
}

/**
 * Poke dsh-usage's refresh route on the page's own host and return the mimo
 * provider row of the fresh overview — best effort: any failure returns
 * undefined and the page's poll picks the value up on its next tick.
 */
async function refreshMimoRow(host: string | undefined, fetchImpl: typeof fetch): Promise<Record<string, unknown> | undefined> {
  if (host === undefined) return undefined
  try {
    const response = await fetchImpl(`http://${host}/api/dsh-usage/refresh`, {
      method: 'POST',
      signal: AbortSignal.timeout(REFRESH_POKE_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const overview = await response.json() as { providers?: Array<Record<string, unknown>> }
    return overview.providers?.find((row) => row.provider === 'mimo')
  } catch {
    return undefined
  }
}

/**
 * Build the full loopback route family for the kit.
 * @param ctx - host plugin context (credentials seam + webserver).
 * @param options - resolved plugin config.
 * @param deps - injectable seams for tests.
 * @returns the routes; the caller registers and disposes them.
 */
export function makeReloginRoutes(ctx: Context, options: ReloginOptions, deps: ReloginDeps = {}): WebRoute[] {
  const fetchImpl = deps.fetchImpl ?? fetch
  const readJarsFn = deps.readJars ?? readJars
  const aliveFn = deps.alive ?? cdpAlive
  const ensureWindowFn = deps.ensureWindow ?? ensurePlatformWindow

  const page: WebRoute = {
    kind: 'exact',
    path: PAGE_PATH,
    handler: (req, res): void => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'",
      })
      res.end(PAGE_HTML)
    },
  }

  const status: WebRoute = {
    kind: 'exact',
    path: '/api/mimo-relogin/status',
    handler: async (req, res): Promise<void> => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      const creds = credentialsOf(ctx)
      const [chrome, platform, account] = await Promise.all([
        aliveFn(options.port).catch(() => false),
        creds?.describe(PLATFORM_REF).catch(() => undefined),
        creds?.describe(ACCOUNT_REF).catch(() => undefined),
      ])
      writeJson(res, 200, {
        ok: true,
        chrome,
        stored: { platform: platform?.configured === true, account: account?.configured === true },
      })
    },
  }

  const renew: WebRoute = {
    kind: 'exact',
    path: '/api/mimo-relogin/renew',
    handler: async (req, res): Promise<void> => {
      if (refused(req, res, 'POST')) return
      const result = await performRenew(ctx, options.platformUrl, fetchImpl)
      if (result.status === 'no-credentials') {
        writeJson(res, 503, { ok: false, error: 'credentials service unavailable' })
        return
      }
      if (result.status === 'no-account') {
        writeJson(res, 409, { ok: false, error: '账号凭据未入库——先「打开登录窗」完成登录后点「抓取登录态」（或在下方粘贴账号 Cookie）' })
        return
      }
      if (result.status === 'chain') {
        const status = result.verdict === 'interactive' ? 409 : 502
        writeJson(res, status, { ok: false, verdict: result.verdict, note: result.note, hops: result.hops })
        return
      }
      if (result.status === 'store-error') {
        writeJson(res, 500, { ok: false, error: `credential store write failed: ${result.error}` })
        return
      }
      // A successful manual renew also re-arms a paused auto-renew loop.
      deps.autoRenew?.rearm()
      const mimo = await refreshMimoRow(hostOf(req), fetchImpl)
      writeJson(res, 200, { ok: true, verdict: 'ok', hops: result.hops, balance: result.balance, ...(mimo === undefined ? {} : { mimo }) })
    },
  }

  const capture: WebRoute = {
    kind: 'exact',
    path: '/api/mimo-relogin/capture',
    handler: async (req, res): Promise<void> => {
      if (refused(req, res, 'POST')) return
      const creds = credentialsOf(ctx)
      if (creds === undefined) {
        writeJson(res, 503, { ok: false, error: 'credentials service unavailable' })
        return
      }
      if (!(await aliveFn(options.port).catch(() => false))) {
        writeJson(res, 503, { ok: false, error: '调试窗口未运行——先点「打开登录窗」' })
        return
      }
      let jars: BrowserJars | undefined
      try {
        jars = await readJarsFn(options.port)
      } catch (error) {
        writeJson(res, 502, { ok: false, error: `CDP 读取失败: ${String(error)}` })
        return
      }
      if (jars === undefined || jars.platform.size === 0) {
        writeJson(res, 502, { ok: false, error: '调试窗口没有可读页面或平台 Cookie 为空' })
        return
      }
      if (!jars.platform.has('api-platform_serviceToken')) {
        writeJson(res, 409, { ok: false, error: '调试窗口尚未登录平台——先在窗口里完成登录再抓取' })
        return
      }
      // Fail closed: an unproven jar never reaches the store.
      const probe = await probeBalance(options.platformUrl, jars.platform, fetchImpl)
      if (probe.status !== 200 || probe.balance === undefined) {
        writeJson(res, 502, { ok: false, error: `抓到的 Cookie 未通过余额验证（HTTP ${probe.status}）`, hint: '确认平台页面已落地（能看到余额）后再抓一次' })
        return
      }
      try {
        await creds.set(PLATFORM_REF, assembleHeader(jars.platform))
        await creds.set(ACCOUNT_REF, assembleHeader(jars.account))
      } catch (error) {
        writeJson(res, 500, { ok: false, error: `credential store write failed: ${String(error)}` })
        return
      }
      // A fresh capture re-arms a paused auto-renew loop (new passToken root).
      deps.autoRenew?.rearm()
      const mimo = await refreshMimoRow(hostOf(req), fetchImpl)
      const names = (jar: Jar): string[] => [...jar.keys()]
      writeJson(res, 200, {
        ok: true,
        balance: { status: probe.status, ...(probe.balance === undefined ? {} : { balance: probe.balance }), ...(probe.currency === undefined ? {} : { currency: probe.currency }) },
        cookies: { platform: names(jars.platform), account: names(jars.account) },
        ...(mimo === undefined ? {} : { mimo }),
      })
    },
  }

  const open: WebRoute = {
    kind: 'exact',
    path: '/api/mimo-relogin/open',
    handler: async (req, res): Promise<void> => {
      if (refused(req, res, 'POST')) return
      const outcome = await ensureWindowFn({ chromePath: options.chromePath, profile: options.profile, port: options.port, platformUrl: options.platformUrl })
      writeJson(res, outcome.mode === 'failed' ? 500 : 200, { ok: outcome.mode !== 'failed', ...outcome })
    },
  }

  const paste: WebRoute = {
    kind: 'exact',
    path: '/api/mimo-relogin/paste',
    handler: async (req, res): Promise<void> => {
      if (refused(req, res, 'POST')) return
      const creds = credentialsOf(ctx)
      if (creds === undefined) {
        writeJson(res, 503, { ok: false, error: 'credentials service unavailable' })
        return
      }
      const body = await readJsonBody(req, { objectOnly: true }) as { slot?: unknown, cookie?: unknown } | null
      if (body === null || (body.slot !== 'platform' && body.slot !== 'account') || typeof body.cookie !== 'string'
        || body.cookie.length === 0 || body.cookie.length > PASTE_MAX_CHARS || /[\r\n]/.test(body.cookie)) {
        writeJson(res, 400, { ok: false, error: '请求无效：需要 slot=platform|account 与单行非空 Cookie（≤16KB）' })
        return
      }
      const ref = body.slot === 'platform' ? PLATFORM_REF : ACCOUNT_REF
      // Platform pastes carry the probe gate (same fail-closed rule as capture);
      // the account jar has no direct probe — its proof is the renew that consumes it.
      if (body.slot === 'platform') {
        const probe = await probeBalance(options.platformUrl, jarFromHeader(body.cookie), fetchImpl)
        if (probe.status !== 200 || probe.balance === undefined) {
          writeJson(res, 502, { ok: false, error: `粘贴的 Cookie 未通过余额验证（HTTP ${probe.status}）`, hint: '检查是否复制了完整的平台 Cookie 头（含 api-platform_serviceToken）' })
          return
        }
        try {
          await creds.set(ref, body.cookie)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: `credential store write failed: ${String(error)}` })
          return
        }
        const mimo = await refreshMimoRow(hostOf(req), fetchImpl)
        writeJson(res, 200, { ok: true, slot: body.slot, balance: { status: probe.status, ...(probe.balance === undefined ? {} : { balance: probe.balance }), ...(probe.currency === undefined ? {} : { currency: probe.currency }) }, ...(mimo === undefined ? {} : { mimo }) })
        return
      }
      try {
        await creds.set(ref, body.cookie)
      } catch (error) {
        writeJson(res, 500, { ok: false, error: `credential store write failed: ${String(error)}` })
        return
      }
      // An account paste carries a fresh passToken root — re-arm a paused loop.
      deps.autoRenew?.rearm()
      writeJson(res, 200, { ok: true, slot: body.slot })
    },
  }

  return [page, status, renew, capture, open, paste]
}
