import { describe, expect, it } from 'vitest'
import { CAP_USAGE, CAP_USAGE_STATS, SERVED_CAPABILITIES } from '../src/core/protocol.ts'
import type { UsageStatsOutcome, UsageStatsTransport } from '../src/core/usage-stats.ts'
import { STATS_CACHE_TTL_MS, STATS_DAYS_DEFAULT, STATS_DAYS_MAX, UsageStatsReader } from '../src/core/usage-stats.ts'
import { UsageService } from '../src/core/usage.ts'
import { hostWebOrigin, LoopbackUsage, USAGE_OVERVIEW_PATH } from '../src/host/usage-stats.ts'
import { answerOf, makeConnection, requestFrame, type ConnectionHarness } from './support/harness.ts'

/** 宿主台账的一格，五个桶按那个插件的 `UsageTokenTotals` 写。 */
function totalsOf(input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number): Record<string, number> {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: reasoning, calls: 1, cost: 0 }
}

/** 一份 `dsh-usage` 的 `/overview` 应答体，形状照那个插件的 `UsageOverviewView`。 */
function overviewOf(options: { readonly today: string; readonly rows: { readonly date: string; readonly totals: Record<string, number> }[]; readonly availableDays?: readonly string[] }): Record<string, unknown> {
  return {
    updatedAt: 1_700_000_000_000,
    providers: [],
    current: { source: 'default' },
    usage: {
      today: { date: options.today, totals: options.rows[options.rows.length - 1]?.totals ?? totalsOf(0, 0, 0, 0, 0), providers: [] },
      days: options.rows,
      ...(options.availableDays === undefined ? {} : { availableDays: options.availableDays }),
    },
  }
}

/** 一份带观测花费的 `/overview` 应答体：两天用量、两个可查日子、一笔观测花费。 */
function ledgerOverview(): Record<string, unknown> {
  return {
    updatedAt: 1_700_000_000_000,
    providers: [],
    current: { source: 'default' },
    usage: {
      today: { date: '2024-03-15', totals: totalsOf(10, 20, 30, 40, 5), providers: [] },
      days: [
        { date: '2024-03-14', totals: totalsOf(1, 2, 3, 4, 0) },
        { date: '2024-03-15', totals: totalsOf(10, 20, 30, 40, 5) },
      ],
      availableDays: ['2024-03-14', '2024-03-15'],
      observedSpend: { cny: 12.5, since: 1_699_000_000_000 },
    },
  }
}

/** 一台脚本化的宿主：答什么由套件说，读了几次由它记。 */
interface ScriptedHost {
  readonly calls: string[]
  readonly transport: UsageStatsTransport
}

function hostOf(script: {
  readonly overview: UsageStatsOutcome
  readonly day?: (day: string) => UsageStatsOutcome
}): ScriptedHost {
  const calls: string[] = []
  return {
    calls,
    transport: {
      overview: async () => {
        calls.push('overview')
        return script.overview
      },
      day: async (day: string) => {
        calls.push(`day ${day}`)
        return script.day?.(day) ?? { kind: 'answer', body: { ok: true, day: { date: day, totals: totalsOf(0, 0, 0, 0, 0) } } }
      },
    },
  }
}

/** 一份用量服务，台账那一格接着给出来的宿主。 */
function usageOver(host: UsageStatsTransport | undefined, clock: { now: number }): UsageService {
  return new UsageService({
    faces: () => ({}),
    now: () => clock.now,
    log: () => {},
    stats: new UsageStatsReader({ transport: () => host, now: () => clock.now, log: () => {} }),
  })
}

/** 一次握手：宣告给定的能力。 */
async function greet(harness: ConnectionHarness, cap: readonly string[]): Promise<void> {
  await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: [...cap] }))
}

describe('usage stats channel over protocol v1', () => {
  it('user greeting the bridge finds the stats channel served right beside the usage channel', async () => {
    // Given a bridge that serves the usage stats channel
    const harness = makeConnection({ paired: true })
    // When the user greets it
    await greet(harness, [CAP_USAGE_STATS])
    // Then the announcement carries the name immediately after `usage.v1`, in the
    // order the frozen table lists them, and the whole served set is the table
    const hello = answerOf(harness, 1).r as { capabilities: string[] }
    expect(hello.capabilities).toEqual([...SERVED_CAPABILITIES])
    expect(hello.capabilities.indexOf(CAP_USAGE_STATS)).toBe(hello.capabilities.indexOf(CAP_USAGE) + 1)
  })

  it('user that declared only the usage channel is told the stats method does not exist', async () => {
    // Given a paired client written before the stats channel existed
    const harness = makeConnection({ paired: true, usage: usageOver(hostOf({ overview: { kind: 'answer', body: overviewOf({ today: '2024-03-15', rows: [] }) } }).transport, { now: 1_700_000_000_000 }) })
    await greet(harness, [CAP_USAGE])
    // When it calls the stats method
    await harness.connection.handleText(requestFrame(2, 'usage.stats', {}))
    // Then the method is unknown to it, and no host route was read on its behalf
    expect(answerOf(harness, 2).e).toEqual({ code: 'unknown-method', msg: 'unknown method usage.stats' })
  })

  it('user reading the ledger is answered five buckets for today and the month plus one row per day', async () => {
    // Given a host whose ledger holds two days and one observed spend
    const clock = { now: 1_700_000_000_000 }
    const host = hostOf({ overview: { kind: 'answer', body: ledgerOverview() } })
    const harness = makeConnection({ paired: true, usage: usageOver(host.transport, clock) })
    await greet(harness, [CAP_USAGE_STATS])
    // When the user asks for three days
    await harness.connection.handleText(requestFrame(2, 'usage.stats', { days: 3 }))
    // Then the window is three calendar days ascending, the empty one is a real
    // zero, the month folds the two March days, and the spend crosses as it was
    expect(answerOf(harness, 2).r).toEqual({
      updatedAt: 1_700_000_000_000,
      today: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5 },
      month: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, reasoning: 5 },
      days: [
        { day: '2024-03-13', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        { day: '2024-03-14', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 0 },
        { day: '2024-03-15', input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5 },
      ],
      observedSpend: { cny: 12.5, since: 1_699_000_000_000 },
    })
    // And the trend the overview already carried was enough: no day was re-read
    expect(host.calls).toEqual(['overview'])
  })

  it('user asking deeper than the overview trend is answered the missing day from the day route', async () => {
    // Given a host whose oldest retained day sits seven days back, outside the
    // two days the overview trend carries
    const clock = { now: 1_700_000_000_000 }
    const host = hostOf({
      overview: { kind: 'answer', body: overviewOf({
        today: '2024-03-15',
        rows: [{ date: '2024-03-15', totals: totalsOf(10, 0, 0, 0, 0) }],
        availableDays: ['2024-03-08', '2024-03-15'],
      }) },
      day: () => ({ kind: 'answer', body: { ok: true, day: { date: '2024-03-08', totals: totalsOf(7, 1, 0, 0, 0) } } }),
    })
    const harness = makeConnection({ paired: true, usage: usageOver(host.transport, clock) })
    await greet(harness, [CAP_USAGE_STATS])
    // When the user asks for a window that reaches that day
    await harness.connection.handleText(requestFrame(2, 'usage.stats', { days: 8 }))
    // Then exactly that day was read from the day route, and it landed in its own
    // slot rather than being folded into today
    expect(host.calls).toEqual(['overview', 'day 2024-03-08'])
    const answer = answerOf(harness, 2).r as { days: { day: string; input: number }[]; month: { input: number } }
    expect(answer.days).toHaveLength(8)
    expect(answer.days[0]).toMatchObject({ day: '2024-03-08', input: 7 })
    expect(answer.month.input).toBe(17)
  })

  it('user on a host that never mounted the usage plugin is told so instead of being handed zeros', async () => {
    // Given a host whose route answers 404
    const clock = { now: 1_700_000_000_000 }
    const host = hostOf({ overview: { kind: 'missing' } })
    const harness = makeConnection({ paired: true, usage: usageOver(host.transport, clock) })
    await greet(harness, [CAP_USAGE_STATS])
    // When the user asks for the ledger
    await harness.connection.handleText(requestFrame(2, 'usage.stats', {}))
    // Then the answer is a fact about that host, with no buckets at all
    expect(answerOf(harness, 2).r).toEqual({ unsupported: 'no-usage-plugin' })
  })

  it('user whose host route fails is told the probe failed and why', async () => {
    // Given a route that answered but not with an overview
    const clock = { now: 1_700_000_000_000 }
    const host = hostOf({ overview: { kind: 'failed', reason: 'HTTP 500' } })
    const harness = makeConnection({ paired: true, usage: usageOver(host.transport, clock) })
    await greet(harness, [CAP_USAGE_STATS])
    // When the user asks for the ledger
    await harness.connection.handleText(requestFrame(2, 'usage.stats', {}))
    // Then the failure crosses with its short reason, and nothing is invented
    expect(answerOf(harness, 2).r).toEqual({ unsupported: 'probe-failed', reason: 'HTTP 500' })
  })

  it('user asking twice inside the window causes one read, and two phones asking at once share it', async () => {
    // Given a host that answers one overview
    const clock = { now: 1_700_000_000_000 }
    const host = hostOf({ overview: { kind: 'answer', body: overviewOf({ today: '2024-03-15', rows: [] }) } })
    const usage = usageOver(host.transport, clock)
    // When two clients ask at the same instant and a third asks right after
    const [first, second] = await Promise.all([usage.stats(STATS_DAYS_DEFAULT), usage.stats(STATS_DAYS_DEFAULT)])
    const third = await usage.stats(STATS_DAYS_DEFAULT)
    // Then the single flight merged the pair and the window served the third
    expect(host.calls).toEqual(['overview'])
    expect(first).toEqual(second)
    expect(third).toEqual(first)
    // When the window has passed
    clock.now += STATS_CACHE_TTL_MS
    await usage.stats(STATS_DAYS_DEFAULT)
    // Then a fresh read is asked for
    expect(host.calls).toEqual(['overview', 'overview'])
  })

  it('user asking for more days than the protocol serves is read no deeper than the cap', async () => {
    // Given a host that answers one overview
    const clock = { now: 1_700_000_000_000 }
    const host = hostOf({ overview: { kind: 'answer', body: overviewOf({ today: '2024-03-15', rows: [] }) } })
    const usage = usageOver(host.transport, clock)
    // When the user asks for a thousand days
    const answer = await usage.stats(1000)
    // Then the window is the cap, and one overview was read
    expect(answer).toMatchObject({ days: expect.any(Array) })
    expect((answer as { days: unknown[] }).days).toHaveLength(STATS_DAYS_MAX)
    expect(host.calls).toEqual(['overview'])
  })
})

describe('the usage stats transport over loopback', () => {
  it('user on a host that does not serve the route is told the plugin is absent, and one it cannot reach is told the probe failed', async () => {
    // Given a host origin and two answers: a 404, then a socket that never opens
    const seen: string[] = []
    const answers: Response[] = []
    const usage = new LoopbackUsage({
      origin: () => 'http://127.0.0.1:3080',
      log: () => {},
      fetch: async (url) => {
        seen.push(String(url))
        const next = answers.shift()
        if (next !== undefined) return next
        throw new Error('connect ECONNREFUSED 127.0.0.1:3080')
      },
    })
    answers.push({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)
    // When the ledger is read twice, once per host
    const missing = await usage.overview()
    const failed = await usage.overview()
    // Then the absent plugin and the unreachable host are two different answers,
    // and both were addressed at this host's own loopback origin
    expect(missing).toEqual({ kind: 'missing' })
    expect(failed).toEqual({ kind: 'failed', reason: 'connect ECONNREFUSED 127.0.0.1:3080' })
    expect(seen).toEqual([
      'http://127.0.0.1:3080' + USAGE_OVERVIEW_PATH,
      'http://127.0.0.1:3080' + USAGE_OVERVIEW_PATH,
    ])
  })

  it('user on a host that has not bound its listener is still read over the loopback port it listens on', () => {
    // Given a host that has bound an origin, one that has not yet, and one with
    // no listener at all
    const bound = { getOrigin: () => 'http://192.168.1.9:3080', protocol: 'http:', port: 3080 }
    const unbinding = { getOrigin: () => { throw new Error('not listening') }, protocol: 'http:', port: 4100 }
    // When each origin is resolved
    // Then the bound address wins, the listening port is the fallback, and a host
    // with no listener has no origin to read at all
    expect(hostWebOrigin(bound)).toBe('http://192.168.1.9:3080')
    expect(hostWebOrigin(unbinding)).toBe('http://127.0.0.1:4100')
    expect(hostWebOrigin({})).toBeUndefined()
    expect(hostWebOrigin(undefined)).toBeUndefined()
  })
})
