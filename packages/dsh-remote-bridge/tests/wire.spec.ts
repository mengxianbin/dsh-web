import { describe, expect, it } from 'vitest'
import { WIRE_TABLE, wireArgs, wireRowFor } from '../src/core/wire.ts'

describe('DSH Remote wire argument layout', () => {
  it('user lists sessions and the request rides the underscored parameter name', () => {
    // Given the session roster endpoint, whose parameter is named _request
    // When the bridge builds its named arguments
    const args = wireArgs('session', 'list', { cursor: 'page-2' })
    // Then the underscore is preserved exactly, because one wrong byte is an arguments-invalid failure
    expect(args).toEqual({ _request: { cursor: 'page-2' } })
  })

  it('user prompts and the request rides the plain request parameter name', () => {
    // Given the prompt endpoint, whose parameter is named request
    // When the bridge builds its named arguments
    const args = wireArgs('session', 'prompt', { sessionId: 's-1' })
    // Then the single declared key carries the payload
    expect(args).toEqual({ request: { sessionId: 's-1' } })
  })

  it('user asks for the model catalog and the call carries no arguments at all', () => {
    // Given the model catalog endpoint, which declares zero parameters
    // When the bridge builds its named arguments
    const args = wireArgs('session', 'modelCatalog')
    // Then the object is empty rather than carrying an empty request
    expect(args).toEqual({})
  })

  it('user opens, cancels or re-targets a session and every request rides the plain parameter name', () => {
    // Given the four other request-shaped session endpoints
    const endpoints = [['page'], ['follow'], ['cancel'], ['selectModel']] as const
    // When the bridge builds their named arguments
    const built = endpoints.map(([method]) => wireArgs('session', method, { address: 'a' }))
    // Then each is the single request key the descriptors declare
    expect(built).toEqual([
      { request: { address: 'a' } },
      { request: { address: 'a' } },
      { request: { address: 'a' } },
      { request: { address: 'a' } },
    ])
  })

  it('operator reads the table and finds every zero-argument endpoint declared as such', () => {
    // Given the tabulated endpoints of this package's mapping
    const zeroArgument = WIRE_TABLE.filter(row => row.wire === 'none').map(row => `${row.namespace}/${row.method}`)
    // When the zero-argument rows are collected
    const inventory = WIRE_TABLE.filter(row => row.wire === 'none').length
    // Then exactly the four zero-parameter endpoints are marked, and the rest carry named arguments
    expect(zeroArgument).toEqual(['session/modelCatalog', 'agentPresets/list', 'pluginInventory/list', 'pluginManager/listPlugins'])
    expect(WIRE_TABLE.length - inventory).toBe(20)
  })

  it('user answers a continued question and every declared parameter travels as its own key', () => {
    // Given the user-questions answer endpoint, whose descriptor declares agentId, callId and answer
    // When the bridge builds its named arguments
    const args = wireArgs('userQuestions', 'answer', { agentId: 's-1', callId: 'c-1', answer: { answers: [] } })
    // Then each wire name is one key of its own, not one request object
    expect(args).toEqual({ agentId: 's-1', callId: 'c-1', answer: { answers: [] } })
    expect(wireRowFor('userQuestions', 'answer')?.wire).toEqual({ names: ['agentId', 'callId', 'answer'] })
  })

  it('operator adds an endpoint the table does not know and it defaults to the majority layout', () => {
    // Given an endpoint outside the tabulated set
    // When the bridge builds its named arguments and asks for its row
    const args = wireArgs('workspace', 'create', { path: '/Users/zcl/code/x' })
    const row = wireRowFor('workspace', 'create')
    // Then the fallback is the plain request key, and the table reports no row rather than a wrong one
    expect(args).toEqual({ request: { path: '/Users/zcl/code/x' } })
    expect(row).toBeUndefined()
  })
})
