/**
 * Owns the member-brief injection decision: which assemble identity maps to
 * which definition, what every other session gets (nothing), and the section
 * registration seam (docs/member-prompt.md carries the host evidence).
 */
import { describe, expect, it, vi } from 'vitest'
import { MEMBER_PROMPT_SECTION_NAME, assembleIdentity, memberBriefFor, registerMemberPromptSeam, type MemberPromptRegistry, type MemberPromptView } from '../src/host/member-prompt.ts'
import type { MemberDefinition, RunRecord, TeamDefinition } from '../src/protocol.ts'

const NOW = 1_700_000_000_000

function member(id: string, brief?: string): MemberDefinition {
  return { id, teamId: 'team-a', name: id, ...(brief === undefined ? {} : { brief }), createdAt: NOW, updatedAt: NOW }
}

function team(members: MemberDefinition[]): TeamDefinition {
  return { id: 'team-a', name: 'Squad', createdAt: NOW, updatedAt: NOW, members }
}

function run(id: string, sessionId: string, createdAt: number, memberId = 'member-a'): RunRecord {
  return { id, teamId: 'team-a', memberId, sessionId, createdAt, status: 'running' }
}

describe('assemble identity', () => {
  it('operator reads the session id the host passes on the assembled agent', () => {
    // Given an assembly for a live agent, When its identity is read, Then the agent id is the session id.
    expect(assembleIdentity({ agent: { id: 'session-1' } })).toEqual({ sessionId: 'session-1' })
  })

  it('operator reads the alternate field name so a cohort rename does not stop injection', () => {
    // Given an agent that names the session on its second field spelling, When identity is read, Then the same id is found.
    expect(assembleIdentity({ agent: { sessionId: 'session-2' } })).toEqual({ sessionId: 'session-2' })
  })

  it('operator never guesses an identity from anything but the assembled agent', () => {
    // Given no agent, an empty agent or a non-text id, When identity is read, Then it stays empty.
    expect(assembleIdentity(undefined)).toEqual({})
    expect(assembleIdentity(null)).toEqual({})
    expect(assembleIdentity({})).toEqual({})
    expect(assembleIdentity({ agent: {} })).toEqual({})
    expect(assembleIdentity({ agent: { id: '' } })).toEqual({})
    expect(assembleIdentity({ agent: { id: 42 } })).toEqual({})
    expect(assembleIdentity({ scope: { id: 'session-3' } })).toEqual({})
  })
})

describe('brief lookup', () => {
  const view = (): MemberPromptView => ({
    teams: [team([member('member-a', '  你是寻冬。  '), member('member-b')])],
    runs: [run('run-1', 'session-1', NOW), run('run-2', 'session-2', NOW + 10, 'member-b')],
  })

  it('user gets the brief of the member whose session this assembly is', () => {
    // Given a member run session, When its assembly is looked up, Then the trimmed brief comes back.
    expect(memberBriefFor({ agent: { id: 'session-1' } }, view())).toBe('你是寻冬。')
  })

  it('user gets nothing for a member that carries no brief', () => {
    // Given a member with no brief, When its assembly is looked up, Then the contribution is empty.
    expect(memberBriefFor({ agent: { id: 'session-2' } }, view())).toBe('')
  })

  it('user gets nothing for an ordinary session that was never a member run', () => {
    // Given a session outside the run history, When its assembly is looked up, Then nothing is injected.
    expect(memberBriefFor({ agent: { id: 'user-session' } }, view())).toBe('')
    expect(memberBriefFor({}, view())).toBe('')
  })

  it('operator stops injecting once the definition behind the session is gone', () => {
    // Given a deleted team or member, When that session assembles again, Then the lookup answers empty instead of a stale brief.
    const deletedTeam: MemberPromptView = { ...view(), teams: [] }
    expect(memberBriefFor({ agent: { id: 'session-1' } }, deletedTeam)).toBe('')
    const deletedMember: MemberPromptView = { teams: [team([])], runs: view().runs }
    expect(memberBriefFor({ agent: { id: 'session-1' } }, deletedMember)).toBe('')
  })

  it('operator takes the newest run when one session carries several', () => {
    // Given two runs of one session, When the brief is resolved, Then the most recent run names the member.
    const rerun: MemberPromptView = {
      teams: [team([member('member-a', 'first'), member('member-b', 'second')])],
      runs: [run('run-old', 'session-1', NOW, 'member-a'), run('run-new', 'session-1', NOW + 50, 'member-b')],
    }
    expect(memberBriefFor({ agent: { id: 'session-1' } }, rerun)).toBe('second')
  })
})

describe('section seam', () => {
  it('operator registers one global section right after the deployment persona', () => {
    // Given a host registry publishing the persona order, When the seam registers, Then one named section sits one place after it.
    const sections: Array<{ name: string; order: number; text: (context: never) => string }> = []
    const registry: MemberPromptRegistry = {
      section: (section) => {
        sections.push(section)
        return vi.fn()
      },
      getSectionOrder: () => 0,
    }
    registerMemberPromptSeam(registry, () => ({ teams: [], runs: [] }))
    expect(sections.map(section => section.name)).toEqual([MEMBER_PROMPT_SECTION_NAME])
    expect(sections[0].order).toBe(1)
  })

  it('operator reads the ledger at assemble time, so an edited brief is what the next turn sees', () => {
    // Given a registry, When two assemblies run with an edit between them, Then each answers from the ledger as it stood at that moment.
    const sections: Array<{ text: (context: never) => string }> = []
    const registry: MemberPromptRegistry = {
      section: (section) => {
        sections.push(section)
        return vi.fn()
      },
      getSectionOrder: () => 0,
    }
    let current: MemberPromptView = { teams: [team([member('member-a', 'before')])], runs: [run('run-1', 'session-1', NOW)] }
    const readView = vi.fn(() => current)
    registerMemberPromptSeam(registry, readView)
    expect(sections[0].text({ agent: { id: 'session-1' } } as never)).toBe('before')
    current = { teams: [team([member('member-a', 'after')])], runs: [run('run-1', 'session-1', NOW)] }
    expect(sections[0].text({ agent: { id: 'session-1' } } as never)).toBe('after')
    expect(readView).toHaveBeenCalledTimes(2)
  })

  it('operator falls back to a fixed order when the host publishes none', () => {
    // Given a registry with no placement source, When the seam registers, Then the section still lands at the persona-adjacent order.
    const captured: Array<{ order: number }> = []
    registerMemberPromptSeam({ section: (section) => { captured.push(section); return vi.fn() } }, () => ({ teams: [], runs: [] }))
    expect(captured.map(section => section.order)).toEqual([1])
  })
})
