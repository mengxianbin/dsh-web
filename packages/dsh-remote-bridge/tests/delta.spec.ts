import { describe, expect, it } from 'vitest'
import { ROSTER_DELTA_MAX_ROWS } from '../src/core/delta.ts'
import { SessionMeta } from '../src/core/session-meta.ts'
import { answerOf, makeConnection, requestFrame, type ConnectionHarness } from './support/harness.ts'

/** The capability a client declares to be answered increments (protocol v1 §15). */
const DECLARES_DELTA = 'delta.v1'

/** One row of the gateway's roster answer, as the host writes it. */
function summary(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId, updatedAt: 5, running: false, blank: false, agentAvailable: true, ...extra }
}

/** The gateway's answer for one roster of ids. */
function roster(ids: readonly string[], extra: (id: string) => Record<string, unknown> = () => ({})): { items: Record<string, unknown>[] } {
  return { items: ids.map(id => summary(id, extra(id))) }
}

/** One roster answer, as the wire carried it. */
interface RosterAnswer {
  readonly mode: string
  readonly token: string
  readonly sessions?: readonly { readonly id: string; readonly agentRunning?: boolean }[]
  readonly changed?: readonly { readonly id: string; readonly archived?: boolean }[]
  readonly removed?: readonly string[]
}

/** A paired connection over a roster whose archive set a test rewrites between listings. */
async function archiveConnection(): Promise<{ readonly harness: ConnectionHarness; readonly set: (ids: readonly string[]) => void }> {
  let archived: readonly string[] = []
  const meta = new SessionMeta(() => ({ archive: { archivedSessionIds: archived } }), () => 1_792_000_000_000, () => {})
  const harness = makeConnection({ paired: true, sessionMeta: meta })
  await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: [DECLARES_DELTA] }))
  return { harness, set: ids => { archived = ids } }
}

/** A paired connection that declared `delta.v1`, so its answers may be increments. */
async function deltaConnection(): Promise<ConnectionHarness> {
  const harness = makeConnection({ paired: true })
  await harness.connection.handleText(requestFrame(1, 'hello', { proto: 1, cap: [DECLARES_DELTA] }))
  return harness
}

/** Ask one connection for the roster, listing what the gateway answers last. */
async function list(harness: ConnectionHarness, id: number, items: readonly string[], since?: string): Promise<RosterAnswer> {
  harness.gateway.handler = async () => roster(items)
  await harness.connection.handleText(requestFrame(id, 'session.list', since === undefined ? {} : { since }))
  return answerOf(harness, id).r as RosterAnswer
}

/** @returns the ids one answer names as changed, or as the whole set. */
function idsOf(answer: RosterAnswer): string[] {
  const rows = answer.mode === 'reset' ? answer.sessions ?? [] : answer.changed ?? []
  return rows.map(row => row.id)
}

describe('session.list byte-level increments over protocol v1', () => {
  it('user asking for the roster for the first time receives the whole roster and a token', async () => {
    // Given a paired connection that declared delta.v1
    const harness = await deltaConnection()
    // When it lists sessions without a token
    const answer = await list(harness, 2, ['s-1', 's-2'])
    // Then the whole roster crosses, with the mode and the opaque token beside it
    expect(answer.mode).toBe('reset')
    expect(idsOf(answer)).toEqual(['s-1', 's-2'])
    expect(answer.token).not.toBe('')
    // And the token is opaque: it names a boot, a window secret and a revision
    expect(answer.token).toMatch(/^d1\.[0-9a-f]{16}\.[0-9a-f]{16}\.\d+$/)
  })

  it('user sending the token back with nothing changed receives an empty delta', async () => {
    // Given a connection holding the whole roster
    const harness = await deltaConnection()
    const first = await list(harness, 2, ['s-1', 's-2'])
    // When it sends that token and the host still answers the same rows
    const second = await list(harness, 3, ['s-1', 's-2'], first.token)
    // Then the answer is a delta carrying no row at all
    expect(second.mode).toBe('delta')
    expect(second.changed).toEqual([])
    expect(second.removed).toEqual([])
    // And the token advanced, so the next answer can be diffed against this one
    expect(second.token).not.toBe(first.token)
  })

  it('user is sent exactly the row whose body changed, even when its timestamp did not', async () => {
    // Given a connection holding two rows at one timestamp
    const harness = await deltaConnection()
    const first = await list(harness, 2, ['s-1', 's-2'])
    // When one row's running flag changes and its updatedAt stays the same
    harness.gateway.handler = async () => ({
      items: [summary('s-1'), summary('s-2', { running: true })],
    })
    await harness.connection.handleText(requestFrame(3, 'session.list', { since: first.token }))
    // Then exactly that row is the increment: the comparison is of the row, not
    // of a field the host happens to call a change signal
    const answer = answerOf(harness, 3).r as RosterAnswer
    expect(answer.mode).toBe('delta')
    expect(idsOf(answer)).toEqual(['s-2'])
    expect(answer.removed).toEqual([])
    expect((answer.changed?.[0] as { agentRunning?: boolean } | undefined)?.agentRunning).toBe(true)
  })

  it('user is told which id was removed instead of having it silently dropped', async () => {
    // Given a connection holding three rows
    const harness = await deltaConnection()
    const first = await list(harness, 2, ['s-1', 's-2', 's-3'])
    // When the host stops naming one of them
    const second = await list(harness, 3, ['s-1', 's-3'], first.token)
    // Then its id is in `removed` and the surviving rows are not resent
    expect(second.mode).toBe('delta')
    expect(second.removed).toEqual(['s-2'])
    expect(second.changed).toEqual([])
  })

  it('user sees a session archived between two listings come back as removed, not as a silent gap', async () => {
    // Given a connection holding three live sessions
    const { harness, set } = await archiveConnection()
    const first = await list(harness, 2, ['s-1', 's-2', 's-3'])
    expect(idsOf(first)).toEqual(['s-1', 's-2', 's-3'])
    // When one of them is archived while the connection stays open
    set(['s-2'])
    const second = await list(harness, 3, ['s-1', 's-2', 's-3'], first.token)
    // Then the increment names that id as a removal: the row is neither sent nor
    // silently forgotten, which is what a client holding it needs to let it go
    expect(second.mode).toBe('delta')
    expect(second.removed).toEqual(['s-2'])
    expect(second.changed).toEqual([])
  })

  it('user sees an archived session restored between two listings come back as changed', async () => {
    // Given a connection whose roster already lost an archived session
    const { harness, set } = await archiveConnection()
    set(['s-2'])
    const first = await list(harness, 2, ['s-1', 's-2', 's-3'])
    expect(idsOf(first)).toEqual(['s-1', 's-3'])
    // When it is restored
    set([])
    const second = await list(harness, 3, ['s-1', 's-2', 's-3'], first.token)
    // Then it comes back as a changed row, one that is not flagged archived
    expect(second.mode).toBe('delta')
    expect(idsOf(second)).toEqual(['s-2'])
    expect(second.removed).toEqual([])
    expect(second.changed?.[0]?.archived).toBe(false)
  })

  it('user replaying another connection\'s token is answered a reset', async () => {
    // Given two paired connections on one bridge process
    const first = await deltaConnection()
    const second = await deltaConnection()
    const issued = await list(first, 2, ['s-1'])
    // When the second one sends the first one's token
    const answer = await list(second, 2, ['s-1'], issued.token)
    // Then it is answered the whole roster: a base is never borrowed
    expect(answer.mode).toBe('reset')
    expect(idsOf(answer)).toEqual(['s-1'])
    expect(answer.token).not.toBe(issued.token)
    // And the first connection's own token still works, so nothing was reset
    const again = await list(first, 3, ['s-1'], issued.token)
    expect(again.mode).toBe('delta')
  })

  it('user sending an unknown or garbage token is answered a reset', async () => {
    // Given a connection that already holds a roster
    const harness = await deltaConnection()
    await list(harness, 2, ['s-1'])
    // When it sends three tokens this connection never issued
    const garbage = await list(harness, 10, ['s-1'], 'not-a-token')
    const foreign = await list(harness, 11, ['s-1'], 'd1.0000000000000000.0000000000000000.1')
    const empty = await list(harness, 12, ['s-1'], '')
    // Then every one of them answers the whole roster
    for (const answer of [garbage, foreign, empty]) {
      expect(answer.mode).toBe('reset')
      expect(idsOf(answer)).toEqual(['s-1'])
    }
  })

  it('user is answered a reset past the roster cap and no copy of it is retained', async () => {
    // Given a host whose roster is one row past what a window may retain
    const harness = await deltaConnection()
    const ids = Array.from({ length: ROSTER_DELTA_MAX_ROWS + 1 }, (_, index) => `s-${index}`)
    // When it lists that roster
    const first = await list(harness, 2, ids)
    // Then the whole roster crosses and the empty token says nothing was kept
    expect(first.mode).toBe('reset')
    expect(idsOf(first)).toHaveLength(ROSTER_DELTA_MAX_ROWS + 1)
    expect(first.token).toBe('')
    // And a second call cannot be an increment either
    const second = await list(harness, 3, ids, first.token)
    expect(second.mode).toBe('reset')
    expect(second.token).toBe('')
  })

  it('user whose roster mostly changed is answered a reset instead of a bigger delta', async () => {
    // Given a connection holding ten rows
    const harness = await deltaConnection()
    const ids = Array.from({ length: 10 }, (_, index) => `s-${index}`)
    const first = await list(harness, 2, ids)
    // When six of them change, the delta is still the smaller body
    harness.gateway.handler = async () => ({
      items: ids.map(id => summary(id, id < 's-6' ? { running: true } : {})),
    })
    await harness.connection.handleText(requestFrame(3, 'session.list', { since: first.token }))
    const boundary = answerOf(harness, 3).r as RosterAnswer
    // Then the answer is still an increment carrying those six rows
    expect(boundary.mode).toBe('delta')
    expect(boundary.changed).toHaveLength(6)
    // When seven of ten change against a base of ten, the answer flips to a
    // reset: past that share, the delta carries most of the body already
    // Then the whole roster is the answer
    const other = await deltaConnection()
    const base = await list(other, 2, ids)
    other.gateway.handler = async () => ({
      items: ids.map(id => summary(id, id < 's-7' ? { running: true } : {})),
    })
    await other.connection.handleText(requestFrame(3, 'session.list', { since: base.token }))
    const answer = answerOf(other, 3).r as RosterAnswer
    expect(answer.mode).toBe('reset')
    expect(answer.sessions).toHaveLength(10)
  })

  it('user who never declared delta.v1 is answered today\'s roster with an empty token and keeps no base', async () => {
    // Given a paired connection that declared no capability at all
    const harness = makeConnection({ paired: true })
    // When it lists sessions twice
    const first = await list(harness, 2, ['s-1'])
    const second = await list(harness, 3, ['s-1'], first.token)
    // Then both answers are resets carrying nothing to continue from: the keys
    // are additive, and no state is retained for a client that cannot use it
    expect(first.mode).toBe('reset')
    expect(first.token).toBe('')
    expect(second.mode).toBe('reset')
    expect(second.token).toBe('')
  })

  it('operator dropping a connection sees its incremental base released with it', async () => {
    // Given a connection that holds a roster
    const harness = await deltaConnection()
    const first = await list(harness, 2, ['s-1'])
    // When the connection is torn down
    harness.connection.dispose()
    // Then the token it was given names nothing: a fresh connection is answered
    // a reset, and this one answers nothing at all afterwards
    const fresh = await deltaConnection()
    const answer = await list(fresh, 2, ['s-1'], first.token)
    expect(answer.mode).toBe('reset')
  })

  it('operator changing one row of a 900-row roster receives a body a fraction of the whole', async () => {
    // Given a roster of the size a real deployment reaches
    const ids = Array.from({ length: 900 }, (_, index) => `session-${index.toString().padStart(4, '0')}`)
    const harness = await deltaConnection()
    harness.gateway.handler = async () => ({
      items: ids.map(id => summary(id, { updatedAt: 1_792_000_000_000, cwd: '/Users/zcl/code/dsh-web', agentAvailable: true })),
    })
    await harness.connection.handleText(requestFrame(2, 'session.list'))
    const resetBody = JSON.stringify(harness.transport.responseTo(2)?.r)
    const token = (answerOf(harness, 2).r as RosterAnswer).token
    // When exactly one row changes
    harness.gateway.handler = async () => ({
      items: ids.map(id => summary(id, {
        updatedAt: 1_792_000_000_000,
        cwd: '/Users/zcl/code/dsh-web',
        agentAvailable: true,
        ...(id === 'session-0450' ? { running: true } : {}),
      })),
    })
    await harness.connection.handleText(requestFrame(3, 'session.list', { since: token }))
    const answer = answerOf(harness, 3).r as RosterAnswer
    const deltaBody = JSON.stringify(answer)
    // Then the delta names that one row and is an order of magnitude smaller
    expect(answer.mode).toBe('delta')
    expect(idsOf(answer)).toEqual(['session-0450'])
    expect(new TextEncoder().encode(deltaBody).length).toBeLessThan(new TextEncoder().encode(resetBody).length / 10)
  })
})
