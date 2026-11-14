// @vitest-environment jsdom
/**
 * Client apply() registration tests: the chip mounts on the composer's input
 * dock (`conversation.input.dock`), the seam every shipped shell declares. The
 * registration waits for that declaration instead of registering eagerly, so a
 * shell that declares it late still gets the chip, and no other seat is
 * mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { BranchChip } from '../src/client/chips/BranchChip.tsx'

/**
 * A minimal SlotRegistry stand-in: inject resolves synchronously for
 * declared slots and otherwise parks the callback until a declaration
 * lands (mirroring the service's declaration-lifetime semantics).
 */
function makeSlotSystem(declared: Set<string>) {
  const register = vi.fn(() => () => undefined)
  const pending = new Map<string, () => () => void>()
  const inject = vi.fn((name: string, callback: () => () => void) => {
    if (declared.has(name)) {
      callback()
      return () => undefined
    }
    pending.set(name, callback)
    return () => { pending.delete(name) }
  })
  /** A declaration lands: run the parked wait for the name, if any. */
  const declare = (name: string): void => {
    const callback = pending.get(name)
    if (callback !== undefined) {
      pending.delete(name)
      callback()
    }
  }
  return { register, inject, declare }
}

/** Assemble the ctx/scope stubs, run apply, and hand back the instruments. */
function setup(declared: Set<string>) {
  const slotSystem = makeSlotSystem(declared)
  const disposers: (() => void)[] = []
  const scope = {
    slots: slotSystem,
    conversation: {},
    sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    // The auto-isolation fiber wraps this stub's startSession; the probe
    // members must exist so install takes the realistic path.
    workspaces: {
      startSession: vi.fn(),
      create: vi.fn(),
      connectWorkspace: vi.fn(),
      list: { getSnapshot: () => ({ items: [] }) },
    },
    effect: vi.fn((fn: () => unknown) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return () => {}
    }),
  }
  const ctx = {
    effect: vi.fn((fn: () => unknown) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return () => {}
    }),
    locale: { register: vi.fn() },
    inject: vi.fn((_services: unknown, callback: (s: typeof scope) => void) => { callback(scope) }),
  }

  apply(ctx as never)
  return { ...slotSystem, ctx, disposers }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('client apply()', () => {
  it('user gets the branch chip on the composer input dock', () => {
    // Given a shell that already declares the input dock
    const { register, inject, disposers } = setup(new Set(['conversation.input.dock']))

    // When the plugin applies
    // Then the inject wait resolves synchronously and the chip registers there
    expect(inject).toHaveBeenCalledWith('conversation.input.dock', expect.any(Function))
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'conversation.input.dock',
        id: 'git-graph',
        order: 100,
      }),
      BranchChip,
    )

    for (const dispose of disposers) dispose()
  })

  it('user gets the branch chip when the dock declaration lands later', () => {
    // Given a shell whose dock declaration is not live yet
    const { register, declare, disposers } = setup(new Set())
    expect(register).not.toHaveBeenCalled()

    // When the declaration lands
    declare('conversation.input.dock')

    // Then the parked wait registers exactly one dock entry
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'conversation.input.dock' }),
      BranchChip,
    )

    for (const dispose of disposers) dispose()
  })

  it('user keeps a single seat when a shell declares the input dock only', () => {
    // Given a shell that declares its composer seams
    const { register, declare, disposers } = setup(new Set(['conversation.input.dock']))

    // When a later declaration wave arrives for the removed selector-context hole
    declare('conversation.input.selector.context')

    // Then the dock stays the only registration
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'conversation.input.selector.context' }),
      expect.anything(),
    )

    for (const dispose of disposers) dispose()
  })
})
