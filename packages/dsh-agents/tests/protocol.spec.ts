/**
 * Owns the wire-contract gate: what the Host accepts from a browser body and
 * what it must refuse, plus the frozen route list.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENTS_PERMISSIONS,
  BRIEF_MAX_LENGTH,
  DSH_AGENTS_API_PREFIX,
  DSH_AGENTS_ROUTE_PATHS,
  FIRST_MESSAGE_MAX_LENGTH,
  DESCRIBE_INTENT_MAX_LENGTH,
  NAME_MAX_LENGTH,
  isAgentsPermission,
  parseDescribeRequestBody,
  parseMemberDeleteRequestBody,
  parseMemberDraft,
  parseMemberRequestBody,
  parseRunRequestBody,
  parseTeamDeleteRequestBody,
  parseTeamDraft,
  parseTeamRequestBody,
} from '../src/protocol.ts'

describe('frozen route contract', () => {
  it('operator serves exactly the eight contract paths under the root-absolute prefix', () => {
    // Given the frozen contract (M1's six paths, M2's whole-squad run and this build's description draft), When the route list is read, Then it is exactly those API paths.
    expect(DSH_AGENTS_API_PREFIX).toBe('/dsh-agents/api')
    expect([...DSH_AGENTS_ROUTE_PATHS]).toEqual([
      '/dsh-agents/api/state',
      '/dsh-agents/api/team',
      '/dsh-agents/api/team/delete',
      '/dsh-agents/api/member',
      '/dsh-agents/api/member/delete',
      '/dsh-agents/api/run',
      '/dsh-agents/api/squad/run',
      '/dsh-agents/api/describe',
    ])
  })

  it('operator accepts the three DSH sandbox modes as member permissions and nothing else', () => {
    // Given the DSH permission presets, When a member permission is gated, Then only the three sandbox modes pass.
    expect([...AGENTS_PERMISSIONS]).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect(isAgentsPermission('read-only')).toBe(true)
    expect(isAgentsPermission('auto')).toBe(false)
    expect(isAgentsPermission(undefined)).toBe(false)
  })
})

describe('team draft gate', () => {
  it('user writes a team draft that arrives trimmed and carrying only what was set', () => {
    // Given a minimal draft, When it is gated, Then the name is trimmed and no optional field is invented.
    expect(parseTeamDraft({ name: '  研究小队  ' })).toEqual({ name: '研究小队' })
    // Given every optional field, When it is gated, Then all of them survive, and blank text collapses to absent.
    expect(parseTeamDraft({ name: 'A', description: 'why', workspaceId: 'ws-1', order: 3 }))
      .toEqual({ name: 'A', description: 'why', workspaceId: 'ws-1', order: 3 })
    expect(parseTeamDraft({ name: 'A', description: '   ' })).toEqual({ name: 'A' })
  })

  it('operator refuses a team draft that carries a field the Host mints itself', () => {
    // Given a draft carrying a timestamp or a member list, When it is gated, Then the whole request is refused.
    expect(parseTeamDraft({ name: 'A', createdAt: 1 })).toBeUndefined()
    expect(parseTeamDraft({ name: 'A', members: [] })).toBeUndefined()
  })

  it('operator refuses an empty name, an over-long name, and a non-integer order', () => {
    // Given unusable definition fields, When the draft is gated, Then nothing reaches the ledger.
    expect(parseTeamDraft({ name: '   ' })).toBeUndefined()
    expect(parseTeamDraft({ name: 'x'.repeat(NAME_MAX_LENGTH + 1) })).toBeUndefined()
    expect(parseTeamDraft({ name: 'A', order: 1.5 })).toBeUndefined()
    expect(parseTeamDraft({ name: 'A', order: '1' })).toBeUndefined()
    expect(parseTeamDraft(null)).toBeUndefined()
    expect(parseTeamDraft([])).toBeUndefined()
  })

  it('operator reads the team body by its one key and keeps the addressing id', () => {
    // Given a team body, When it is gated, Then only the exact one-key shape passes and the id rides along.
    expect(parseTeamRequestBody({ team: { name: 'A' } })).toEqual({ team: { name: 'A' } })
    expect(parseTeamRequestBody({ team: { name: 'A' }, extra: true })).toBeUndefined()
    expect(parseTeamRequestBody({ team: { name: 'A', id: 'team-1' } })).toEqual({ team: { name: 'A', id: 'team-1' } })
    expect(parseTeamRequestBody({})).toBeUndefined()
  })
})

describe('member draft gate', () => {
  it('user writes a member draft with its preset, permission, model pin, effort and brief', () => {
    // Given a full member draft, When it is gated, Then every field reaches the ledger unchanged.
    const draft = {
      name: '寻冬',
      preset: 'xundong',
      permission: 'workspace-write' as const,
      model: 'deepseek/deepseek-chat',
      reasoningEffort: 'high',
      brief: '你是寻冬。',
    }
    expect(parseMemberDraft(draft)).toEqual(draft)
  })

  it('operator refuses a permission outside the three sandbox modes', () => {
    // Given a session-scoped permission such as auto, When a member pins it, Then the draft is refused.
    expect(parseMemberDraft({ name: 'A', permission: 'auto' })).toBeUndefined()
  })

  it('operator refuses an over-long brief or pin, which would bloat the system prompt', () => {
    // Given text past its cap, When the draft is gated, Then it is refused rather than truncated.
    expect(parseMemberDraft({ name: 'A', brief: 'x'.repeat(BRIEF_MAX_LENGTH + 1) })).toBeUndefined()
    expect(parseMemberDraft({ name: 'A', model: 'x'.repeat(201) })).toBeUndefined()
  })

  it('operator keeps a well-formed member id and refuses a blank or non-text one', () => {
    // Given a draft addressing an existing member, When it is gated, Then the id survives or the draft is refused.
    expect(parseMemberDraft({ name: 'A', id: 'member-1' })).toEqual({ name: 'A', id: 'member-1' })
    expect(parseMemberDraft({ name: 'A', id: '   ' })).toBeUndefined()
    expect(parseMemberDraft({ name: 'A', id: 7 })).toBeUndefined()
  })

  it('operator reads the member body, which always names the team it belongs to', () => {
    // Given a member body, When it is gated, Then a missing team id or member fails the whole request.
    expect(parseMemberRequestBody({ teamId: 'team-1', member: { name: 'A' } })).toEqual({ teamId: 'team-1', member: { name: 'A' } })
    expect(parseMemberRequestBody({ member: { name: 'A' } })).toBeUndefined()
    expect(parseMemberRequestBody({ teamId: 'team-1' })).toBeUndefined()
  })
})

describe('delete and run bodies', () => {
  it('operator reads one team id from a delete body and refuses extra fields', () => {
    // Given a delete body, When it is gated, Then only a non-empty single team id passes.
    expect(parseTeamDeleteRequestBody({ teamId: 'team-1' })).toEqual({ teamId: 'team-1' })
    expect(parseTeamDeleteRequestBody({ teamId: '' })).toBeUndefined()
    expect(parseTeamDeleteRequestBody({ teamId: 'team-1', memberId: 'm' })).toBeUndefined()
  })

  it('operator reads one member of one team from a member delete body', () => {
    // Given a member delete body, When it is gated, Then both ids are required.
    expect(parseMemberDeleteRequestBody({ teamId: 't', memberId: 'm' })).toEqual({ teamId: 't', memberId: 'm' })
    expect(parseMemberDeleteRequestBody({ teamId: 't' })).toBeUndefined()
  })

  it('user sends an optional first message that stays bounded and never blank', () => {
    // Given a run body, When it is gated, Then a blank message is dropped and an over-long one is refused.
    expect(parseRunRequestBody({ teamId: 't', memberId: 'm' })).toEqual({ teamId: 't', memberId: 'm' })
    expect(parseRunRequestBody({ teamId: 't', memberId: 'm', firstMessage: 'go' })).toEqual({ teamId: 't', memberId: 'm', firstMessage: 'go' })
    expect(parseRunRequestBody({ teamId: 't', memberId: 'm', firstMessage: '   ' })).toEqual({ teamId: 't', memberId: 'm' })
    expect(parseRunRequestBody({ teamId: 't', memberId: 'm', firstMessage: 'x'.repeat(FIRST_MESSAGE_MAX_LENGTH + 1) })).toBeUndefined()
    expect(parseRunRequestBody({ teamId: 't' })).toBeUndefined()
  })
})

describe('description draft gate', () => {
  it('user asks for a description from a name, optionally with a rough intent', () => {
    // Given a describe body, When it is gated, Then the name is required and the intent is trimmed, blank-dropped and bounded.
    expect(parseDescribeRequestBody({ name: 'Squad one' })).toEqual({ name: 'Squad one' })
    expect(parseDescribeRequestBody({ name: '  Squad one  ', intent: '  architecture review ' })).toEqual({ name: 'Squad one', intent: 'architecture review' })
    expect(parseDescribeRequestBody({ name: 'Squad one', intent: '   ' })).toEqual({ name: 'Squad one' })
    expect(parseDescribeRequestBody({ name: 'Squad one', intent: 'x'.repeat(DESCRIBE_INTENT_MAX_LENGTH + 1) })).toBeUndefined()
    expect(parseDescribeRequestBody({ intent: 'architecture review' })).toBeUndefined()
    expect(parseDescribeRequestBody({ name: '   ' })).toBeUndefined()
  })

  it('operator refuses a describe body that smuggles a field this build does not read', () => {
    // Given a body naming a model route or an extra key, When it is gated, Then the request is refused rather than silently narrowed.
    expect(parseDescribeRequestBody({ name: 'Squad one', model: 'deepseek/chat' })).toBeUndefined()
    expect(parseDescribeRequestBody({ name: 'Squad one', intent: 'review', teamId: 'team-1' })).toBeUndefined()
  })
})
