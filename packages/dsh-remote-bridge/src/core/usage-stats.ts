/**
 * `usage.stats` 的应答：宿主自己那份按天记的 token 台账的聚合。
 *
 * 这一半与 `usage.ts` 的两半有一个根本区别：那两半读的是本进程自己的事实，这一半
 * 读的是另一个插件（`dsh-usage`）挂在这个宿主上的 HTTP 路由。所以它的缺席方式也
 * 不同——宿主根本没挂那个插件是一件关于这台 Mac 的事实（`no-usage-plugin`），
 * 不是错误；而路由取不到、形状不符、超时才是 `probe-failed`。
 *
 * 两条铁律贯穿本模块：
 *
 * - 永不编 0。五个桶在一行里恒在，但那说的是「这一行读到过」：一次没读到的聚合
 *   回 `probe-failed` 并带上短原因，绝不拿上一轮的值冒充这一轮。日历上某一天宿主
 *   台账里没有条目，是那一天确实没有用量——宿主自己的 `/day` 路由对这种日子答的
 *   也是全 0，所以按 0 收是转述，不是编造。
 * - 宿主侧 30 秒一次。同一份聚合数据在一个窗口内最多读一次，并发调用合并成一次：
 *   台账是这台 Mac 的事实，一部手机重复问不该让宿主多读一遍。
 *
 * 读的是两条路由（都在那个插件的 `/api/dsh-usage` 前缀下）：`GET /overview` 一次
 * 给出今天、最近 30 个有记录的日子的台账、以及观测花费；`GET /day?date=YYYY-MM-DD`
 * 补一天。所以一次聚合是 1 + K 次本机回环读，K 只在请求的窗口比 `/overview` 自带的
 * 那一截更深、或本月台账被那一截截断时才不为 0。
 * @module dsh-remote-bridge/core/usage-stats
 */

import { failureText } from './gateway-errors.ts'

/** 省略 `days` 时回多少天。 */
export const STATS_DAYS_DEFAULT = 14

/** 一次最多回多少天：再往上按这个数收。 */
export const STATS_DAYS_MAX = 60

/** 同一份聚合数据在这个窗口内最多读一次（本桥这一侧）。 */
export const STATS_CACHE_TTL_MS = 30_000

/** 最多记住几个不同窗口的聚合；一次开屏通常只问一个。 */
export const STATS_CACHE_LIMIT = 8

/** 一天有多少毫秒；日期加减一律走 UTC，免得夏令时把一天算成 23 或 25 小时。 */
const DAY_MS = 86_400_000

/** 一次读数里的一行：五个互不重叠的 token 桶，未用即真实的 0。 */
export interface UsageBuckets {
  /** 未命中缓存的输入 token。 */
  readonly input: number
  /** 输出 token（含推理）。 */
  readonly output: number
  /** 命中缓存的输入 token。 */
  readonly cacheRead: number
  /** 写入缓存的 token。 */
  readonly cacheWrite: number
  /** 推理 token，provider 报过才有。 */
  readonly reasoning: number
}

/** 按天的一行：日期键 `YYYY-MM-DD` 加上五个桶。 */
export interface UsageDayBucket extends UsageBuckets {
  /** 本地日期键 `YYYY-MM-DD`。 */
  readonly day: string
}

/** 观测到的真实花费：官方账户余额的下降累计，CNY 口径。 */
export interface UsageObservedSpend {
  /** 累计花费，元。 */
  readonly cny: number
  /** 这次累计起点的那次余额观测时刻（epoch ms）。 */
  readonly since: number
}

/** `usage.stats` 读得到时回的那一份。 */
export interface UsageStatsView {
  /** 宿主拼这份聚合的时刻（epoch ms），不是本桥答话的时刻。 */
  readonly updatedAt: number
  /** 宿主本地的今天。 */
  readonly today: UsageBuckets
  /** 宿主本地的本月，从 1 号到今天的累计。 */
  readonly month: UsageBuckets
  /** 请求的窗口内按日期升序的一天一行，最多 `days` 条。 */
  readonly days: UsageDayBucket[]
  /** 宿主有观测花费时才有这个键。 */
  readonly observedSpend?: UsageObservedSpend
}

/** 读不到时回的那一份：为什么读不到，不是错误码。 */
export interface UsageStatsUnsupported {
  /**
   * `no-usage-plugin` —— 这台宿主没挂 `dsh-usage`（关于这台 Mac 的事实）；
   * `probe-failed` —— 路由取不到、形状不符或超时。
   */
  readonly unsupported: 'no-usage-plugin' | 'probe-failed'
  /** 短原因，只给 `probe-failed`。 */
  readonly reason?: string
}

/** `usage.stats` 的应答体。 */
export type UsageStatsAnswer = UsageStatsView | UsageStatsUnsupported

/**
 * 一次宿主路由读数的结果。
 *
 * `missing` 单独一格，是因为「路由不存在」与「路由答了错」在协议里是两个答案：
 * 前者说明那台宿主没挂插件，后者说明这次没读到。
 */
export type UsageStatsOutcome =
  | { readonly kind: 'answer'; readonly body: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly reason: string }

/** 宿主那两条路由，按本模块需要的那一格给出来。 */
export interface UsageStatsTransport {
  /** `GET /api/dsh-usage/overview`。 */
  overview(): Promise<UsageStatsOutcome>
  /**
   * `GET /api/dsh-usage/day?date=<day>`。
   * @param day - 本地日期键 `YYYY-MM-DD`。
   */
  day(day: string): Promise<UsageStatsOutcome>
}

/** 构造 {@link UsageStatsReader} 的全部输入。 */
export interface UsageStatsReaderOptions {
  /** 每次读数都重新解析一次；晚挂载的宿主路由因此也能被读到。 */
  readonly transport: () => UsageStatsTransport | undefined
  /** 缓存窗口读的时钟。 */
  readonly now: () => number
  /** 读不到时的落点。 */
  readonly log: (message: string) => void
  /** 缓存窗口；默认 {@link STATS_CACHE_TTL_MS}。 */
  readonly ttlMs?: number
}

/** 一次聚合里本模块用到的几格，读过形状之后。 */
interface OverviewFacts {
  readonly updatedAt: number
  readonly todayKey: string
  readonly today: UsageBuckets
  readonly rows: Map<string, UsageBuckets>
  readonly availableDays: readonly string[]
  readonly observedSpend?: UsageObservedSpend
}

/**
 * `usage.stats` 背后的读服务，一个宿主一份、所有连接共享。
 *
 * 缓存与合并都按窗口值分开放：两个客户端问 14 天和问 30 天是两份不同的聚合，但
 * 它们各自的窗口内都不会让宿主多读一遍。
 */
export class UsageStatsReader {
  readonly #options: UsageStatsReaderOptions
  readonly #cache = new Map<number, { readonly at: number; readonly answer: UsageStatsAnswer }>()
  readonly #inFlight = new Map<number, Promise<UsageStatsAnswer>>()

  /**
   * @param options - 宿主路由的解析函数、时钟与日志。
   */
  constructor(options: UsageStatsReaderOptions) {
    this.#options = options
  }

  /**
   * 一个窗口的用量聚合。
   *
   * 窗口值先收进 `[1, 60]`：省下的天数与超出的天数都不是客户端能定的，而「问 1000
   * 天」不该让本桥去翻 1000 个日历。
   * @param days - 要多少天。
   * @returns 读到的那一份，或者为什么读不到。
   */
  async stats(days: number): Promise<UsageStatsAnswer> {
    const window = clampStatsDays(days)
    const cached = this.#cache.get(window)
    if (cached !== undefined && this.#options.now() - cached.at < this.#ttl()) return cached.answer
    const running = this.#inFlight.get(window)
    if (running !== undefined) return await running
    const settle = (answer: UsageStatsAnswer): UsageStatsAnswer => {
      this.#remember(window, answer)
      this.#inFlight.delete(window)
      return answer
    }
    const read = this.#read(window)
      .then(settle, (error: unknown) => settle({ unsupported: 'probe-failed', reason: failureText(error) }))
    this.#inFlight.set(window, read)
    return await read
  }

  /**
   * 读一次聚合。
   *
   * 先一条 `/overview`：它一次给出今天、最近 30 个有记录的日子的台账与观测花费。
   * 请求的窗口比那一截更深、或者本月的台账被那一截截断（30 天里挤了 31 个日子只
   * 可能发生在某月的最后一天）时，才按 `availableDays` 补读缺的那几天——只有确实
   * 有记录的日子才补，剩下的日历日子按真实的 0 收。
   * @param window - 已经收进合法区间的天数。
   * @returns 读到的那一份，或者为什么读不到。
   */
  async #read(window: number): Promise<UsageStatsAnswer> {
    const transport = this.#transport()
    if (transport === undefined) return { unsupported: 'probe-failed', reason: 'no host usage route' }
    const overview = await transport.overview()
    if (overview.kind === 'missing') return { unsupported: 'no-usage-plugin' }
    if (overview.kind === 'failed') return { unsupported: 'probe-failed', reason: overview.reason }
    const facts = overviewFactsOf(overview.body)
    if (facts === undefined) return { unsupported: 'probe-failed', reason: 'unrecognized overview shape' }
    const filled = await this.#fill(transport, facts, window)
    if (typeof filled === 'string') return { unsupported: 'probe-failed', reason: filled }
    return {
      updatedAt: facts.updatedAt,
      today: facts.today,
      month: monthBucketsOf(filled, facts.todayKey),
      days: windowDaysOf(filled, facts.todayKey, window),
      ...(facts.observedSpend === undefined ? {} : { observedSpend: facts.observedSpend }),
    }
  }

  /**
   * 把请求的窗口与本月还缺的有记录日子从 `/day` 补上。
   *
   * 补的只有两处交集：确实有记录（`availableDays` 里点过名）、且落在这次要看的
   * 两段日期里（请求的窗口，或本月）。两段都短的缘故，K 有上界：窗口内至多比那一截
   * 多出 `window - 30` 天，本月至多 31 天。一天都补不到是常态。
   * @param transport - 宿主路由。
   * @param facts - 已经读过形状的 `/overview`。
   * @param window - 请求的天数。
   * @returns 补齐后的行，或者一句短原因（补齐失败就不答这份聚合）。
   */
  async #fill(transport: UsageStatsTransport, facts: OverviewFacts, window: number): Promise<Map<string, UsageBuckets> | string> {
    const rows = new Map(facts.rows)
    const oldest = shiftDay(facts.todayKey, -(window - 1))
    const month = facts.todayKey.slice(0, 7)
    const wanted = facts.availableDays.filter(day => !rows.has(day)
      && ((day >= oldest && day <= facts.todayKey) || day.startsWith(month)))
    if (wanted.length === 0) return rows
    const answers = await Promise.all(wanted.map(async day => ({ day, outcome: await transport.day(day) })))
    for (const { day, outcome } of answers) {
      if (outcome.kind === 'failed') return outcome.reason
      if (outcome.kind === 'missing') return `the day route is missing ${day}`
      const buckets = dayBucketsOf(outcome.body)
      if (buckets === undefined) return `unrecognized day shape for ${day}`
      rows.set(day, buckets)
    }
    return rows
  }

  /** 宿主路由的一次解析；解析本身抛错按「没有路由」处理。 */
  #transport(): UsageStatsTransport | undefined {
    try {
      return this.#options.transport()
    } catch (error) {
      this.#options.log(`the host usage routes could not be resolved: ${failureText(error)}`)
      return undefined
    }
  }

  /** 记一份聚合（读到与没读到都记）并维持容量上界。 */
  #remember(window: number, answer: UsageStatsAnswer): void {
    this.#cache.delete(window)
    this.#cache.set(window, { at: this.#options.now(), answer })
    while (this.#cache.size > STATS_CACHE_LIMIT) {
      const oldest = this.#cache.keys().next()
      if (oldest.done === true) return
      this.#cache.delete(oldest.value)
    }
  }

  /** 缓存窗口。 */
  #ttl(): number {
    return this.#options.ttlMs ?? STATS_CACHE_TTL_MS
  }
}

/**
 * 把客户端给的天数收成合法的窗口。
 * @param days - 客户端给的天数。
 * @returns 一个 `[1, 60]` 间的整数；不是有限数时回默认的 14 天。
 */
export function clampStatsDays(days: number): number {
  if (!Number.isFinite(days)) return STATS_DAYS_DEFAULT
  return Math.min(STATS_DAYS_MAX, Math.max(1, Math.floor(days)))
}

/** 五个桶全 0：一天没用量时的真实读数。 */
function emptyBuckets(): UsageBuckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/** 两个桶相加。 */
function addBuckets(left: UsageBuckets, right: UsageBuckets): UsageBuckets {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: left.reasoning + right.reasoning,
  }
}

/**
 * 宿主台账的一格折成五个桶。
 *
 * 五个数缺一个就整行不认：只读到输入、把没读到的推理编成 0，等于把「不知道」说成
 * 「没有」。
 * @param value - 宿主 `UsageTokenTotals` 的一格。
 * @returns 五个桶，形状不符时 undefined。
 */
function bucketsOfTotals(value: unknown): UsageBuckets | undefined {
  if (!isRecord(value)) return undefined
  const input = countOf(value.inputTokens)
  const output = countOf(value.outputTokens)
  const cacheRead = countOf(value.cacheReadTokens)
  const cacheWrite = countOf(value.cacheWriteTokens)
  const reasoning = countOf(value.reasoningTokens)
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || reasoning === undefined) return undefined
  return { input, output, cacheRead, cacheWrite, reasoning }
}

/** 一天的一行：`/day` 把它包在 `{ok:true, day:{...}}` 里。 */
function dayBucketsOf(body: unknown): UsageBuckets | undefined {
  if (!isRecord(body)) return undefined
  return bucketsOfTotals(isRecord(body.day) ? body.day.totals : undefined)
}

/** 一个非负的有限数；宿主把 token 数写成整数。 */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** `/overview` 里本模块要的一格；形状不符时 undefined。 */
function overviewFactsOf(body: unknown): OverviewFacts | undefined {
  if (!isRecord(body)) return undefined
  const updatedAt = countOf(body.updatedAt)
  const usage = isRecord(body.usage) ? body.usage : undefined
  if (updatedAt === undefined || usage === undefined) return undefined
  const today = isRecord(usage.today) ? usage.today : undefined
  const todayKey = typeof today?.date === 'string' ? today.date : undefined
  const todayBuckets = bucketsOfTotals(today?.totals)
  if (todayKey === undefined || !isDayKey(todayKey) || todayBuckets === undefined) return undefined
  const rows = new Map<string, UsageBuckets>()
  const listed = usage.days
  if (!Array.isArray(listed)) return undefined
  for (const row of listed) {
    if (!isRecord(row) || typeof row.date !== 'string' || !isDayKey(row.date)) return undefined
    const buckets = bucketsOfTotals(row.totals)
    if (buckets === undefined) return undefined
    rows.set(row.date, buckets)
  }
  const availableDays: string[] = []
  if (Array.isArray(usage.availableDays)) {
    for (const day of usage.availableDays) if (typeof day === 'string' && isDayKey(day)) availableDays.push(day)
  }
  const spend = isRecord(usage.observedSpend) ? usage.observedSpend : undefined
  const cny = countOf(spend?.cny)
  const since = countOf(spend?.since)
  const observedSpend = cny === undefined || since === undefined ? undefined : { cny, since }
  return {
    updatedAt,
    todayKey,
    today: todayBuckets,
    rows,
    availableDays,
    ...(observedSpend === undefined ? {} : { observedSpend }),
  }
}

/** 窗口内按日期升序的一天一行；台账里没有的日子是真实的 0。 */
function windowDaysOf(rows: Map<string, UsageBuckets>, todayKey: string, window: number): UsageDayBucket[] {
  const oldest = shiftDay(todayKey, -(window - 1))
  const days: UsageDayBucket[] = []
  for (let index = 0; index < window; index += 1) {
    const day = shiftDay(oldest, index)
    days.push({ day, ...(rows.get(day) ?? emptyBuckets()) })
  }
  return days
}

/** 本月的累计：只有本月的行，其余日子是真 0。 */
function monthBucketsOf(rows: Map<string, UsageBuckets>, todayKey: string): UsageBuckets {
  const month = todayKey.slice(0, 7)
  let total = emptyBuckets()
  for (const [day, buckets] of rows) if (day.startsWith(month)) total = addBuckets(total, buckets)
  return total
}

/**
 * 一个日期键加减天数。
 *
 * 走 UTC 是为了不让夏令时把「加一天」算成 23 或 25 小时：这里加的是日历天。
 * @param day - 日期键 `YYYY-MM-DD`。
 * @param delta - 加减多少天，负数向前。
 * @returns 新的日期键。
 */
export function shiftDay(day: string, delta: number): string {
  const number = dayNumberOf(day)
  if (number === undefined) return day
  const shifted = new Date(number + delta * DAY_MS)
  const year = shifted.getUTCFullYear()
  const month = `${shifted.getUTCMonth() + 1}`.padStart(2, '0')
  const date = `${shifted.getUTCDate()}`.padStart(2, '0')
  return `${year}-${month}-${date}`
}

/**
 * `YYYY-MM-DD` 是不是一个真实存在的日子。
 * @param value - 待判定的文本。
 * @returns 格式对且日子存在时为 true。
 */
export function isDayKey(value: string): boolean {
  return dayNumberOf(value) !== undefined
}

/** 日期键折成 UTC 的日序号；格式不对或日子不存在时 undefined。 */
function dayNumberOf(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const date = Number(value.slice(8, 10))
  const ms = Date.UTC(year, month - 1, date)
  const parsed = new Date(ms)
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== date) return undefined
  return ms
}

/** 一个可按下标读取的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
