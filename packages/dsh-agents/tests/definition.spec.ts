/**
 * Owns the pure definition rules: id stability, the full-draft replacement, and
 * the served ordering.
 */
import { describe, expect, it } from 'vitest'
import { applyMemberDraft, applyTeamDraft, createMember, createTeam, findMember, findTeam, sortTeams, touchTeam } from '../src/core/definition.ts'
import type { TeamDefinition } from '../src/protocol.ts'

const NOW = 1_700_000_000_000

describe('team rows', () => {
  it('operator mints a team row from the draft, keeping the id and clock it is given', () => {
    // Given a validated draft, When the row is minted, Then it carries the caller's id and stamp and no members.
    const team = createTeam({ name: 'Squad', description: 'd', workspaceId: 'ws-1', order: 2 }, NOW, 'team-a')
    expect(team).toEqual({
      id: 'team-a', name: 'Squad', description: 'd', workspaceId: 'ws-1', order: 2,
      createdAt: NOW, updatedAt: NOW, members: [],
    })
  })

  it('user replaces a team with a full draft, and the member list survives the edit', () => {
    // Given an existing team, When a draft without its optional fields replaces it, Then those fields are cleared and identity is kept.
    const team: TeamDefinition = {
      ...createTeam({ name: 'Old', description: 'gone', order: 1 }, NOW, 'team-a'),
      members: [createMember({ name: 'M' }, 'team-a', NOW, 'member-a')],
    }
    const next = applyTeamDraft(team, { name: 'New' }, NOW + 5)
    expect(next.id).toBe('team-a')
    expect(next.createdAt).toBe(NOW)
    expect(next.updatedAt).toBe(NOW + 5)
    expect(next.name).toBe('New')
    expect(next.description).toBeUndefined()
    expect(next.order).toBeUndefined()
    expect(next.members).toHaveLength(1)
  })

  it('operator touches a team stamp without changing the fields the user edits', () => {
    // Given a team, When its member list changes, Then only updatedAt moves.
    const team = createTeam({ name: 'Squad' }, NOW, 'team-a')
    const touched = touchTeam(team, NOW + 9)
    expect(touched).toEqual({ ...team, updatedAt: NOW + 9 })
  })
})

describe('member rows', () => {
  it('operator mints a member row with the team id the request named', () => {
    // Given a validated draft, When the row is minted, Then teamId comes from the request, not from the draft.
    const member = createMember({ name: 'M', permission: 'read-only' }, 'team-a', NOW, 'member-a')
    expect(member).toEqual({ id: 'member-a', teamId: 'team-a', name: 'M', permission: 'read-only', createdAt: NOW, updatedAt: NOW })
  })

  it('user edits a member without moving it, and identity stays stable', () => {
    // Given a member of one team, When it is edited, Then id, teamId and createdAt survive and omitted pins are cleared.
    const member = createMember({ name: 'Old', preset: 'x' }, 'team-a', NOW, 'member-a')
    const next = applyMemberDraft(member, { name: 'New', brief: 'b' }, NOW + 3)
    expect(next.id).toBe('member-a')
    expect(next.teamId).toBe('team-a')
    expect(next.createdAt).toBe(NOW)
    expect(next.updatedAt).toBe(NOW + 3)
    expect(next.preset).toBeUndefined()
    expect(next.brief).toBe('b')
  })

  it('operator finds a member only inside its own team', () => {
    // Given one team holding one member, When lookups run, Then a member is found only under its own team id.
    const team = createTeam({ name: 'Squad' }, NOW, 'team-a')
    const member = createMember({ name: 'M' }, 'team-a', NOW, 'member-a')
    const withMember = { ...team, members: [member] }
    expect(findMember(withMember, 'member-a')).toEqual(member)
    expect(findMember(withMember, 'member-b')).toBeUndefined()
    expect(findTeam([withMember], 'team-a')).toEqual(withMember)
    expect(findTeam([withMember], 'team-b')).toBeUndefined()
  })
})

describe('served ordering', () => {
  const team = (id: string, createdAt: number, order?: number): TeamDefinition =>
    ({ ...createTeam({ name: id, ...(order === undefined ? {} : { order }) }, createdAt, id) })

  it('user sees teams ordered by explicit order, unordered last, then by creation time', () => {
    // Given teams with and without an order, When the panel orders them, Then unordered teams come last and ties fall back to creation time.
    const sorted = sortTeams([team('b', 3, 5), team('a', 2), team('c', 3), team('d', 1, 5)])
    expect(sorted.map(entry => entry.id)).toEqual(['d', 'b', 'a', 'c'])
  })

  it('operator sorts a copy, so the ledger order is untouched', () => {
    // Given the stored array, When the served order is computed, Then the input array is unchanged.
    const input = [team('b', 2), team('a', 1)]
    sortTeams(input)
    expect(input.map(entry => entry.id)).toEqual(['b', 'a'])
  })
})
