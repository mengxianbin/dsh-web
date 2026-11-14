// @vitest-environment jsdom
/**
 * The member form's two pickers: the model routes and the reasoning levels the
 * Host publishes, the inherit row that clears a pin, and the stored value the
 * live catalog no longer lists — which stays selectable and labelled, because a
 * saved pin must never vanish from the field that owns it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AgentsPage } from '../src/client/AgentsPage.tsx'
import { t } from '../src/client/locales.ts'
import { buttonByText, click, flush, mount, selectOption, typeInto, unmountAll } from './render.tsx'
import { fakeTransport, memberOf, stateOf, teamOf } from './agents-fixtures.ts'
import type { AgentsModelOption, AgentsStateView, MemberDraft, TeamDefinition } from '../src/protocol.ts'

afterEach(() => { unmountAll() })

/** A catalog a Host might publish: one labelled route and one it never described. */
const MODELS: readonly AgentsModelOption[] = [
  { provider: 'deepseek', model: 'deepseek-v4', label: 'DeepSeek V4', efforts: ['low', 'high'] },
  { provider: 'anthropic', model: 'sonnet' },
]

/** The deployment-wide levels the same Host publishes. */
const EFFORTS = ['low', 'high', 'max']

/** The state a Host publishes when its model catalog is readable. */
function catalogState(teams: TeamDefinition[], models: readonly AgentsModelOption[] = MODELS, efforts: readonly string[] = EFFORTS): AgentsStateView {
  return { ...stateOf(teams), models, efforts }
}

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

/** The options of one select, as the value/label pairs the user reads. */
function optionsOf(select: HTMLSelectElement): Array<{ value: string; label: string }> {
  return [...select.options].map(option => ({ value: option.value, label: option.textContent ?? '' }))
}

/** The one option carrying a value, failing loudly when the select does not offer it. */
function optionOf(select: HTMLSelectElement, value: string): HTMLOptionElement {
  const found = [...select.options].find(option => option.value === value)
  if (found === undefined) throw new Error('no option with value ' + value)
  return found
}

describe('the member form model and level pickers', () => {
  it('operator picks from the routes and levels this Host published', async () => {
    // Given a Host publishing a catalog, When the add-member form opens, Then both fields are selects offering exactly those options after the inherit row.
    const transport = fakeTransport({ state: async () => catalogState([teamOf({ members: [] })]) })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    openSquad(view.container)
    click(buttonByText(view.container, t('detail.addMember')))
    const form = must(view.container, '[data-dsh-part="member-form"]')
    const models = must(form, 'select[name="model"]') as HTMLSelectElement
    const levels = must(form, 'select[name="reasoningEffort"]') as HTMLSelectElement
    expect(optionsOf(models)).toEqual([
      { value: '', label: t('member.inherit') },
      { value: 'deepseek/deepseek-v4', label: 'DeepSeek V4' },
      { value: 'anthropic/sonnet', label: 'anthropic/sonnet' },
    ])
    expect(optionsOf(levels)).toEqual([
      { value: '', label: t('form.effortInherit') },
      { value: 'low', label: 'low' },
      { value: 'high', label: 'high' },
      { value: 'max', label: 'max' },
    ])
  })

  it('operator clears a pinned model and level by choosing the inherit rows, and the draft carries no pin', async () => {
    // Given a member pinned to a listed route and level, When both inherit rows are chosen and the form saved, Then the draft asks the Host to inherit both.
    const saved: MemberDraft[] = []
    const transport = fakeTransport({
      state: async () => catalogState([teamOf({ members: [memberOf({ reasoningEffort: 'high' })] })]),
      saveMember: async (_teamId: string, draft: MemberDraft) => {
        saved.push(draft)
        return teamOf({ members: [memberOf()] })
      },
    })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    openSquad(view.container)
    click(buttonByText(view.container, t('member.edit')))
    const form = must(view.container, '[data-dsh-part="member-form"]')
    const models = must(form, 'select[name="model"]') as HTMLSelectElement
    const levels = must(form, 'select[name="reasoningEffort"]') as HTMLSelectElement
    expect(models.value).toBe('deepseek/deepseek-v4')
    expect(levels.value).toBe('high')
    selectOption(models, '')
    selectOption(levels, '')
    click(buttonByText(view.container, t('form.save')))
    await flush()
    expect(saved).toHaveLength(1)
    expect(saved[0].model).toBe('')
    expect(saved[0].reasoningEffort).toBe('')
  })

  it('operator still sees and can keep a pinned model and level the live catalog does not list', async () => {
    // Given a member pinned to a route and level this catalog dropped, When the form opens, Then both stay selected and are labelled as unlisted rather than vanishing.
    const transport = fakeTransport({
      state: async () => catalogState([teamOf({ members: [memberOf({ model: 'gone/v9', reasoningEffort: 'ultra' })] })]),
    })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    openSquad(view.container)
    click(buttonByText(view.container, t('member.edit')))
    const form = must(view.container, '[data-dsh-part="member-form"]')
    const models = must(form, 'select[name="model"]') as HTMLSelectElement
    const levels = must(form, 'select[name="reasoningEffort"]') as HTMLSelectElement
    expect(models.value).toBe('gone/v9')
    expect(optionOf(models, 'gone/v9').disabled).toBe(false)
    expect(optionOf(models, 'gone/v9').textContent).toBe('gone/v9' + t('form.modelUnlisted'))
    expect(levels.value).toBe('ultra')
    expect(optionOf(levels, 'ultra').disabled).toBe(false)
    expect(optionOf(levels, 'ultra').textContent).toBe('ultra' + t('form.effortUnlisted'))
  })

  it('operator finds no free-text field left for either pinned field', async () => {
    // Given the add-member form, When it renders, Then the only text boxes left are the name and the preset, and both pinned fields are native selects.
    const transport = fakeTransport({ state: async () => catalogState([teamOf({ members: [] })]) })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    openSquad(view.container)
    click(buttonByText(view.container, t('detail.addMember')))
    const form = must(view.container, '[data-dsh-part="member-form"]')
    expect([...form.querySelectorAll('input')].map(input => input.getAttribute('placeholder')))
      .toEqual([t('form.namePlaceholder'), t('form.presetPlaceholder')])
    expect(form.querySelectorAll('select')).toHaveLength(3)
    expect((must(form, '[name="model"]') as HTMLElement).tagName).toBe('SELECT')
    expect((must(form, '[name="reasoningEffort"]') as HTMLElement).tagName).toBe('SELECT')
    expect(form.querySelector('input[name="model"]')).toBeNull()
    expect(form.querySelector('input[name="reasoningEffort"]')).toBeNull()
  })

  it('operator is told the chosen model declares no level instead of being offered invented ones', async () => {
    // Given a model whose catalog entry declares no level, When it is picked, Then the level select keeps only the inherit row and states why.
    const transport = fakeTransport({
      state: async () => catalogState([teamOf({ members: [] })], [{ provider: 'deepseek', model: 'quiet', efforts: [] }], ['low']),
    })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    openSquad(view.container)
    click(buttonByText(view.container, t('detail.addMember')))
    const form = must(view.container, '[data-dsh-part="member-form"]')
    selectOption(must(form, 'select[name="model"]') as HTMLSelectElement, 'deepseek/quiet')
    const levels = must(form, 'select[name="reasoningEffort"]') as HTMLSelectElement
    expect(optionsOf(levels)).toEqual([{ value: '', label: t('form.effortInherit') }])
    expect(form.textContent).toContain(t('form.effortNoLevels'))
  })

  it('operator gets no picker when this Host publishes no catalog, and the stored pin survives the save', async () => {
    // Given a Host that publishes no catalog, When the member is edited, Then neither picker renders and the pin it already had is saved untouched.
    const saved: MemberDraft[] = []
    const transport = fakeTransport({
      state: async () => stateOf([teamOf({ members: [memberOf()] })]),
      saveMember: async (_teamId: string, draft: MemberDraft) => {
        saved.push(draft)
        return teamOf({ members: [memberOf({ name: draft.name })] })
      },
    })
    const view = mount(<AgentsPage transport={transport} />)
    await flush()
    openSquad(view.container)
    click(buttonByText(view.container, t('member.edit')))
    const form = must(view.container, '[data-dsh-part="member-form"]')
    expect(form.querySelector('[name="model"]')).toBeNull()
    expect(form.querySelector('[name="reasoningEffort"]')).toBeNull()
    expect(form.querySelectorAll('select')).toHaveLength(1)
    typeInto(must(form, 'input') as HTMLInputElement, 'Renamed')
    click(buttonByText(view.container, t('form.save')))
    await flush()
    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('Renamed')
    expect(saved[0].model).toBe('deepseek/deepseek-v4')
  })
})
