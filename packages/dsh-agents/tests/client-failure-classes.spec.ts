// @vitest-environment jsdom
/**
 * Failure classes of the agents transport.
 *
 * The page branches on a stable class, never on a fetch or JSON message, so
 * every Host answer - a missing route, the authentication fence, a refused run
 * and a broken body - has to arrive as one of the documented classes with copy
 * from the dictionary.
 */
import { describe, expect, it } from 'vitest'
import { AgentsApiError, createAgentsTransport } from '../src/client/host-api.ts'
import { t } from '../src/client/locales.ts'
import type { AgentsStateView } from '../src/protocol.ts'

const EMPTY_STATE: AgentsStateView = { teams: [], runs: [], host: { ownerPid: 4242 } }

/** A fetch double that answers every call with a fresh response. */
function fetchAnswering(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch
}

/** Read the class and copy of one refused read. */
async function readFailure(fetchImpl: typeof fetch): Promise<{ failure: string; message: string }> {
  try {
    await createAgentsTransport(fetchImpl).state()
  } catch (error) {
    if (!(error instanceof AgentsApiError)) throw error
    return { failure: error.failure, message: error.message }
  }
  throw new Error('the read was expected to fail')
}

describe('agents transport failure classes', () => {
  it('operator sees a missing Host route read as the not-mounted class', async () => {
    // Given a Host that answers the state route with the webserver's bare text
    // When the page reads the state
    const failure = await readFailure(fetchAnswering(404, 'not found'))
    // Then it is the missing-route class with its own copy, not a parse error
    expect(failure.failure).toBe('not-mounted')
    expect(failure.message).toBe(t('error.notMounted'))
  })

  it('operator sees the authentication and same-origin fences named apart', async () => {
    // Given Host answers of 401 and 403
    // When the page reads the state
    const unauthorized = await readFailure(fetchAnswering(401, ''))
    const forbidden = await readFailure(fetchAnswering(403, ''))
    // Then each keeps its own class and sentence
    expect(unauthorized.failure).toBe('unauthorized')
    expect(unauthorized.message).toBe(t('error.unauthorized'))
    expect(forbidden.failure).toBe('forbidden')
    expect(forbidden.message).toBe(t('error.forbidden'))
  })

  it('operator sees an unreadable successful response read as unexpected', async () => {
    // Given a 200 whose body is not JSON
    // When the page reads the state
    const failure = await readFailure(fetchAnswering(200, 'not found'))
    // Then the status is reported in the copy instead of a parse message
    expect(failure.failure).toBe('unexpected')
    expect(failure.message).toBe(t('error.unexpected', { status: '200' }))
  })

  it('operator sees an unreachable Host read as its own class', async () => {
    // Given a fetch that cannot reach the service
    const offline = (async () => { throw new TypeError('network down') }) as unknown as typeof fetch
    // When the page reads the state
    const failure = await readFailure(offline)
    // Then the page can offer the restart hint
    expect(failure.failure).toBe('unreachable')
    expect(failure.message).toBe(t('error.unreachable'))
  })

  it('operator sees the unknown-preset refusal of a run keep its own class', async () => {
    // Given a Host that refuses the run because the pinned preset is absent
    const refusing = fetchAnswering(409, '{"ok":false,"code":"preset-unknown","error":"The pinned preset is not in the registry."}')
    // When the member is started
    try {
      await createAgentsTransport(refusing).run('team-1', 'member-1')
      throw new Error('the run was expected to be refused')
    } catch (error) {
      // Then the card can say what to change instead of showing a status code
      if (!(error instanceof AgentsApiError)) throw error
      expect(error.failure).toBe('unknown-preset')
      expect(error.message).toBe(t('error.unknownPreset'))
    }
  })

  it('operator sees the no-workspace refusal of a run keep its own class', async () => {
    // Given a Host that refuses the run because the pinned workspace is gone
    const refusing = fetchAnswering(409, '{"ok":false,"code":"workspace-unknown","error":"The pinned workspace is not in the registry."}')
    // When the member is started
    try {
      await createAgentsTransport(refusing).run('team-1', 'member-1')
      throw new Error('the run was expected to be refused')
    } catch (error) {
      // Then the copy names the workspace as the thing to fix
      if (!(error instanceof AgentsApiError)) throw error
      expect(error.failure).toBe('no-workspace')
      expect(error.message).toBe(t('error.noWorkspace'))
    }
  })

  it('operator sees a refusal without its own class carry the Host sentence', async () => {
    // Given a Host refusal this page has no class for (the M2 mapping names the
    // ledger, the Lead and the squad apart, so the generic class is proven with
    // a code outside every table)
    const refusing = fetchAnswering(500, '{"ok":false,"code":"internal-error","error":"the dsh-agents host failed to serve this request"}')
    // When the member is started
    try {
      await createAgentsTransport(refusing).run('team-1', 'member-1')
      throw new Error('the run was expected to be refused')
    } catch (error) {
      // Then the generic rejection class still shows the Host's own sentence
      if (!(error instanceof AgentsApiError)) throw error
      expect(error.failure).toBe('rejected')
      expect(error.message).toBe(t('error.rejected', { detail: 'the dsh-agents host failed to serve this request' }))
    }
  })

  it('operator sees the M2 squad-run refusals mapped to their own classes', async () => {
    // Given the Host codes a whole-squad launch adds
    const cases = [
      { code: 'session-create-failed', failure: 'lead-create-failed', copy: t('error.leadCreateFailed') },
      { code: 'session-rename-failed', failure: 'lead-prepare-failed', copy: t('error.leadPrepareFailed') },
      { code: 'team-not-found', failure: 'squad-missing', copy: t('error.squadMissing') },
      { code: 'ledger-owned', failure: 'ledger-unavailable', copy: t('error.ledgerUnavailable') },
    ]
    for (const expected of cases) {
      // When the squad run is refused with that code
      const refusing = fetchAnswering(409, JSON.stringify({ ok: false, code: expected.code, error: 'raw host text' }))
      try {
        await createAgentsTransport(refusing).runSquad({ teamId: 'team-1', goal: 'Ship the review notes' })
        throw new Error('the squad run was expected to be refused')
      } catch (error) {
        // Then the page can say what to fix instead of repeating the Host text
        if (!(error instanceof AgentsApiError)) throw error
        expect(error.failure).toBe(expected.failure)
        expect(error.message).toBe(expected.copy)
      }
    }
  })

  it('operator sees a readable state pass through with no failure at all', async () => {
    // Given a Host that answers the frozen shape
    // When the page reads the state
    const state = await createAgentsTransport(fetchAnswering(200, JSON.stringify(EMPTY_STATE))).state()
    // Then the document is returned as published
    expect(state).toEqual(EMPTY_STATE)
  })

  it('operator sees the browser half address the routes document-relative', async () => {
    // Given a fetch that records where it was sent
    const seen: string[] = []
    const recording = (async (input: string) => { seen.push(input); return new Response(JSON.stringify(EMPTY_STATE), { status: 200 }) }) as unknown as typeof fetch
    // When the page reads the state
    await createAgentsTransport(recording).state()
    // Then the leading slash is dropped, so a sub-path deployment stays inside
    // its entry directory
    expect(seen).toEqual(['dsh-agents/api/state'])
  })
})
