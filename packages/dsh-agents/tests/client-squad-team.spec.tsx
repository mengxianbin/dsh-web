// @vitest-environment jsdom
/**
 * The live team of the newest whole-squad run, and the run history beside it.
 *
 * The roster is read through `src/client/team-source.ts`: the shared session
 * store's `agentTeam` projection when this context serves one, and the proposed
 * read-only route otherwise. These cases prove both surfaces, the join between
 * the projected teammate and the member definition it runs as, that a live
 * surface update lands without a page reload, and that a plain M1 member run
 * keeps working exactly as it did.
 */
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsPage } from '../src/client/AgentsPage.tsx'
import { AgentsApiError } from '../src/client/host-api.ts'
import { t } from '../src/client/locales.ts'
import { projectionTeamSource, pollTeamSource, SQUAD_TEAM_POLL_INTERVAL_MS } from '../src/client/team-source.ts'
import type { SquadTeamSnapshot } from '../src/client/team-source.ts'
import { buttonByText, click, flush, mount, unmountAll } from './render.tsx'
import { agentTeamOf, fakeTeamSource, fakeTransport, memberOf, runOf, sessionListOf, squadRunOf, stateOf, teamOf } from './agents-fixtures.ts'

afterEach(() => {
  vi.useRealTimers()
  unmountAll()
})

/** The one element matching a selector, failing loudly when it is absent. */
function must(container: ParentNode, selector: string): Element {
  const found = container.querySelector(selector)
  if (found === null) throw new Error('no element matching ' + selector)
  return found
}

/** Open the single squad of a one-squad page. */
function openSquad(container: HTMLElement): void {
  click(must(container, '[aria-label="' + t('list.open', { name: 'Squad one' }) + '"]'))
}

describe('agents live team', () => {
  it('operator sees the Lead and its teammates with their status, model and permission', async () => {
    // Given a squad run whose Lead published a roster with one teammate
    const transport = fakeTransport({
      state: async () => stateOf([teamOf({ members: [memberOf()] })], [squadRunOf({ sessionId: 'lead-1' })]),
    })
    const teamSource = fakeTeamSource({
      state: 'ready',
      rows: agentTeamOf([{ id: 'teammate-session-1', name: 'Reviewer', phase: 'active' }], { leadSessionId: 'lead-1' }).members,
    })
    const opened: string[] = []
    const view = mount(<AgentsPage transport={transport} teamSource={teamSource} openSession={(sessionId: string) => { opened.push(sessionId) }} />)
    await flush()
    // When the operator opens that squad
    openSquad(view.container)
    // Then the page followed exactly the Lead session of the newest squad run
    expect(teamSource.watches).toEqual(['lead-1'])
    const rows = view.container.querySelectorAll('[data-dsh-part="squad-team-row"]')
    expect(rows).toHaveLength(2)
    // And the Lead row names the session the way the Host titled it, badges the
    // role instead of the bare machine name, and states its live phase
    expect(must(rows[0], 'h5').textContent).toBe('Squad one')
    expect(rows[0].textContent).toContain(t('squad.lead'))
    expect(rows[0].textContent).not.toContain('lead')
    expect(must(rows[0], '[role="status"]').textContent).toBe(t('squad.phase.active'))
    // And the teammate row carries the name the runtime gave it plus its pins
    expect(rows[1].textContent).toContain('Reviewer')
    expect(rows[1].textContent).toContain(t('squad.teammate'))
    expect(rows[1].textContent).toContain(t('permission.read-only'))
    expect(rows[1].textContent).toContain('deepseek/deepseek-v4')
    expect(must(rows[1], '[role="status"]').textContent).toBe(t('squad.phase.active'))
    // And its session entry point opens exactly that teammate session
    click(buttonByText(rows[1] as HTMLElement, t('member.openSession')))
    expect(opened).toEqual(['teammate-session-1'])
  })

  it('operator sees a teammate appear without leaving the page', async () => {
    // Given a squad run whose Lead has published nothing yet
    const transport = fakeTransport({
      state: async () => stateOf([teamOf({ members: [memberOf()] })], [squadRunOf({ sessionId: 'lead-1' })]),
    })
    const teamSource = fakeTeamSource({ state: 'pending' })
    const view = mount(<AgentsPage transport={transport} teamSource={teamSource} />)
    await flush()
    openSquad(view.container)
    expect(must(view.container, '[data-dsh-part="squad-team-state"]').textContent).toBe(t('squad.livePending'))
    // When the Lead publishes its first teammate
    act(() => {
      teamSource.publish({
        state: 'ready',
        rows: agentTeamOf([{ id: 'teammate-session-2', name: 'Reviewer', phase: 'provisioning' }], { leadSessionId: 'lead-1' }).members,
      })
    })
    // Then the waiting line is replaced by the roster, in the state it reports
    expect(view.container.querySelector('[data-dsh-part="squad-team-state"]')).toBeNull()
    const rows = view.container.querySelectorAll('[data-dsh-part="squad-team-row"]')
    expect(rows).toHaveLength(2)
    expect(must(rows[1], '[role="status"]').textContent).toBe(t('squad.phase.provisioning'))
  })

  it('operator sees a plain member run keep its M1 card and join the history unchanged', async () => {
    // Given a squad whose newest run is a single member session recorded before M2
    const transport = fakeTransport({
      state: async () => stateOf([teamOf({ members: [memberOf()] })], [runOf({ id: 'run-1', sessionId: 'session-1', createdAt: 500 })]),
    })
    const view = mount(<AgentsPage transport={transport} openSession={() => {}} />)
    await flush()
    // When the operator opens that squad
    openSquad(view.container)
    // Then the member card still reports its session in a live region
    const card = must(view.container, '[data-dsh-part="member-card"]')
    expect(card.textContent).toContain(t('member.status.running'))
    expect(must(card, '[data-dsh-part="member-run-status"]').getAttribute('role')).toBe('status')
    // And the history lists that member run with its state, instant and opener
    const row = must(view.container, '[data-dsh-variant="member-run"]')
    expect(row.textContent).toContain('Reviewer')
    expect(row.textContent).toContain(t('member.status.running'))
    expect(must(row, 'time').getAttribute('dateTime')).toBe('1970-01-01T00:00:00.500Z')
    // And no live roster is invented for a squad that never ran as a whole
    expect(must(view.container, '[data-dsh-part="squad-team"]').textContent).toContain(t('squad.liveNoRun'))
  })

  it('operator sees the live roster read from the shared session projection', () => {
    // Given a session catalog publishing the agentTeam projection of one Lead
    const published = { agentTeam: agentTeamOf([{ id: 'teammate-session-1', name: 'Reviewer', phase: 'active' }], { leadSessionId: 'lead-1' }) }
    const list = sessionListOf({ 'lead-1': published })
    const source = projectionTeamSource(list)
    const seen: SquadTeamSnapshot[] = []
    // When the page follows that Lead session
    const stop = source.watch('lead-1', (snapshot: SquadTeamSnapshot) => { seen.push(snapshot) })
    // Then the roster arrives with no request at all, and the same published
    // reference never re-renders it
    expect(source.kind).toBe('projection')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ state: 'ready' })
    list.set('lead-1', published)
    expect(seen).toHaveLength(1)
    // And a new published roster lands as one more snapshot
    list.set('lead-1', { agentTeam: agentTeamOf([
      { id: 'teammate-session-1', name: 'Reviewer', phase: 'active' },
      { id: 'teammate-session-2', name: 'Builder', phase: 'active' },
    ], { leadSessionId: 'lead-1' }) })
    expect(seen).toHaveLength(2)
    // And nothing lands after the page stops following
    stop()
    list.set('lead-1', { agentTeam: agentTeamOf([], { leadSessionId: 'lead-1' }) })
    expect(seen).toHaveLength(2)
  })

  it('operator sees the proposed roster route answer when the session store is out of reach', async () => {
    // Given a deployment whose only live-team surface is the proposed read route
    const transport = fakeTransport({
      state: async () => stateOf([teamOf({ members: [memberOf()] })], [squadRunOf({ sessionId: 'lead-1' })]),
      squadTeam: async (sessionId: string) => agentTeamOf([{ id: 'teammate-session-1', name: 'Reviewer', phase: 'active' }], { leadSessionId: sessionId }),
    })
    const view = mount(<AgentsPage transport={transport} teamSource={pollTeamSource(transport)} />)
    await flush()
    // When the operator opens that squad
    openSquad(view.container)
    await flush()
    // Then the roster renders from that route, asked for the Lead session
    expect(view.container.querySelectorAll('[data-dsh-part="squad-team-row"]')).toHaveLength(2)
    expect(transport.teamReads).toBe(1)
  })

  it('operator sees a deployment without the roster route say so once instead of polling forever', async () => {
    // Given a Host that does not serve the proposed route
    vi.useFakeTimers()
    const transport = fakeTransport({
      state: async () => stateOf([]),
      squadTeam: async () => { throw new AgentsApiError('not-mounted', t('error.notMounted')) },
    })
    const seen: SquadTeamSnapshot[] = []
    // When the page follows a Lead session through the fallback poll
    const stop = pollTeamSource(transport).watch('lead-1', (snapshot: SquadTeamSnapshot) => { seen.push(snapshot) })
    await vi.advanceTimersByTimeAsync(0)
    // Then live state reads as unavailable, and the poll stops for good
    expect(seen).toEqual([{ state: 'unavailable' }])
    await vi.advanceTimersByTimeAsync(SQUAD_TEAM_POLL_INTERVAL_MS * 3)
    expect(transport.teamReads).toBe(1)
    stop()
  })
})
