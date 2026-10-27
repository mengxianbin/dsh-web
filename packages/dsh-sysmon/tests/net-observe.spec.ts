/** Passive observer wiring: stream-frame routing, failure delegation, prepend posture. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { NetMonitor } from '../src/core/net.ts'
import { observeNet, type NetAgentFace } from '../src/host/net-observe.ts'

/** Captured ctx.on registrations. */
interface Registration {
  name: string
  listener: (...args: never[]) => unknown
  options?: { prepend?: boolean }
}

function harness() {
  let now = 1_761_000_000_000
  const monitor = new NetMonitor({ deps: { now: () => now } })
  const registrations: Registration[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    on: (name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }) => {
      registrations.push({ name, listener, options })
      const disposer = vi.fn(() => { /* removed */ })
      disposers.push(disposer)
      return disposer
    },
  } as unknown as Context
  const stop = observeNet(ctx, monitor)
  const find = (name: string): Registration => {
    const hit = registrations.find((entry) => entry.name === name)
    if (hit === undefined) throw new Error(`no listener for ${name}`)
    return hit
  }
  return {
    monitor,
    registrations,
    disposers,
    stop,
    find,
    advance(ms: number) { now += ms },
  }
}

/** The agent face routeOf() prefers: logged request config over options. */
const agentWithRoute: NetAgentFace = {
  options: { provider: 'options-provider' },
  session: { requestHeader: () => ({ config: { provider: 'deepseek' } }) },
}

describe('observeNet', () => {
  it('registers the stream listener unscoped and the failure listener prepended', () => {
    const h = harness()
    expect(h.registrations.map((entry) => entry.name)).toEqual(['agent/assistant-stream', 'agent/request-error'])
    expect(h.registrations[0]?.options).toBeUndefined()
    // Prepend is load-bearing: llm-retry answers retried failures without
    // calling next(), so a trailing observer would miss exactly the failures
    // worth counting.
    expect(h.registrations[1]?.options).toEqual({ prepend: true })
  })

  it('routes start/chunk/end frames into the monitor with the logged route', () => {
    const h = harness()
    const stream = h.find('agent/assistant-stream').listener as (payload: { agent: NetAgentFace; frame: { type: 'start' | 'chunk' | 'end'; attemptId: string } }) => void
    stream({ agent: agentWithRoute, frame: { type: 'start', attemptId: 's:1' } })
    h.advance(142)
    stream({ agent: agentWithRoute, frame: { type: 'chunk', attemptId: 's:1' } })
    const snap = h.monitor.snapshot()
    expect(snap.ttftMs).toBe(142)
    expect(snap.provider).toBe('deepseek')
    stream({ agent: agentWithRoute, frame: { type: 'end', attemptId: 's:1' } })
    expect(h.monitor.snapshot().ttftMs).toBe(142)
  })

  it('falls back to agent options when no request header is logged yet', () => {
    const h = harness()
    const stream = h.find('agent/assistant-stream').listener as (payload: { agent: NetAgentFace; frame: { type: 'start' | 'chunk' | 'end'; attemptId: string } }) => void
    stream({ agent: { options: { provider: 'options-provider' } }, frame: { type: 'start', attemptId: 's:1' } })
    h.advance(10)
    stream({ agent: { options: { provider: 'options-provider' } }, frame: { type: 'chunk', attemptId: 's:1' } })
    expect(h.monitor.snapshot().provider).toBe('options-provider')
  })

  it('records the failure then delegates the waterfall untouched', async () => {
    const h = harness()
    const failure = h.find('agent/request-error').listener as (payload: { provider: string; failure: { code: string } }, next: () => Promise<undefined>) => Promise<undefined>
    const next = vi.fn(async () => undefined)
    const result = await failure({ provider: 'deepseek', failure: { code: 'TIMEOUT' } }, next)
    expect(next).toHaveBeenCalledOnce()
    expect(result).toBeUndefined()
    expect(h.monitor.snapshot()).toMatchObject({ failures: 1, warn: true, provider: 'deepseek' })
  })

  it('unregisters both listeners on dispose', () => {
    const h = harness()
    h.stop()
    expect(h.disposers).toHaveLength(2)
    for (const disposer of h.disposers) expect(disposer).toHaveBeenCalledOnce()
  })
})
