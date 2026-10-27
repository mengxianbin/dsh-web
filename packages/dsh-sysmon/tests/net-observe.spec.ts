/** Passive observer wiring: failure delegation, prepend posture, dispose. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { NetMonitor } from '../src/core/net.ts'
import { observeNet } from '../src/host/net-observe.ts'

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
  return { monitor, registrations, disposers, stop, find, advance(ms: number) { now += ms } }
}

describe('observeNet', () => {
  it('registers exactly the failure listener, prepended', () => {
    const h = harness()
    expect(h.registrations.map((entry) => entry.name)).toEqual(['agent/request-error'])
    // Prepend is load-bearing: llm-retry answers retried failures without
    // calling next(), so a trailing observer would miss exactly the failures
    // worth counting.
    expect(h.registrations[0]?.options).toEqual({ prepend: true })
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

  it('unregisters the listener on dispose', () => {
    const h = harness()
    h.stop()
    expect(h.disposers).toHaveLength(1)
    for (const disposer of h.disposers) expect(disposer).toHaveBeenCalledOnce()
  })
})
