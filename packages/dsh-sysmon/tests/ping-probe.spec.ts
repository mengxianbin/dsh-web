/** ICMP probe: bilingual output parsing, cadence after settle, quick failure retry, failure reporting, dispose posture. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROBE_INTERVAL_MS, PROBE_RETRY_MS, PROBE_TIMEOUT_MS, decodePingOutput, parsePingRtt, startPingProbe, type PingChild } from '../src/host/ping-probe.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('parsePingRtt', () => {
  it('parses the zh Windows reply line', () => {
    const output = '来自 123.54.208.173 的回复: 字节=32 时间=19ms TTL=52\n'
    expect(parsePingRtt(output)).toBe(19)
  })

  it('parses the en Windows reply line', () => {
    const output = 'Reply from 172.65.90.20: bytes=32 time=237ms TTL=52\n'
    expect(parsePingRtt(output)).toBe(237)
  })

  it('maps the sub-millisecond form to 1', () => {
    expect(parsePingRtt('来自 10.0.0.1 的回复: 字节=32 时间<1ms TTL=64')).toBe(1)
    expect(parsePingRtt('Reply from 10.0.0.1: bytes=32 time<1ms TTL=64')).toBe(1)
  })

  it('falls back to the first NNms token when the locale pattern misses (encoding mismatch)', () => {
    // A UTF-8-configured ping decoded through the fixed gbk path garbles its
    // CJK prefix; the ASCII round trip still parses (reply precedes summary).
    expect(parsePingRtt('××××=19ms TTL=52\n×××× 19ms\n')).toBe(19)
  })

  it('returns null for timeouts and empty output', () => {
    expect(parsePingRtt('请求超时。\n')).toBeNull()
    expect(parsePingRtt('Request timed out.\n')).toBeNull()
    expect(parsePingRtt('')).toBeNull()
  })

  it('reads the statistics block when it is all that remains (unreachable on the probe path)', () => {
    // The strict pattern deliberately skips summary lines; the loose fallback
    // still takes their first token. On the probe this never happens: it
    // parses only after exit 0, and the reply line precedes the statistics.
    expect(parsePingRtt('往返最短 = 19ms，最长 = 19ms，平均 = 19ms\n')).toBe(19)
  })
})

describe('decodePingOutput', () => {
  it('decodes Chinese Windows ANSI/GBK bytes so the locale pattern matches', () => {
    // Probe-verified shape (2026-10-28): ping.exe writes cp936 on a pipe —
    // "正在" = d5fd d4da, 时间 = ca b1 bc e4.
    const gbk = Buffer.from(
      'd5fdd4da2050696e67206170692e646565707365656b2e636f6d2e656f2e646e7365312e636f6d20'
      + 'cab1bce4'
      + '3d31396d732054544c3d35320d0a',
      'hex',
    )
    const text = decodePingOutput(gbk)
    expect(text).toContain('正在 Ping')
    expect(parsePingRtt(text)).toBe(19)
  })

  it('passes strings through and falls back to utf-8 when the decoder rejects the label', () => {
    expect(decodePingOutput('time=9ms')).toBe('time=9ms')
    const gbk = Buffer.from('cab1bce43d31396d73', 'hex')
    // An unresolvable label (ICU-less engine shape) must not throw.
    const fallback = decodePingOutput(gbk, 'x-this-encoding-does-not-exist')
    expect(typeof fallback).toBe('string')
    expect(parsePingRtt(fallback)).toBe(19)
  })
})

/** A scripted child the probe's spawner seam returns. */
function fakeChild() {
  const handlers: { error?: (error: Error) => void; close?: (code: number | null, signal: NodeJS.Signals | null) => void } = {}
  let dataListener: ((chunk: Buffer | string) => void) | null = null
  const child: PingChild = {
    stdout: {
      on: (event, listener) => {
        if (event === 'data') dataListener = listener
      },
    },
    on: ((event: 'error' | 'close', listener: unknown) => {
      if (event === 'error') handlers.error = listener as (error: Error) => void
      else handlers.close = listener as (code: number | null, signal: NodeJS.Signals | null) => void
    }) as PingChild['on'],
    kill: vi.fn(),
  }
  return {
    child,
    kill: child.kill,
    reply(output: string): void { dataListener?.(output) },
    close(code: number | null): void { handlers.close?.(code, null) },
    error(): void { handlers.error?.(new Error('spawn failed')) },
  }
}

describe('startPingProbe', () => {
  it('runs immediately, reports a parsed round trip, and spawns again one interval after settling', () => {
    vi.useFakeTimers()
    const results: (number | null)[] = []
    const children: ReturnType<typeof fakeChild>[] = []
    const stop = startPingProbe({
      target: 'api.deepseek.com',
      onResult: (ms) => results.push(ms),
      spawner: () => { const scripted = fakeChild(); children.push(scripted); return scripted.child },
    })
    expect(children).toHaveLength(1)
    children[0]?.reply('来自 123.54.208.173 的回复: 字节=32 时间=19ms TTL=52')
    children[0]?.close(0)
    expect(results).toEqual([19])
    // Cadence is measured from settle, not spawn: just under one interval
    // after the reply, no second round exists yet.
    vi.advanceTimersByTime(PROBE_INTERVAL_MS - 1)
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(2)
    expect(children).toHaveLength(2)
    stop()
  })

  it('reports null for a lost probe and for a spawn error, then keeps cadence', () => {
    vi.useFakeTimers()
    const results: (number | null)[] = []
    const children: ReturnType<typeof fakeChild>[] = []
    const stop = startPingProbe({
      target: 'api.deepseek.com',
      intervalMs: 1_000,
      retryMs: 1_000,
      onResult: (ms) => results.push(ms),
      spawner: () => { const scripted = fakeChild(); children.push(scripted); return scripted.child },
    })
    children[0]?.close(1)
    vi.advanceTimersByTime(1_001)
    expect(children).toHaveLength(2)
    children[1]?.error()
    vi.advanceTimersByTime(1_001)
    expect(children).toHaveLength(3)
    expect(results).toEqual([null, null])
    stop()
  })

  it('retries a failed round quickly instead of waiting the full interval', () => {
    // 2026-10-28 latency-presence fix: the reading only survives
    // RTT_STALE_MS, so a 60s wait per miss would blank the cell for minutes
    // on a merely flaky link. Failure → PROBE_RETRY_MS, success → full cadence.
    vi.useFakeTimers()
    expect(PROBE_RETRY_MS).toBeLessThan(PROBE_INTERVAL_MS)
    const results: (number | null)[] = []
    const children: ReturnType<typeof fakeChild>[] = []
    const stop = startPingProbe({
      target: 'api.deepseek.com',
      onResult: (ms) => results.push(ms),
      spawner: () => { const scripted = fakeChild(); children.push(scripted); return scripted.child },
    })
    children[0]?.close(1)
    expect(results).toEqual([null])
    vi.advanceTimersByTime(PROBE_RETRY_MS - 1)
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(2)
    // A success right after restores the one-per-minute cadence.
    children[1]?.reply('来自 x 的回复: 字节=32 时间=9ms TTL=52')
    children[1]?.close(0)
    vi.advanceTimersByTime(PROBE_RETRY_MS)
    expect(children).toHaveLength(2)
    vi.advanceTimersByTime(PROBE_INTERVAL_MS - PROBE_RETRY_MS)
    expect(children).toHaveLength(3)
    stop()
  })

  it('passes the target and one-shot flags to the spawner', () => {
    vi.useFakeTimers()
    const spawner = vi.fn(() => fakeChild().child)
    const stop = startPingProbe({ target: 'example.invalid', timeoutMs: 2_500, onResult: () => {}, spawner })
    expect(spawner).toHaveBeenCalledWith('ping', ['-n', '1', '-w', '2500', 'example.invalid'])
    expect(PROBE_TIMEOUT_MS).toBe(3_000)
    stop()
  })

  it('stop kills the in-flight child and suppresses its late result', () => {
    vi.useFakeTimers()
    const results: (number | null)[] = []
    const children: ReturnType<typeof fakeChild>[] = []
    const stop = startPingProbe({
      target: 'api.deepseek.com',
      onResult: (ms) => results.push(ms),
      spawner: () => { const scripted = fakeChild(); children.push(scripted); return scripted.child },
    })
    const [first] = children
    expect(first).toBeDefined()
    stop()
    expect(first?.kill).toHaveBeenCalledOnce()
    first?.reply('来自 x 的回复: 字节=32 时间=9ms TTL=52')
    first?.close(0)
    expect(results).toEqual([])
    // No reschedule after stop: time passing spawns nothing new.
    vi.advanceTimersByTime(PROBE_INTERVAL_MS * 2)
    expect(children).toHaveLength(1)
    // Idempotent dispose.
    stop()
    expect(first?.kill).toHaveBeenCalledOnce()
  })
})
