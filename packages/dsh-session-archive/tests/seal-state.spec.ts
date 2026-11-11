// @vitest-environment node
/**
 * The turn-end seal sync (seal-light-host-state-1109 裁点1A): projection fold
 * purity, turn/end-only scheduling with skip-if-unchanged recording, stop
 * release, and the default off-loop worker compute against a real transcript.
 * @module tests/seal-state.spec
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SEAL_RECORD, sessionSealProjection } from '../src/host/seal-projection.ts'
import { computeSealInWorker, createSealStateSync } from '../src/host/seal-state.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SealCheckResult } from '../src/core/types.ts'
import { assistantMsg, createFakeHost, userMsg, writeTranscript, type FakeHost } from './fixtures.ts'

interface EndorsedRepo {
  dir: string
  hash: string
}

let repoCache: EndorsedRepo | undefined

/**
 * A real git repo whose commit sits behind an origin remote-tracking ref
 * (hermetic endorsement fixture, same shape as seal-lastline.spec): the
 * 1107 声明-核验 recheck fail-closes an unbacked DONE to no-endorsement, so
 * the worker e2e transcript carries a declared `hashes=` list whose single
 * hash this repo backs.
 */
function endorsedRepo(): EndorsedRepo {
  if (repoCache !== undefined) return repoCache
  const dir = mkdtempSync(join(tmpdir(), 'seal-state-'))
  const run = (args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  run(['init', '-q'])
  run(['config', 'user.email', 'seal@test'])
  run(['config', 'user.name', 'seal'])
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'seed'])
  const hash = run(['rev-parse', 'HEAD']).trim()
  run(['update-ref', 'refs/remotes/origin/main', hash])
  repoCache = { dir, hash }
  return repoCache
}

/** Root event carrying the session cwd so `repoCandidates` resolves the fixture repo first. */
function sessionRoot(id: string, cwd: string): Record<string, unknown> {
  return { type: 'session', version: 4, id, cwd }
}

/** Endorsed DONE tail (seal-declare-verify-1107: `commits=1/1` + declared live hash). */
function endorsedDone(repo: EndorsedRepo): string {
  return `三刀全落（\`a1\` / \`b2\` / \`c3\`），status 干净。\n\n## ✅ 执行完成\nSAVE_STATUS=DONE commits=1/1 pushed=1/1 merged=1/1 pushedMain=1/1 marker=clean hashes=${repo.hash}`
}

/** A record event exactly as the fold reads one back. */
function sealRecord(data: unknown): SessionEvent {
  return {
    type: SEAL_RECORD,
    ignorable: true,
    seq: 7 as never,
    time: 1,
    data,
  } as unknown as SessionEvent
}

describe('sessionSealProjection fold', () => {
  it('operator starts the fold null and turns a well-formed record into the viewed payload', () => {
    // Given the empty log state, When a well-formed record arrives and the view reads it,
    // Then the state is the payload and the view is that same reference (no republish).
    const state = sessionSealProjection.init({} as never, 0 as never)
    expect(state).toBeNull()
    expect(sessionSealProjection.wire.view(state)).toBeNull()
    const folded = sessionSealProjection.apply(state, sealRecord({ verdict: 'DONE', detail: 'sentinel-ok' }))
    expect(folded).toEqual({ verdict: 'DONE', detail: 'sentinel-ok' })
    expect(sessionSealProjection.wire.view(folded)).toBe(folded)
  })

  it('operator leaves the state untouched for malformed or foreign records so later reads stay sound', () => {
    // Given a state holding one good verdict, When a malformed record, a foreign
    // plugin record and an ordinary event arrive, Then the state reference never moves.
    const before = sessionSealProjection.apply(null, sealRecord({ verdict: 'DONE' }))
    expect(sessionSealProjection.apply(before, sealRecord({ verdict: '' }))).toBe(before)
    expect(sessionSealProjection.apply(before, sealRecord({ unexpected: true }))).toBe(before)
    expect(sessionSealProjection.apply(before, {
      type: 'plugin:someone-else/value',
      ignorable: true,
      seq: 8 as never,
      time: 2,
      data: { verdict: 'DONE' },
    } as unknown as SessionEvent)).toBe(before)
    expect(sessionSealProjection.apply(before, {
      type: 'user/message',
      seq: 9 as never,
      time: 3,
      data: {},
    } as unknown as SessionEvent)).toBe(before)
  })
})

/** A minimal host: real detached Sessions, a recording registry stand-in, fold-through stateOf. */
function makeHarness() {
  const ctx = new Context()
  const session = Session.create(SessionId('session-seal-sync'))
  let registered: typeof sessionSealProjection | undefined
  const records = (): number => session.snapshotEvents()
    .filter((event) => (event as { type?: string }).type === SEAL_RECORD).length
  const stateOf = (): unknown => {
    if (registered === undefined) return undefined
    let state = registered.init(session.header, session.seq)
    for (const event of session.snapshotEvents()) state = registered.apply(state, event)
    return state
  }
  ctx.provide('sessionProjections', {
    register: (definition: typeof sessionSealProjection) => {
      registered = definition
      return () => { registered = undefined }
    },
    stateOf: (target: Session, key: string) => (key === 'seal' ? stateOf() : undefined),
    onChanged: () => () => undefined,
  } as never)
  ctx.provide('sessions', {
    get: (id: string) => (id === String(session.id) ? session : undefined),
  } as never)
  return { ctx, session, records, stateOf, registered: () => registered }
}

/** Fire one turn/end through the same event surface the sync subscribes. */
function turnEnd(ctx: Context, session: Session, turn: number): void {
  const event = session.append('turn/end', { turn, reason: { kind: 'completed' } as never })
  ctx.emit('session/event', session, event as SessionEvent)
}

describe('createSealStateSync', () => {
  it('operator computes once per turn end, records the verdict, and records nothing for an unchanged recompute', async () => {
    // Given a mounted sync over a fold that starts empty, When two turn ends
    // return the identical verdict, Then both compute and one record lands.
    const { ctx, session, records, stateOf, registered } = makeHarness()
    const compute = vi.fn((): SealCheckResult => ({ id: String(session.id), verdict: 'DONE', detail: 'sentinel-ok' }))
    const sync = createSealStateSync(ctx, { resolveDir: () => '/workspace/demo', compute })
    sync.start()
    await vi.waitFor(() => { expect(registered()).toBe(sessionSealProjection) })

    turnEnd(ctx, session, 1)
    await vi.waitFor(() => {
      expect(compute).toHaveBeenCalledTimes(1)
      expect(stateOf()).toEqual({ verdict: 'DONE', detail: 'sentinel-ok' })
    })
    expect(records()).toBe(1)

    turnEnd(ctx, session, 2)
    await vi.waitFor(() => { expect(compute).toHaveBeenCalledTimes(2) })
    expect(records()).toBe(1)
    expect(stateOf()).toEqual({ verdict: 'DONE', detail: 'sentinel-ok' })
    sync.stop()
    await ctx.fiber.dispose()
  })

  it('operator records a changed verdict and stamps UNKNOWN when the compute itself fails', async () => {
    // Given a mounted sync whose first turn end records UNSEALED, When the next
    // compute throws like a dead worker, Then the state reads UNKNOWN decode-fail.
    const { ctx, session, stateOf, registered } = makeHarness()
    const compute = vi.fn((): SealCheckResult => ({ id: String(session.id), verdict: 'UNSEALED', detail: 'sentinel-pending' }))
    const sync = createSealStateSync(ctx, { resolveDir: () => '/workspace/demo', compute })
    sync.start()
    await vi.waitFor(() => { expect(registered()).toBe(sessionSealProjection) })

    turnEnd(ctx, session, 1)
    await vi.waitFor(() => { expect(stateOf()).toEqual({ verdict: 'UNSEALED', detail: 'sentinel-pending' }) })

    compute.mockImplementation(() => { throw new Error('worker exploded') })
    turnEnd(ctx, session, 2)
    await vi.waitFor(() => {
      expect(stateOf()).toEqual({ verdict: 'UNKNOWN', detail: 'decode-fail' })
    })
    sync.stop()
    await ctx.fiber.dispose()
  })

  it('operator disarms on stop so a later turn end computes nothing', async () => {
    // Given a mounted sync that is then stopped, When a turn end arrives,
    // Then the registration is gone, no compute runs and no record lands.
    const { ctx, session, records, registered } = makeHarness()
    const compute = vi.fn((): SealCheckResult => ({ id: String(session.id), verdict: 'NEUTRAL', detail: 'no-save-trace' }))
    const sync = createSealStateSync(ctx, { resolveDir: () => '/workspace/demo', compute })
    sync.start()
    await vi.waitFor(() => { expect(registered()).toBe(sessionSealProjection) })

    sync.stop()
    expect(registered()).toBeUndefined()
    turnEnd(ctx, session, 1)
    // A queued pump would reach the synchronous fake inside this turn's
    // microtask chain; nothing queued means nothing called.
    expect(compute).not.toHaveBeenCalled()
    expect(records()).toBe(0)
    await ctx.fiber.dispose()
  })

  it('operator folds a turn end that lands mid-compute into one follow-up pass', async () => {
    // Given a sync whose first compute is gated open, When a second turn end
    // arrives before it settles, Then exactly one follow-up pass records nothing new.
    const { ctx, session, stateOf, records, registered } = makeHarness()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const compute = vi.fn(async (): Promise<SealCheckResult> => {
      await gate
      return { id: String(session.id), verdict: 'DONE', detail: 'sentinel-ok' }
    })
    const sync = createSealStateSync(ctx, { resolveDir: () => '/workspace/demo', compute })
    sync.start()
    await vi.waitFor(() => { expect(registered()).toBe(sessionSealProjection) })

    turnEnd(ctx, session, 1)
    turnEnd(ctx, session, 2)
    await vi.waitFor(() => { expect(compute).toHaveBeenCalledTimes(1) })
    release?.()
    await vi.waitFor(() => { expect(compute).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(stateOf()).toEqual({ verdict: 'DONE', detail: 'sentinel-ok' }) })
    expect(records()).toBe(1)
    sync.stop()
    await ctx.fiber.dispose()
  })
})

function dirOf(host: FakeHost, id: string): string {
  return `${host.home}/sessions/--Users-demo--/${id.startsWith('session-') ? id.slice('session-'.length) : id}`
}

describe('computeSealInWorker (default off-loop path)', () => {
  it('operator gets DONE through the worker script for a real sentinel transcript', async () => {
    // Given a session dir with an endorsed DONE sentinel transcript, When the
    // worker compute runs, Then it answers the DONE grouping off this thread.
    const repo = endorsedRepo()
    const host = createFakeHost()
    writeTranscript(host, 'session-worker', [sessionRoot('session-worker', repo.dir), userMsg('收口'), assistantMsg(endorsedDone(repo))])
    const result = await computeSealInWorker('session-worker', dirOf(host, 'session-worker'))
    expect(result).toEqual({ id: 'session-worker', verdict: 'DONE', detail: 'sentinel-ok' })
  }, 20_000)

  it('operator gets the transcript-not-found UNKNOWN when the worker receives no dir', async () => {
    // Given a worker request without a directory, When the compute runs,
    // Then the answer is the fail-visible UNKNOWN the endpoint would serve.
    const result = await computeSealInWorker('session-missing', undefined)
    expect(result.verdict).toBe('UNKNOWN')
    expect(result.detail).toBe('transcript-not-found')
  }, 20_000)
})

describe('record surface', () => {
  it('operator round-trips a plugin record through appendPluginRecord and the log on a detached Session', () => {
    // Given a detached Session, When a seal record is appended, Then the log
    // holds exactly that typed record for the fold to read.
    const session = Session.create(SessionId('session-record-roundtrip'))
    appendPluginRecord(session, SEAL_RECORD, { verdict: 'DONE', detail: 'sentinel-ok' })
    const events = session.snapshotEvents().filter((event) => (event as { type?: string }).type === SEAL_RECORD)
    expect(events).toHaveLength(1)
  })
})
