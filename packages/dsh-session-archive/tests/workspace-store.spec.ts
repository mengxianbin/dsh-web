/**
 * The archive choke point's reclamation dispatch: once the registry has
 * written the archive, the Workspace registry's `workspace/session-stop` seam
 * is asked to stop the session's work, which is how archive-time
 * reclamation (win_bash's persistent shell) reaches manual, override and
 * janitor archives alike.
 *
 * The contract under test is the DISPATCH and its failure rule: a rejecting
 * provider — or a host context that cannot dispatch at all — must not undo an
 * archive the registry already wrote. That mirrors the registry's own rule
 * for the stopActivity path (a provider rejection is logged, the archive
 * stays), so these cases pin both halves: the seam fires on success, and its
 * failure is loud but non-fatal.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { archiveSession } from '../src/host/workspace-store.ts'

/** The host context this suite hands `archiveSession`. */
interface TestHost {
  /** The context under test. */
  ctx: Context
  /** The registry verb the wrapper must call first. */
  registry: { archiveSession: ReturnType<typeof vi.fn> }
  /** The stop-seq dispatch recorded by this host. */
  parallel: ReturnType<typeof vi.fn>
  /** Warn lines this host recorded. */
  warnings: string[]
}

/**
 * Build a host context whose `ctx.parallel` runs the given dispatch.
 * @param dispatch - how the host answers the stop-seam call.
 * @returns the context and the spies this suite asserts on.
 */
function host(dispatch: (name: string, args: unknown) => Promise<void> = async () => {}): TestHost {
  const registry = { archiveSession: vi.fn(async (_id: string) => {}) }
  const warnings: string[] = []
  const parallel = vi.fn(dispatch)
  const ctx = {
    workspaceRegistry: registry,
    logger: { warn: (message: string) => { warnings.push(message) } },
    parallel,
  } as unknown as Context
  return { ctx, registry, parallel, warnings }
}

/**
 * Build the barest host this wrapper may meet: a registry and nothing else —
 * no `parallel`, no `logger`.
 * @returns the context and the registry spy.
 */
function bareHost(): { ctx: Context, registry: { archiveSession: ReturnType<typeof vi.fn> } } {
  const registry = { archiveSession: vi.fn(async (_id: string) => {}) }
  return { ctx: { workspaceRegistry: registry } as unknown as Context, registry }
}

describe('the archive stop dispatch', () => {
  it('operator archiving a session gets the stop seam dispatched after the write', async () => {
    // Given a host whose registry writes the archive,
    const { ctx, registry, parallel } = host()
    // When one session is archived,
    await archiveSession(ctx, 'session-archived')
    // Then the registry wrote first and the stop seam fired with that id.
    expect(registry.archiveSession).toHaveBeenCalledWith('session-archived')
    expect(parallel).toHaveBeenCalledWith('workspace/session-stop', { sessionId: 'session-archived' })
    expect(parallel.mock.invocationCallOrder[0]).toBeGreaterThan(registry.archiveSession.mock.invocationCallOrder[0])
  })

  it('operator whose stop dispatch rejects still keeps the archive', async () => {
    // Given a host whose stop dispatch throws the way a rejecting provider does,
    const rejecting = async () => { throw new Error('provider exploded') }
    const { ctx, registry, warnings } = host(rejecting)
    // When one session is archived,
    await expect(archiveSession(ctx, 'session-archived')).resolves.toBeUndefined()
    // Then the archive stands and the failure was logged, not swallowed.
    expect(registry.archiveSession).toHaveBeenCalledWith('session-archived')
    expect(warnings.join('\n')).toContain('provider exploded')
  })

  it('operator whose host cannot dispatch at all still archives', async () => {
    // Given a context with no `parallel` and no `logger` (a bare seam),
    const { ctx, registry } = bareHost()
    // When one session is archived,
    await expect(archiveSession(ctx, 'session-archived')).resolves.toBeUndefined()
    // Then the missing dispatch surface costs the reclamation, not the archive.
    expect(registry.archiveSession).toHaveBeenCalledWith('session-archived')
  })
})
