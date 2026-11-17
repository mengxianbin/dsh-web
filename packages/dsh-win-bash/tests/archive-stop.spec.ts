/**
 * Archive-time reclamation wiring: which lifecycle seams the shipped entry
 * subscribes to, and what each one hands the shell registry.
 *
 * The contract under test is the WIRING, not the reclamation itself — the
 * registry's matching semantics are asserted against the shipped payload in
 * `shell.spec.ts`. The entry builds its own `ShellRegistry`, so these cases
 * observe the seam through the class's own methods rather than reaching into
 * the closure: a listener that is registered but never calls the registry
 * would be a silent leak, which is the exact regression this file pins.
 *
 * The context is a plain recording object rather than the real Context: only
 * the members `registerWinBash` actually touches exist here, every `on(...)`
 * registration is captured by event name, and the fiber effect's disposer is
 * kept so the unload path can be driven too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { registerWinBash } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'
import { resolveRuntime } from '../src/runtime.ts'
import { ShellRegistry } from '../src/shell.ts'

/** One captured `on(...)` listener. */
type Listener = (payload: never) => unknown

/** The structural host this suite mounts the shipped entry on. */
interface RecordingHost {
  /** The context the entry was mounted on. */
  ctx: Context
  /** Every listener the entry registered, keyed by event name. */
  listeners: Map<string, Listener>
  /** The fiber effect's disposer, as the entry returned it. */
  teardown: () => unknown
}

/**
 * Build the structural context the entry is driven against.
 * @returns the context, its captured listeners, and the effect disposer.
 */
function recordingContext(): RecordingHost {
  const listeners = new Map<string, Listener>()
  let teardown: () => unknown = () => undefined
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    on: (name: string, listener: Listener) => {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
    effect: (body: () => unknown) => {
      const disposer = typeof body === 'function' ? body() : undefined
      teardown = typeof disposer === 'function' ? disposer as () => unknown : () => undefined
      return teardown
    },
    tools: { register: () => () => {} },
    subprocess: { spawn: () => { throw new Error('this suite never spawns a shell') } } as unknown as SubprocessRuntime,
    inject: () => ({ dispose: () => {} }),
  } as unknown as Context
  return { ctx, listeners, teardown: () => teardown() }
}

/** Mount the shipped entry on a fresh recording host. */
function mount(): RecordingHost {
  const resolved = resolveRuntime({ platform: process.platform, arch: process.arch })
  if ('code' in resolved) throw new Error('this host cannot serve the vendored payload')
  const host = recordingContext()
  registerWinBash(host.ctx, resolveConfig({ replacePwsh: false }), resolved)
  return host
}

describe('the entry\'s lifecycle seams', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('operator archiving a session gets that session\'s shells reclaimed', () => {
    // Given the shipped entry mounted on a host,
    const { listeners } = mount()
    // When the Workspace registry's archive stop seam fires,
    const stop = listeners.get('workspace/session-stop')
    expect(stop).toBeDefined()
    const disposeSession = vi.spyOn(ShellRegistry.prototype, 'disposeSession')
    stop?.({ sessionId: 'session-archived-one' } as never)
    // Then the entry reclaimed the shells of exactly that session.
    expect(disposeSession).toHaveBeenCalledWith('session-archived-one', expect.stringContaining('archived'))
  })

  it('operator disposing an agent still gets its own shell reclaimed', () => {
    // Given the shipped entry mounted on a host,
    const { listeners } = mount()
    // When the agent disposal seam fires,
    const disposed = listeners.get('agent/disposed')
    expect(disposed).toBeDefined()
    const dispose = vi.spyOn(ShellRegistry.prototype, 'dispose')
    const agent = { session: { id: 'session-gone' } }
    disposed?.({ agent } as never)
    // Then the entry released that agent's shell, unchanged from before.
    expect(dispose).toHaveBeenCalledWith(agent, expect.stringContaining('agent was disposed'))
  })

  it('operator unloading the plugin still disposes every shell', async () => {
    // Given the shipped entry mounted on a host,
    const { teardown } = mount()
    const disposeAll = vi.spyOn(ShellRegistry.prototype, 'disposeAll')
    // When the fiber effect is torn down,
    await teardown()
    // Then the registry's unload path runs, with unload as its reason.
    expect(disposeAll).toHaveBeenCalledWith(expect.stringContaining('unloaded'))
  })
})
