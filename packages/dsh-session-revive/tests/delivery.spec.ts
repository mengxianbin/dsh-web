import { describe, expect, it } from 'vitest'
import { dispatchNudge, type NudgeDeliveryDeps, type UnsendableReason } from '../src/delivery.ts'

interface Sinks {
  prompted: string[]
  delivered: Array<{ parent: unknown; childId: string; text: string }>
  sent: string[]
  failed: Array<{ sessionId: string; error: unknown }>
  unsendable: Array<{ sessionId: string; reason: UnsendableReason }>
}

interface Harness {
  deps: NudgeDeliveryDeps
  sinks: Sinks
  /** Flip the parent agent live (or dead again). */
  setParentLive(live: boolean): void
  /** Make the parent rescue prompt reject. */
  rejectParentRescue(): void
  /** Make the child delivery reject (attempted-and-failed). */
  rejectDelivery(): void
}

const PARENT_AGENT = { id: 'parent-1' }

function makeHarness(
  header: NudgeDeliveryDeps['header'],
  options: { runtimePresent?: boolean } = {},
): Harness {
  const sinks: Sinks = { prompted: [], delivered: [], sent: [], failed: [], unsendable: [] }
  let parentLive = false
  let parentRescueRejects = false
  let deliveryRejects = false
  const deps: NudgeDeliveryDeps = {
    header,
    liveParent: () => (parentLive ? PARENT_AGENT : undefined),
    runtime: () => (options.runtimePresent === false ? undefined : { service: true }),
    prompt: async (sessionId) => {
      sinks.prompted.push(sessionId)
      if (sessionId !== 'parent-1') return
      if (parentRescueRejects) throw new Error('parent prompt rejected')
      parentLive = true
    },
    deliver: async (parent, childId, text) => {
      sinks.delivered.push({ parent, childId, text })
      if (deliveryRejects) throw new Error('delivery rejected')
    },
    sent: (sessionId) => {
      sinks.sent.push(sessionId)
    },
    failed: (sessionId, error) => {
      sinks.failed.push({ sessionId, error })
    },
    unsendable: (sessionId, reason) => {
      sinks.unsendable.push({ sessionId, reason })
    },
  }
  return {
    deps,
    sinks,
    setParentLive: (live) => {
      parentLive = live
    },
    rejectParentRescue: () => {
      parentRescueRejects = true
    },
    rejectDelivery: () => {
      deliveryRejects = true
    },
  }
}

const childHeader = { origin: 'subagent' as const, parentSession: 'parent-1' }

describe('nudge dispatch (design 件1 three boundary states)', () => {
  it('top-level session (no child header) keeps the generic prompt path', async () => {
    const h = makeHarness(() => undefined)
    await dispatchNudge('top-1', 'continue', h.deps)
    expect(h.sinks.prompted).toEqual(['top-1'])
    expect(h.sinks.delivered).toHaveLength(0)
    expect(h.sinks.sent).toEqual(['top-1'])
    expect(h.sinks.failed).toHaveLength(0)
    expect(h.sinks.unsendable).toHaveLength(0)
  })

  it('state 1 — live parent: delivers through the seam, never touches the fenced prompt', async () => {
    const h = makeHarness(() => childHeader)
    h.setParentLive(true)
    await dispatchNudge('child-1', 'continue', h.deps)
    expect(h.sinks.prompted).toHaveLength(0)
    expect(h.sinks.delivered).toEqual([{ parent: PARENT_AGENT, childId: 'child-1', text: 'continue' }])
    expect(h.sinks.sent).toEqual(['child-1'])
    expect(h.sinks.failed).toHaveLength(0)
    expect(h.sinks.unsendable).toHaveLength(0)
  })

  it('state 2 — dead parent: rescues the parent first, then delivers once live', async () => {
    const h = makeHarness(() => childHeader)
    await dispatchNudge('child-1', 'continue', h.deps)
    expect(h.sinks.prompted).toEqual(['parent-1'])
    expect(h.sinks.delivered).toEqual([{ parent: PARENT_AGENT, childId: 'child-1', text: 'continue' }])
    expect(h.sinks.sent).toEqual(['child-1'])
    expect(h.sinks.unsendable).toHaveLength(0)
  })

  it('state 3a — parent rescue rejects: fail-closed stall-unsendable, no delivery', async () => {
    const h = makeHarness(() => childHeader)
    h.rejectParentRescue()
    await dispatchNudge('child-1', 'continue', h.deps)
    expect(h.sinks.prompted).toEqual(['parent-1'])
    expect(h.sinks.delivered).toHaveLength(0)
    expect(h.sinks.unsendable).toEqual([{ sessionId: 'child-1', reason: 'parent-rescue-failed' }])
    expect(h.sinks.sent).toHaveLength(0)
    expect(h.sinks.failed).toHaveLength(0)
  })

  it('state 3b — parent accepted but never live again: fail-closed stall-unsendable', async () => {
    const h = makeHarness(() => childHeader)
    // The rescue prompt resolves, but the parent agent never re-attaches.
    h.deps.prompt = async (sessionId) => {
      h.sinks.prompted.push(sessionId)
    }
    await dispatchNudge('child-1', 'continue', h.deps)
    expect(h.sinks.prompted).toEqual(['parent-1'])
    expect(h.sinks.delivered).toHaveLength(0)
    expect(h.sinks.unsendable).toEqual([{ sessionId: 'child-1', reason: 'parent-rescue-failed' }])
  })

  it('state 3c — orphan (no parent recorded): stall-unsendable without any prompt', async () => {
    const h = makeHarness(() => ({ origin: 'subagent' as const }))
    await dispatchNudge('child-1', 'continue', h.deps)
    expect(h.sinks.prompted).toHaveLength(0)
    expect(h.sinks.delivered).toHaveLength(0)
    expect(h.sinks.unsendable).toEqual([{ sessionId: 'child-1', reason: 'no-parent' }])
  })

  it('subagent runtime missing: stall-unsendable before any rescue attempt', async () => {
    const h = makeHarness(() => childHeader, { runtimePresent: false })
    await dispatchNudge('child-1', 'continue', h.deps)
    expect(h.sinks.prompted).toHaveLength(0)
    expect(h.sinks.delivered).toHaveLength(0)
    expect(h.sinks.unsendable).toEqual([{ sessionId: 'child-1', reason: 'subagent-runtime-unavailable' }])
  })

  it('attempted delivery rejection is nudge-failed family, not stall-unsendable', async () => {
    const h = makeHarness(() => childHeader)
    h.setParentLive(true)
    h.rejectDelivery()
    await dispatchNudge('child-1', 'continue', h.deps)
    expect(h.sinks.delivered).toHaveLength(1)
    expect(h.sinks.failed).toHaveLength(1)
    expect(h.sinks.failed[0]?.sessionId).toBe('child-1')
    expect(h.sinks.unsendable).toHaveLength(0)
    expect(h.sinks.sent).toHaveLength(0)
  })

  it('top-level prompt rejection lands in the failed family (existing behavior)', async () => {
    const h = makeHarness(() => undefined)
    h.deps.prompt = async () => {
      throw new Error('prompt rejected')
    }
    await dispatchNudge('top-1', 'continue', h.deps)
    expect(h.sinks.failed).toHaveLength(1)
    expect(h.sinks.failed[0]?.sessionId).toBe('top-1')
    expect(h.sinks.sent).toHaveLength(0)
  })
})
