/**
 * 宿主上 `dsh-usage` 插件的两条路由，按 `usage.stats` 需要的那一格读出来。
 *
 * 那个插件把台账挂在**同一个** web 服务上（`/api/dsh-usage/overview` 与
 * `/api/dsh-usage/day`，见它的 `host/routes.ts`），所以这里不去进程里找它的服务
 * ——它不发布任何 cordis 服务——而是对本机回环 origin 发一次真正的 GET。路径在这
 * 里重写一遍而不是 import 过来：本包不依赖任何别的插件，能跨过来的只有冻结的路径
 * 字符串。
 *
 * 端口从哪来：先问宿主自己的 `webServer.getOrigin()`（那是它已经绑定的地址，含
 * 协议与端口，也是 `dsh-agents` 那一格用的同一条路）；拿不到时退回
 * `${protocol}//127.0.0.1:${port}` 的监听端口探测。后者只在这台宿主把监听绑在
 * 回环地址上时才连得通，绑到别的网卡上会连不上——那时答案是 `probe-failed`，
 * 而不是一个编出来的读数。
 *
 * 一次读的三种结局：答了、路由不存在、这次没读到。第三种带一句短原因。**404 是
 * 第二种**：那台宿主没挂这个插件，是一件事实；而连接被拒、超时、非 200、读不出
 * JSON 都是第三种。
 * @module dsh-remote-bridge/host/usage-stats
 */

import type { UsageStatsOutcome, UsageStatsTransport } from '../core/usage-stats.ts'

/**
 * 那个插件挂的两条路由；按它的 `USAGE_API_PREFIX` 拼出来。
 */
export const USAGE_OVERVIEW_PATH = '/api/dsh-usage/overview'
export const USAGE_DAY_PATH = '/api/dsh-usage/day'

/** 一次回环读的超时。那个插件从内存里答，这个时限只是不让一次卡住拖住连接。 */
export const USAGE_PROBE_TIMEOUT_MS = 5_000

/** 宿主 web 服务在这条路上要的那两格；结构读取，不导入它的类型。 */
export interface WebServerAddress {
  /** 已经绑定的 origin，形如 `http://127.0.0.1:3080`；监听之前会抛。 */
  getOrigin?(): string
  /** 监听器说的协议，随配置而不是随请求。 */
  readonly protocol?: string
  /** 实际监听的端口（端口写 0 时是系统分配的那个）；绑定之前是 undefined。 */
  readonly port?: number
}

/** 构造 {@link LoopbackUsage} 的全部输入。 */
export interface LoopbackUsageOptions {
  /** 每次读数都重新解析一次：这一行挂载时监听器可能还没有端口。 */
  readonly origin: () => string | undefined
  /** 出站调用的接缝；生产默认是本进程的 `fetch`。 */
  readonly fetch?: typeof fetch
  /** 一次读的超时；默认 {@link USAGE_PROBE_TIMEOUT_MS}。 */
  readonly timeoutMs?: number
  readonly log: (message: string) => void
}

/**
 * 本机 web 服务的 origin。
 *
 * 先问宿主给的那个（它知道自己的绑定地址），拿不到就退回 127.0.0.1 上的监听端口。
 * 两条都不成立时回 undefined，调用方据此答 `probe-failed`。
 * @param server - 宿主 web 服务，可能还没挂载。
 * @returns origin，或者 undefined。
 */
export function hostWebOrigin(server: WebServerAddress | undefined): string | undefined {
  if (server === undefined) return undefined
  try {
    const origin = typeof server.getOrigin === 'function' ? server.getOrigin() : undefined
    if (typeof origin === 'string' && origin !== '') return origin
  } catch {
    // 监听还没绑定：getOrigin() 会抛，落回下面的端口探测。
  }
  const port = server.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return undefined
  return `${server.protocol === 'https:' ? 'https:' : 'http:'}//127.0.0.1:${port}`
}

/** 宿主那两条路由，走本机回环。 */
export class LoopbackUsage implements UsageStatsTransport {
  readonly #options: LoopbackUsageOptions

  /**
   * @param options - origin 解析函数、出站调用与超时。
   */
  constructor(options: LoopbackUsageOptions) {
    this.#options = options
  }

  /**
   * `GET /api/dsh-usage/overview`。
   * @returns 宿主答的那份聚合，或者为什么没读到。
   */
  overview(): Promise<UsageStatsOutcome> {
    return this.#read(USAGE_OVERVIEW_PATH)
  }

  /**
   * `GET /api/dsh-usage/day?date=<day>`。
   * @param day - 本地日期键 `YYYY-MM-DD`。
   * @returns 那一天的台账，或者为什么没读到。
   */
  day(day: string): Promise<UsageStatsOutcome> {
    return this.#read(`${USAGE_DAY_PATH}?date=${encodeURIComponent(day)}`)
  }

  /**
   * 读一条路由。
   *
   * 没有 origin 是「这台宿主没有可寻址的 web 服务」，与插件没挂是两件事，所以它
   * 落在 `failed` 上；只有 404 才落在 `missing` 上。
   * @param path - 以 `/` 开头的路径，含查询串。
   * @returns 读到的那一格。
   */
  async #read(path: string): Promise<UsageStatsOutcome> {
    const origin = this.#origin()
    if (origin === undefined) return { kind: 'failed', reason: 'this host has no web server origin' }
    const call = this.#options.fetch ?? globalThis.fetch
    try {
      const response = await call(`${origin}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.#timeout()),
      })
      // 路由不存在 = 那台宿主没挂这个插件。这是关于宿主的实施事实，不是错误。
      if (response.status === 404) return { kind: 'missing' }
      if (!response.ok) return { kind: 'failed', reason: `HTTP ${response.status}` }
      const body: unknown = await response.json().catch(() => undefined)
      return body === undefined ? { kind: 'failed', reason: 'unrecognized response shape' } : { kind: 'answer', body }
    } catch (error) {
      return { kind: 'failed', reason: shortReason(error) }
    }
  }

  /** 这一次读要用的 origin；解析本身抛错按「没有 origin」处理。 */
  #origin(): string | undefined {
    try {
      return this.#options.origin()
    } catch (error) {
      this.#options.log(`the host web origin could not be resolved: ${shortReason(error)}`)
      return undefined
    }
  }

  /** 一次读的超时。 */
  #timeout(): number {
    return this.#options.timeoutMs ?? USAGE_PROBE_TIMEOUT_MS
  }
}

/**
 * 一句短原因：过线的只有「这次为什么没读到」，不是一整条堆栈。
 * @param error - 抛出来的东西。
 * @returns 至多 120 个字符的一行。
 */
function shortReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.split('\n')[0] ?? text
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}
