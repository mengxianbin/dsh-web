/**
 * Owns the Host's model-catalog read: the routes the state view publishes, the
 * levels each route declares, and the difference between "the catalog says this
 * model has no reasoning level" and "the catalog never described this model".
 */
import { describe, expect, it, vi } from 'vitest'
import { listOfferedModelCatalog, readModelCatalog } from '../src/host/model-catalog.ts'
import type { MemberRunGateway } from '../src/host/run-gateway.ts'

/** A reply shaped exactly like the `session/modelCatalog` this Host serves. */
const REPLY = {
  groups: [
    {
      id: 'deepseek',
      models: [
        { id: 'deepseek-v4', name: 'DeepSeek V4', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } },
        { id: 'deepseek-quiet', reasoning: { efforts: [] } },
        { id: 'deepseek-plain' },
      ],
    },
    { id: 'anthropic', models: [{ id: 'sonnet', reasoning: { efforts: [{ id: 'high' }, { id: 'max' }] } }] },
  ],
}

describe('reading the host model catalog', () => {
  it('user sees one row per route, its published label, and the levels it declares', () => {
    // Given the catalog reply, When the Host normalizes it, Then every route carries its provider, its label and its levels.
    const catalog = readModelCatalog(REPLY)
    expect(catalog?.models).toEqual([
      { provider: 'deepseek', model: 'deepseek-v4', label: 'DeepSeek V4', efforts: ['low', 'high'] },
      { provider: 'deepseek', model: 'deepseek-quiet', efforts: [] },
      { provider: 'deepseek', model: 'deepseek-plain' },
      { provider: 'anthropic', model: 'sonnet', efforts: ['high', 'max'] },
    ])
  })

  it('operator reads the deployment list as every declared level, once each, in catalog order', () => {
    // Given two providers declaring an overlapping level, When the Host normalizes, Then the list carries it once.
    expect(readModelCatalog(REPLY)?.efforts).toEqual(['low', 'high', 'max'])
  })

  it('operator tells a model that declares no level apart from one the catalog never described', () => {
    // Given one model with an empty reasoning block and one with none at all, When they are normalized, Then only the first carries an empty list.
    const models = readModelCatalog(REPLY)?.models ?? []
    const quiet = models.find(model => model.model === 'deepseek-quiet')
    const undescribed = models.find(model => model.model === 'deepseek-plain')
    expect(quiet?.efforts).toEqual([])
    expect(undescribed === undefined ? 'no row' : 'efforts' in undescribed).toBe(false)
  })

  it('operator sees one row per route even when the reply lists it twice', () => {
    // Given the same route under two groups, When the Host normalizes, Then the picker has one row for it.
    const catalog = readModelCatalog({ groups: [{ id: 'deepseek', models: [{ id: 'v4' }] }, { id: 'deepseek', models: [{ id: 'v4' }, { id: 'v5' }] }] })
    expect(catalog?.models.map(row => row.provider + '/' + row.model)).toEqual(['deepseek/v4', 'deepseek/v5'])
  })

  it('operator gets no catalog at all from a reply with no usable route', () => {
    // Given an unreadable or empty reply, When the Host normalizes it, Then it answers "no catalog" rather than an empty one.
    for (const reply of [undefined, null, 'modelCatalog', {}, { groups: [] }, { groups: [{ id: '' , models: [{ id: 'v4' }] }] }, { groups: [{ id: 'deepseek', models: [{ name: 'no id' }] }] }]) {
      expect(readModelCatalog(reply)).toBeUndefined()
    }
  })

  it('operator gets no catalog when this deployment serves no catalog face', async () => {
    // Given a gateway with no catalog face, When the state view asks for one, Then it answers "none" instead of failing.
    const gateway: Pick<MemberRunGateway, 'modelCatalog'> = {}
    expect(await listOfferedModelCatalog(gateway)).toBeUndefined()
  })

  it('operator gets no catalog when the catalog read throws, and the panel still answers', async () => {
    // Given a catalog face that throws, When the state view asks for one, Then the read is swallowed as "none".
    const gateway: Pick<MemberRunGateway, 'modelCatalog'> = { modelCatalog: vi.fn(async () => { throw new Error('no session namespace here') }) }
    expect(await listOfferedModelCatalog(gateway)).toBeUndefined()
  })

  it('user reads the catalog through the one gateway face the run path uses', async () => {
    // Given a readable catalog face, When the state view asks for one, Then it receives that reply, normalized.
    const modelCatalog = vi.fn(async () => REPLY)
    const catalog = await listOfferedModelCatalog({ modelCatalog })
    expect(modelCatalog).toHaveBeenCalledTimes(1)
    expect(catalog?.models).toHaveLength(4)
  })
})
