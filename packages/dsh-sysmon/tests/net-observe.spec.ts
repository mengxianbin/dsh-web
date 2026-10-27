/** Passive observer wiring: stream-frame routing, connection-tap feed, failure delegation, prepend posture. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { NetMonitor } from '../src/core/net.ts'
import { observeNet, type NetAgentFace } from '../src/host/net-observe.ts'
import type { ConnSegment } from '../src/host/conn-tap.ts'

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
  let onSegment: ((segment: ConnSegment) => void) | null = null
  const stopTap = vi.fn(() => { /* removed */ })
  const stop = observeNet(ctx, monitor, {
    tap: (settle) => {
      onSegment = settle
      return stopTap
    },
  })
  const find = (name: string): Registration => {
    const hit = registrations.find((entry) => entry.name === name)
    if (hit === undefined) throw new Error(`no listener for ${name}`)
    return hit
  }
  const settle = (segment: ConnSegment): void => {
    if (onSegment === null) throw new Error('connection tap not installed')
    onSegment(segment)
  }
  return {
    monitor,
    registrations,
    disposers,
    stop,
    stopTap,
    find,
    settle,
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

  it('routes an attempt start into the tap feed: connection settles with the logged route', () => {
    const h = harness()
    const stream = h.find('agent/assistant-stream').listener as (payload: { agent: NetAgentFace; frame: { type: 'start' | 'chunk' | 'end'; attemptId: string } }) => void
    stream({ agent: agentWithRoute, frame: { type: 'start', attemptId: 's:1' } })
    h.advance(142)
    h.settle({ ms: 142, via: 'direct' })
    const snap = h.monitor.snapshot()
    expect(snap.connMs).toBe(142)
    expect(snap.connVia).toBe('direct')
    expect(snap.provider).toBe('deepseek')
    expect(snap.ttftMs).toBeNull()
    // The consumed attempt: its end frame finds nothing to change.
    stream({ agent: agentWithRoute, frame: { type: 'end', attemptId: 's:1' } })
    expect(h.monitor.snapshot().connMs).toBe(142)
  })

  it('closes the attribution window at the first chunk or the end frame (keep-alive reuse has no segment)', () => {
    const h = harness()
    const stream = h.find('agent/assistant-stream').listener as (payload: { agent: NetAgentFace; frame: { type: 'start' | 'chunk' | 'end'; attemptId: string } }) => void
    stream({ agent: agentWithRoute, frame: { type: 'start', attemptId: 's:1' } })
    h.advance(200)
    stream({ agent: agentWithRoute, frame: { type: 'chunk', attemptId: 's:1' } })
    h.settle({ ms: 200, via: 'direct' })
    expect(h.monitor.snapshot().connMs).toBeNull()
    stream({ agent: agentWithRoute, frame: { type: 'start', attemptId: 's:2' } })
    stream({ agent: agentWithRoute, frame: { type: 'end', attemptId: 's:2' } })
    h.settle({ ms: 80, via: 'proxy' })
    expect(h.monitor.snapshot().connMs).toBeNull()
  })

  it('falls back to agent options when no request header is logged yet', () => {
    const h = harness()
    const stream = h.find('agent/assistant-stream').listener as (payload: { agent: NetAgentFace; frame: { type: 'start' | 'chunk' | 'end'; attemptId: string } }) => void
    stream({ agent: { options: { provider: 'options-provider' } }, frame: { type: 'start', attemptId: 's:1' } })
    h.settle({ ms: 10, via: 'direct' })
    expect(h.monitor.snapshot()).toMatchObject({ connMs: 10, provider: 'options-provider' })
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

  it('unregisters the tap and both listeners on dispose', () => {
    const h = harness()
    h.stop()
    expect(h.stopTap).toHaveBeenCalledOnce()
    expect(h.disposers).toHaveLength(2)
    for (const disposer of h.disposers) expect(disposer).toHaveBeenCalledOnce()
  })
})
