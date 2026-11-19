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

/** A host whose activity waterfall answers with the given list (or throws). */
function activityHost(answer: readonly { kind: string }[] | Error): {
  ctx: Context
  registry: { archiveSession: ReturnType<typeof vi.fn> }
  parallel: ReturnType<typeof vi.fn>
  warnings: string[]
  waterfall: ReturnType<typeof vi.fn>
} {
  const registry = { archiveSession: vi.fn(async (_id: string, _options?: unknown) => {}) }
  const warnings: string[] = []
  const parallel = vi.fn(async () => {})
  const waterfall = vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })
  const ctx = {
    workspaceRegistry: registry,
    logger: { warn: (message: string) => { warnings.push(message) } },
    parallel,
    waterfall,
  } as unknown as Context
  return { ctx, registry, parallel, warnings, waterfall }
}

describe('C′ 归档即停轮 — stopTurn with 加固A activity check (2026-11-19 裁定)', () => {
  it('operator archiving mid-turn with turn-only activity gets the stop ordered with the write', async () => {
    // Given an activity waterfall reporting the turn family and nothing else,
    const { ctx, registry, parallel, waterfall } = activityHost([{ kind: 'turn' }])
    // When the caller asks for the stop-turn archive,
    await archiveSession(ctx, 'session-turn', { stopTurn: true })
    // Then the registry archives with stopActivity — it issues the
    // `workspace/session-stop` dispatch itself after the durable write, so
    // this wrapper must not dispatch a second stop.
    expect(waterfall).toHaveBeenCalledWith('workspace/session-activity', { sessionId: 'session-turn' }, expect.any(Function))
    expect(registry.archiveSession).toHaveBeenCalledWith('session-turn', { stopActivity: true })
    expect(parallel).not.toHaveBeenCalled()
  })

  it('operator with a running job beside the turn falls back to the plain archive', async () => {
    // Given the waterfall reports a job family next to the turn (加固A: never
    // stop a turn that hosts running work)
    const { ctx, registry, parallel, waterfall } = activityHost([{ kind: 'turn' }, { kind: 'job' }])
    // When the stop-turn archive runs,
    await archiveSession(ctx, 'session-mixed', { stopTurn: true })
    // Then it degrades to today's plain path: one-arg registry call plus the
    // wrapper's own manual stop dispatch.
    expect(registry.archiveSession).toHaveBeenCalledWith('session-mixed')
    expect(parallel).toHaveBeenCalledWith('workspace/session-stop', { sessionId: 'session-mixed' })
  })

  it('operator with nothing running falls back to the plain archive (no stop to order)', async () => {
    // Given the waterfall answers an empty list,
    const { ctx, registry, parallel, waterfall } = activityHost([])
    // When the stop-turn archive runs,
    await archiveSession(ctx, 'session-idle', { stopTurn: true })
    // Then the plain path archives — nothing was running to stop.
    expect(waterfall).toHaveBeenCalled()
    expect(registry.archiveSession).toHaveBeenCalledWith('session-idle')
    expect(parallel).toHaveBeenCalledWith('workspace/session-stop', { sessionId: 'session-idle' })
  })

  it('operator whose activity query fails still archives on the plain path and warns', async () => {
    // Given the waterfall throws the way a broken provider does (加固A:
    // a failed query answers false — never toward a wider stop)
    const { ctx, registry, parallel, warnings, waterfall } = activityHost(new Error('waterfall exploded'))
    // When the stop-turn archive runs,
    await expect(archiveSession(ctx, 'session-broken-query', { stopTurn: true })).resolves.toBeUndefined()
    // Then the plain path archives and the failure is loud, not swallowed.
    expect(waterfall).toHaveBeenCalled()
    expect(registry.archiveSession).toHaveBeenCalledWith('session-broken-query')
    expect(parallel).toHaveBeenCalledWith('workspace/session-stop', { sessionId: 'session-broken-query' })
    expect(warnings.join('\n')).toContain('waterfall exploded')
  })

  it('operator archiving without stopTurn never queries the activity waterfall', async () => {
    // Given any activity answer at all,
    const { ctx, registry, parallel, waterfall } = activityHost([{ kind: 'turn' }])
    // When the caller does not ask for the stop-turn path (force, stale,
    // NEUTRAL, reaper, archiveInternal),
    await archiveSession(ctx, 'session-plain')
    // Then the waterfall is untouched and the pre-C′ path runs verbatim.
    expect(waterfall).not.toHaveBeenCalled()
    expect(registry.archiveSession).toHaveBeenCalledWith('session-plain')
    expect(parallel).toHaveBeenCalledWith('workspace/session-stop', { sessionId: 'session-plain' })
  })
})
