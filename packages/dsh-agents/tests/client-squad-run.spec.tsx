// @vitest-environment jsdom
/**
 * The whole-squad action of the agents page.
 *
 * A squad run posts the goal the operator typed to `POST /squad/run`, reports
 * the Lead session it started in a live region, and puts that Lead in the run
 * history with an entry point into it. Every refusal the Host can answer with
 * reaches the panel as a sentence: the three M1 families (unknown preset, no
 * workspace, route missing) and the M2 families a squad launch adds (a Lead the
 * Host could not create or prepare, a squad that vanished, a ledger it cannot
 * write). No machine code ever reaches the page.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AgentsPage } from '../src/client/AgentsPage.tsx'
import { createAgentsTransport } from '../src/client/host-api.ts'
import type { AgentsTransport } from '../src/client/host-api.ts'
import { t } from '../src/client/locales.ts'
import { buttonByText, click, flush, mount, selectOption, typeInto, unmountAll } from './render.tsx'
import { fakeTransport, memberOf, squadRunOf, stateOf, teamOf } from './agents-fixtures.ts'
import type { AgentsStateView, RunRecord } from '../src/protocol.ts'

afterEach(() => { unmountAll() })

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

/** Type a goal into the run panel and press its primary action. */
function runSquadWithGoal(container: HTMLElement, goal: string): void {
  const panel = must(container, '[data-dsh-part="squad-run"]')
  typeInto(must(panel, 'textarea') as HTMLTextAreaElement, goal)
  click(buttonByText(panel as HTMLElement, t('squad.run')))
}

/** The live region the run panel reports into. */
function runStatus(container: ParentNode): Element {
  return must(container, '[data-dsh-part="squad-run-status"]')
}

/**
 * A real transport whose state read succeeds and whose squad run is refused.
 * The refusal is the frozen wire body, so the page meets the same classes a
 * real Host produces.
 * @param status - HTTP status of the refusal.
 * @param body - raw refusal body.
 */
function hostRefusing(status: number, body: string): AgentsTransport {
  const state: AgentsStateView = stateOf([teamOf({ members: [memberOf()] })])
  const fetchImpl = (async (input: string) => (String(input).endsWith('dsh-agents/api/state')
    ? new Response(JSON.stringify(state), { status: 200 })
    : new Response(body, { status }))) as unknown as typeof fetch
  return createAgentsTransport(fetchImpl)
}

describe('agents squad run', () => {
  it('operator sees the squad run post the goal and report the Lead session it started', async () => {
    // Given a squad with one member and a Host that leads it with a Lead session
    let runs: RunRecord[] = []
    const transport = fakeTransport({
      state: async () => stateOf([teamOf({ members: [memberOf()] })], runs),
      runSquad: async (request) => {
        const run = squadRunOf({ sessionId: 'lead-9', createdAt: 2_000, ...(request.goal === undefined ? {} : { goal: request.goal }) })
        runs = [run]
        return run
      },
    })
    const opened: string[] = []
    const view = mount(<AgentsPage transport={transport} openSession={(sessionId: string) => { opened.push(sessionId) }} />)
    await flush()
    openSquad(view.container)
    // When the operator types a goal and runs the squad
    runSquadWithGoal(view.container, 'Ship the review notes')
    await flush()
    // Then the Host was asked to lead this squad with exactly that goal
    expect(transport.squadRequests).toEqual([{ teamId: 'team-1', goal: 'Ship the review notes' }])
    // And the panel reports the Lead session it opened in a live region
    const status = runStatus(view.container)
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toBe(t('squad.runStarted', { session: 'lead-9' }))
    // And the history carries the Lead run with an entry point into that session
    const row = must(view.container, '[data-dsh-variant="squad-run"]')
    expect(row.textContent).toContain(t('squad.kind.squad'))
    expect(row.textContent).toContain(t('member.status.running'))
    expect(row.textContent).toContain(t('squad.goalLine', { goal: 'Ship the review notes' }))
    click(buttonByText(row as HTMLElement, t('member.openSession')))
    expect(opened).toEqual(['lead-9'])
  })

  it('operator sees the three M1 refusals of a squad run as sentences, never as codes', async () => {
    // Given a Host that can refuse a squad run for its three familiar reasons
    const refusals = [
      { status: 409, body: '{"ok":false,"code":"preset-unknown","error":"the host agent-preset registry has no preset"}', copy: t('error.unknownPreset'), code: 'preset-unknown' },
      { status: 409, body: '{"ok":false,"code":"workspace-unknown","error":"the pinned workspace is not in the host registry"}', copy: t('error.noWorkspace'), code: 'workspace-unknown' },
      { status: 404, body: 'not found', copy: t('error.notMounted'), code: 'not found' },
    ]
    for (const refusal of refusals) {
      // When the operator runs the squad against that refusal
      const view = mount(<AgentsPage transport={hostRefusing(refusal.status, refusal.body)} />)
      await flush()
      openSquad(view.container)
      runSquadWithGoal(view.container, 'Ship the review notes')
      await flush()
      // Then the panel states that family's sentence and nothing machine-shaped
      expect(runStatus(view.container).textContent).toBe(refusal.copy)
      expect(view.container.textContent).not.toContain(refusal.code)
      unmountAll()
    }
  })

  it('operator sees a Lead the Host could not launch named apart from a generic refusal', async () => {
    // Given a Host that answers with the M2 squad-run codes
    const refusals = [
      { code: 'session-create-failed', copy: t('error.leadCreateFailed') },
      { code: 'session-rename-failed', copy: t('error.leadPrepareFailed') },
      { code: 'session-prompt-failed', copy: t('error.leadPrepareFailed') },
      { code: 'team-not-found', copy: t('error.squadMissing') },
      { code: 'ledger-owned', copy: t('error.ledgerUnavailable') },
    ]
    const hostSentence = 'host sentence that must not reach the page'
    for (const refusal of refusals) {
      // When the operator runs the squad and the Host refuses with that code
      const view = mount(<AgentsPage transport={hostRefusing(409, JSON.stringify({ ok: false, code: refusal.code, error: hostSentence }))} />)
      await flush()
      openSquad(view.container)
      runSquadWithGoal(view.container, 'Ship the review notes')
      await flush()
      // Then each family reads as its own copy, not as the Host's raw sentence
      expect(runStatus(view.container).textContent).toBe(refusal.copy)
      expect(view.container.textContent).not.toContain(hostSentence)
      unmountAll()
    }
  })

  it('operator sees a chosen Lead preset applied to the squad before the run it configures', async () => {
    // Given a Host that reports two Lead presets and a squad that pins none
    const transport = fakeTransport({
      state: async () => stateOf([teamOf({ members: [memberOf()] })], [], ['squad-lead', 'research-lead']),
      createTeam: async (draft) => teamOf({ ...draft, id: 'team-1' }),
      runSquad: async () => squadRunOf({ sessionId: 'lead-5' }),
    })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    openSquad(view.container)
    const panel = must(view.container, '[data-dsh-part="squad-run"]')
    // When the operator picks the second reported preset and runs the squad
    selectOption(must(panel, 'select') as HTMLSelectElement, 'research-lead')
    click(buttonByText(panel as HTMLElement, t('squad.run')))
    await flush()
    // Then the squad carries that Lead preset, and the run follows the save
    expect(transport.teamSaves).toEqual([{
      id: 'team-1',
      name: 'Squad one',
      description: 'Two reviewers and one builder',
      workspaceId: 'workspace-main',
      leadPreset: 'research-lead',
    }])
    expect(transport.squadRequests).toEqual([{ teamId: 'team-1' }])
    expect(runStatus(view.container).textContent).toBe(t('squad.runStarted', { session: 'lead-5' }))
  })

  it('operator sees a squad that already pins the Lead preset run without a rewrite', async () => {
    // Given a Host that reports presets and a squad already pinned to one of them
    const transport = fakeTransport({
      state: async () => stateOf([teamOf({ members: [memberOf()], leadPreset: 'squad-lead' })], [], ['squad-lead', 'research-lead']),
      runSquad: async () => squadRunOf({ sessionId: 'lead-6' }),
    })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    openSquad(view.container)
    // When the operator runs the squad without changing the picker
    click(buttonByText(must(view.container, '[data-dsh-part="squad-run"]') as HTMLElement, t('squad.run')))
    await flush()
    // Then the definition is left exactly as it was and only the run is posted
    expect(transport.teamSaves).toEqual([])
    expect(transport.squadRequests).toEqual([{ teamId: 'team-1' }])
  })

  it('operator sees no invented preset options when the Host reports none', async () => {
    // Given a Host that reports no preset list and a squad that pins a Lead preset
    const transport = fakeTransport({ state: async () => stateOf([teamOf({ members: [memberOf()], leadPreset: 'squad-lead' })]) })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    // When the operator opens the squad
    openSquad(view.container)
    // Then the panel states the squad's own Lead preset and offers no picker
    const panel = must(view.container, '[data-dsh-part="squad-run"]')
    expect(panel.querySelector('select')).toBeNull()
    expect(must(panel, '[data-dsh-part="squad-lead-preset"]').textContent).toBe('squad-lead')
  })
})
