// @vitest-environment jsdom
/**
 * The states of the agents page: loading, empty, list, error and the member
 * card itself.
 *
 * These cases mount the real page over a fake transport, so what they assert
 * is the DOM a user sees on the phone: the sentence in each state, every squad
 * row, and the five facts a member card carries.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AgentsPage } from '../src/client/AgentsPage.tsx'
import { AgentsApiError } from '../src/client/host-api.ts'
import { t } from '../src/client/locales.ts'
import css from '../src/client/agents.module.css'
import { buttonByText, click, flush, mount, typeInto, unmountAll } from './render.tsx'
import { fakeTransport, memberOf, stateOf, teamOf } from './agents-fixtures.ts'

afterEach(() => { unmountAll() })

/** The one element matching a selector, failing loudly when it is absent. */
function must(container: ParentNode, selector: string): Element {
  const found = container.querySelector(selector)
  if (found === null) throw new Error('no element matching ' + selector)
  return found
}

describe('agents page states', () => {
  it('operator sees a loading sentence until the first read lands', () => {
    // Given a Host that has not answered the first read yet
    const transport = fakeTransport({ state: () => new Promise(() => {}) })
    // When the page mounts
    const view = mount(<AgentsPage transport={transport} />)
    // Then the loading sentence is announced instead of an empty list
    const loading = must(view.container, '[data-dsh-part="agents-loading"]')
    expect(loading.textContent).toBe(t('agents.loading'))
    expect(loading.getAttribute('role')).toBe('status')
  })

  it('operator sees the empty state when no squad exists', async () => {
    // Given a Host that publishes no squad
    const transport = fakeTransport({ state: async () => stateOf([]) })
    // When the page reads the state
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    // Then the empty state explains what a squad is for, and offers to create one
    const empty = must(view.container, '[data-dsh-part="squad-empty"]')
    expect(empty.textContent).toContain(t('list.empty'))
    expect(empty.textContent).toContain(t('list.emptyHint'))
    expect(buttonByText(view.container, t('list.new')).tagName).toBe('BUTTON')
  })

  it('operator sees every squad with its member count and opens one with one tap', async () => {
    // Given two squads, one with a member and one empty
    const transport = fakeTransport({
      state: async () => stateOf([
        teamOf({ id: 'team-1', name: 'Squad one', members: [memberOf()] }),
        teamOf({ id: 'team-2', name: 'Squad two', members: [] }),
      ]),
    })
    // When the page reads the state
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    // Then both rows carry their own member count
    expect(view.container.textContent).toContain('Squad one')
    expect(view.container.textContent).toContain('Squad two')
    expect(view.container.textContent).toContain(t('list.memberCount', { count: '1' }))
    expect(view.container.textContent).toContain(t('list.memberCount', { count: '0' }))
    // When the first row is tapped
    click(must(view.container, '[aria-label="' + t('list.open', { name: 'Squad one' }) + '"]'))
    // Then the detail view lists that squad's members
    expect(must(view.container, '[data-dsh-part="squad-detail"]').textContent).toContain('Reviewer')
    expect(view.container.querySelector('[aria-label="' + t('list.open', { name: 'Squad two' }) + '"]')).toBeNull()
  })

  it('operator sees a failed first read as the error state with a retry control', async () => {
    // Given a Host whose routes are not mounted
    const transport = fakeTransport({ state: async () => { throw new AgentsApiError('not-mounted', t('error.notMounted')) } })
    // When the page reads the state
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    // Then the failure class copy is announced, with a way to try again
    const error = must(view.container, '[data-dsh-part="agents-error"]')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain(t('error.notMounted'))
    expect(buttonByText(view.container, t('agents.retry')).tagName).toBe('BUTTON')
  })

  it('operator sees a member card carry name, preset, permission, model and a clamped brief', async () => {
    // Given a squad whose member pins every field
    const member = memberOf()
    const transport = fakeTransport({ state: async () => stateOf([teamOf({ members: [member] })]) })
    // When the squad is opened
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    click(must(view.container, '[aria-label="' + t('list.open', { name: 'Squad one' }) + '"]'))
    // Then the card names all five facts, and the brief sits in the clamp wrapper
    const card = must(view.container, '[data-dsh-part="member-card"]')
    expect(card.textContent).toContain('Reviewer')
    expect(card.textContent).toContain('standard')
    expect(card.textContent).toContain(t('permission.read-only'))
    expect(card.textContent).toContain('deepseek/deepseek-v4')
    const brief = must(view.container, '[data-dsh-part="member-brief"]')
    expect(brief.className).toBe(css.memberBrief)
    expect(brief.textContent).toBe(member.brief)
    // Then a member that never ran offers the run action and nothing else
    expect(buttonByText(view.container, t('member.run')).tagName).toBe('BUTTON')
    expect(view.container.textContent).not.toContain(t('member.openSession'))
  })

  it('operator sees an unpinned member read as inherited, never as a blank field', async () => {
    // Given a member that pins no preset, permission or model
    const transport = fakeTransport({
      state: async () => stateOf([teamOf({ members: [memberOf({ preset: undefined, permission: undefined, model: undefined, brief: undefined })] })]),
    })
    // When the squad is opened
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    click(must(view.container, '[aria-label="' + t('list.open', { name: 'Squad one' }) + '"]'))
    // Then every unpinned field says it inherits the Host default
    const card = must(view.container, '[data-dsh-part="member-card"]')
    const inherited = card.textContent?.split(t('member.inherit')).length ?? 0
    expect(inherited - 1).toBe(3)
  })
})

describe('the squad form', () => {
  it('user cannot create a squad before it has a name, and both pickers offer what the Host reports', async () => {
    // Given a Host reporting presets and workspaces, When the new-squad form opens, Then create stays disabled until a name is typed, both pickers carry their rows, and the preview follows the name.
    const transport = fakeTransport({
      state: async () => stateOf([teamOf()], [], ['xundong'], [{ id: 'ws-1', title: 'repo', path: '/repo' }]),
    })
    const page = mount(<AgentsPage transport={transport} />)
    await flush()
    click(buttonByText(page.container, t('list.new')))
    await flush()
    const form = must(page.container, '[data-dsh-part="team-form"]')
    const create = buttonByText(form as HTMLElement, t('form.create'))
    expect(create.disabled).toBe(true)
    typeInto(must(form, 'input') as HTMLInputElement, 'Architecture review')
    expect(create.disabled).toBe(false)
    const workspace = must(form, 'select[aria-label="' + t('form.workspace') + '"]') as HTMLSelectElement
    expect([...workspace.options].map(option => option.textContent)).toEqual([t('form.workspaceInherit'), 'repo'])
    const preset = must(form, 'select[aria-label="' + t('form.leadPreset') + '"]') as HTMLSelectElement
    expect([...preset.options].map(option => option.textContent)).toEqual([t('squad.leadPresetInherit'), 'xundong'])
    expect(must(form, '[data-dsh-part="team-form-preview"]').textContent).toContain('Architecture review')
  })

  it('user picks the workspace from a list even when the Host reports no registry, and binding none is the only row', async () => {
    // Given a Host that publishes an empty workspace list, When the new-squad form opens, Then the workspace field is still a picker whose one row binds none.
    const transport = fakeTransport({ state: async () => stateOf([teamOf()], [], undefined, []) })
    const page = mount(<AgentsPage transport={transport} />)
    await flush()
    click(buttonByText(page.container, t('list.new')))
    await flush()
    const form = must(page.container, '[data-dsh-part="team-form"]')
    const workspace = must(form, 'select[aria-label="' + t('form.workspace') + '"]') as HTMLSelectElement
    expect(workspace.tagName).toBe('SELECT')
    expect([...workspace.options].map(option => option.textContent)).toEqual([t('form.workspaceInherit')])
    expect(workspace.value).toBe('')
    // And its field carries no text box: an unbound squad is a choice, not a blank to fill.
    expect((workspace.parentElement as HTMLElement).querySelectorAll('input')).toHaveLength(0)
    // The Lead preset is the only field left that falls back to typing an id.
    expect(form.querySelectorAll('select')).toHaveLength(1)
    expect(form.querySelectorAll('input')).toHaveLength(2)
  })

  it('user sees a workspace the Host no longer lists kept in the picker and submitted unchanged', async () => {
    // Given a squad pinned to a workspace the registry does not report, When its form opens, Then that pin is its own row and saving keeps it.
    const transport = fakeTransport({
      state: async () => stateOf([teamOf({ workspaceId: 'workspace-gone' })], [], undefined, [{ id: 'ws-1', title: 'repo', path: '/repo' }]),
      createTeam: async (draft) => teamOf({ ...draft, id: 'team-1' }),
    })
    const page = mount(<AgentsPage transport={transport} />)
    await flush()
    click(must(page.container, '[aria-label="' + t('list.open', { name: 'Squad one' }) + '"]'))
    await flush()
    click(buttonByText(page.container, t('detail.editTeam')))
    await flush()
    const form = must(page.container, '[data-dsh-part="team-form"]')
    const workspace = must(form, 'select[aria-label="' + t('form.workspace') + '"]') as HTMLSelectElement
    // Then the pin stays listed, stays selected, and is labelled as unlisted
    expect([...workspace.options].map(option => option.value)).toEqual(['', 'ws-1', 'workspace-gone'])
    expect([...workspace.options].map(option => option.textContent)).toEqual([t('form.workspaceInherit'), 'repo', 'workspace-gone' + t('form.workspaceUnlisted')])
    expect(workspace.value).toBe('workspace-gone')
    // And a save that never touches the field submits the pin it arrived with
    click(buttonByText(form as HTMLElement, t('form.save')))
    await flush()
    expect(transport.teamSaves.map(draft => draft.workspaceId)).toEqual(['workspace-gone'])
  })

  it('user drafts the description with the Host model and sees the reply in the field', async () => {
    // Given a Host model that answers, When generate is pressed, Then the page posts the name and intent once and the reply lands in the textarea.
    const transport = fakeTransport({
      state: async () => stateOf([teamOf()]),
      describe: async () => 'Two reviewers and one builder.',
    })
    const page = mount(<AgentsPage transport={transport} />)
    await flush()
    click(buttonByText(page.container, t('list.new')))
    await flush()
    const form = must(page.container, '[data-dsh-part="team-form"]')
    typeInto(must(form, 'input') as HTMLInputElement, 'Architecture review')
    typeInto(must(form, 'textarea') as HTMLTextAreaElement, '评审架构')
    click(buttonByText(form as HTMLElement, t('form.generate')))
    await flush()
    expect(transport.describes).toEqual([{ name: 'Architecture review', intent: '评审架构' }])
    expect((must(form, 'textarea') as HTMLTextAreaElement).value).toBe('Two reviewers and one builder.')
  })

  it('user is told why the model could not draft and is offered the template instead', async () => {
    // Given a Host model that refuses, When generate is pressed on an empty description, Then the failure sentence is shown and the template fills the field.
    const transport = fakeTransport({
      state: async () => stateOf([teamOf()]),
      describe: async () => { throw new Error(t('error.describeFailed', { detail: 'timeout' })) },
    })
    const page = mount(<AgentsPage transport={transport} />)
    await flush()
    click(buttonByText(page.container, t('list.new')))
    await flush()
    const form = must(page.container, '[data-dsh-part="team-form"]')
    typeInto(must(form, 'input') as HTMLInputElement, 'Architecture review')
    click(buttonByText(form as HTMLElement, t('form.generate')))
    await flush()
    expect(form.textContent).toContain('timeout')
    expect((must(form, 'textarea') as HTMLTextAreaElement).value).toContain('Architecture review')
  })
})
