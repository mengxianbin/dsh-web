/**
 * Minimal CDP client for the chrome-debug instance (127.0.0.1:<cdpPort>):
 * liveness probe, a page-target session for Storage.getCookies, and a
 * browser-target session for Target.createTarget (opening the platform tab
 * without disturbing whichever page the operator is on). Cookie VALUES stay
 * inside the returned jars and are never logged by this module.
 * @module dsh-mimo-relogin/host/cdp
 */
import { domainMatch, type Jar } from './probe.ts'

/** Both cookie domains the kit manages: the platform probe fuel and the account SSO fuel. */
export const PLATFORM_HOST = 'platform.xiaomimimo.com'
export const ACCOUNT_HOST = 'account.xiaomi.com'

const WS_OPEN_TIMEOUT_MS = 8_000
const CALL_TIMEOUT_MS = 15_000

/** The two host-scoped jars read out of the debug browser. */
export interface BrowserJars {
  /** Cookies the browser attaches to the platform host (serviceToken et al). */
  platform: Jar
  /** Cookies the browser attaches to the account host (passToken et al). */
  account: Jar
}

interface CdpTarget {
  type?: string
  webSocketDebuggerUrl?: string
}

/** One live CDP websocket session with promise-style commands. */
export interface CdpSession {
  /** Send a command and resolve with its result (rejects on CDP error/timeout). */
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  /** Close the websocket. */
  close(): void
}

async function cdpGet<T>(port: number, path: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`CDP HTTP ${response.status} on ${path}`)
  return response.json() as Promise<T>
}

/** Whether a debug-port Chrome is listening (the chrome-debug instance). */
export async function cdpAlive(port: number): Promise<boolean> {
  try {
    await cdpGet(port, '/json/version')
    return true
  } catch {
    return false
  }
}

async function openSession(webSocketDebuggerUrl: string): Promise<CdpSession> {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP websocket open timeout')), WS_OPEN_TIMEOUT_MS)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket open failed')) }, { once: true })
  })
  let seq = 0
  const pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
  socket.addEventListener('message', (event) => {
    let message: { id?: number, result?: Record<string, unknown>, error?: { message?: string } } | undefined
    try { message = JSON.parse(String(event.data)) } catch { return }
    if (message === undefined || typeof message.id !== 'number') return
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? `CDP error ${String(message.id)}`))
    else waiter.resolve(message.result ?? {})
  })
  const send = <T,>(method: string, params?: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)) }, CALL_TIMEOUT_MS)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return { send, close: () => { try { socket.close() } catch { /* already closed */ } } }
}

/** Session on the first page target, or undefined when the browser exposes none. */
export async function openPageSession(port: number): Promise<CdpSession | undefined> {
  const pages = (await cdpGet<CdpTarget[]>(port, '/json/list')).filter((target) => target.type === 'page')
  const target = pages[0]
  if (target?.webSocketDebuggerUrl === undefined) return undefined
  return openSession(target.webSocketDebuggerUrl)
}

/**
 * Read both managed jars out of the live browser via Storage.getCookies,
 * split by the target host using Chrome's own domain rules.
 * @param port - the debug port.
 * @returns both jars, or undefined when no page target answers.
 */
export async function readJars(port: number): Promise<BrowserJars | undefined> {
  const session = await openPageSession(port)
  if (session === undefined) return undefined
  try {
    const result = await session.send<{ cookies?: Array<{ name?: string, value?: string, domain?: string }> }>('Storage.getCookies', {
      urls: [`https://${PLATFORM_HOST}/`, `https://${ACCOUNT_HOST}/`],
    })
    const platform: Jar = new Map()
    const account: Jar = new Map()
    for (const cookie of result.cookies ?? []) {
      if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue
      if (domainMatch(cookie.domain, PLATFORM_HOST)) platform.set(cookie.name, cookie.value)
      if (domainMatch(cookie.domain, ACCOUNT_HOST)) account.set(cookie.name, cookie.value)
    }
    return { platform, account }
  } finally {
    session.close()
  }
}

/**
 * Open one new tab at the given URL through the browser-level websocket —
 * a no-op-ish ask when the window already shows the platform (the tab still
 * opens; the operator closes what they do not need).
 * @param port - the debug port.
 * @param url - destination.
 */
export async function openTab(port: number, url: string): Promise<void> {
  const version = await cdpGet<{ webSocketDebuggerUrl?: string }>(port, '/json/version')
  if (version.webSocketDebuggerUrl === undefined) throw new Error('CDP browser websocket missing')
  const session = await openSession(version.webSocketDebuggerUrl)
  try {
    await session.send('Target.createTarget', { url })
  } finally {
    session.close()
  }
}
