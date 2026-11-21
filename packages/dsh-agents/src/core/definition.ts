/**
 * Pure definition rules for agent squads: turning a validated draft into a
 * ledger row, applying a full-draft replacement, and the deterministic team
 * order the browser renders.
 *
 * No filesystem, no clock, no randomness: every function takes the timestamp
 * and the minted id it must use, so the ledger owns when and what, and this
 * module stays testable without either.
 *
 * @module @linxin666/dsh-agents/core/definition
 */
import type { MemberDefinition, MemberDraft, TeamDefinition, TeamDraft } from '../protocol.ts'

/**
 * Mint a team row from a validated draft.
 *
 * The draft addresses an existing team when it carries an `id`; a create must
 * not arrive with one, so the id is always the caller's freshly minted value.
 * @param draft - the validated draft.
 * @param now - timestamp to stamp on the row.
 * @param id - the freshly minted team id.
 * @returns a team with no members.
 */
export function createTeam(draft: TeamDraft, now: number, id: string): TeamDefinition {
  return {
    id,
    name: draft.name,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    ...(draft.workspaceId === undefined ? {} : { workspaceId: draft.workspaceId }),
    ...(draft.leadPreset === undefined ? {} : { leadPreset: draft.leadPreset }),
    ...(draft.order === undefined ? {} : { order: draft.order }),
    createdAt: now,
    updatedAt: now,
    members: [],
  }
}

/**
 * Apply a full-draft replacement to an existing team.
 *
 * The draft is the new state of the editable fields, not a patch: a field the
 * caller omitted is cleared. `id`, `createdAt` and the member list are the
 * ledger's, never the wire's.
 * @param team - the current row.
 * @param draft - the validated replacement.
 * @param now - timestamp to stamp as `updatedAt`.
 * @returns the replaced row.
 */
export function applyTeamDraft(team: TeamDefinition, draft: TeamDraft, now: number): TeamDefinition {
  return {
    id: team.id,
    name: draft.name,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    ...(draft.workspaceId === undefined ? {} : { workspaceId: draft.workspaceId }),
    ...(draft.leadPreset === undefined ? {} : { leadPreset: draft.leadPreset }),
    ...(draft.order === undefined ? {} : { order: draft.order }),
    createdAt: team.createdAt,
    updatedAt: now,
    members: team.members,
  }
}

/**
 * Mint a member row from a validated draft.
 * @param draft - the validated draft.
 * @param teamId - the team the member belongs to (the request's teamId wins).
 * @param now - timestamp to stamp on the row.
 * @param id - the freshly minted member id.
 * @returns the member row.
 */
export function createMember(draft: MemberDraft, teamId: string, now: number, id: string): MemberDefinition {
  return {
    id,
    teamId,
    name: draft.name,
    ...(draft.preset === undefined ? {} : { preset: draft.preset }),
    ...(draft.permission === undefined ? {} : { permission: draft.permission }),
    ...(draft.model === undefined ? {} : { model: draft.model }),
    ...(draft.reasoningEffort === undefined ? {} : { reasoningEffort: draft.reasoningEffort }),
    ...(draft.brief === undefined ? {} : { brief: draft.brief }),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Apply a full-draft replacement to an existing member. `id`, `teamId` and
 * `createdAt` stay the ledger's; the member cannot be moved between teams by
 * an edit.
 * @param member - the current row.
 * @param draft - the validated replacement.
 * @param now - timestamp to stamp as `updatedAt`.
 * @returns the replaced row.
 */
export function applyMemberDraft(member: MemberDefinition, draft: MemberDraft, now: number): MemberDefinition {
  return {
    ...createMember(draft, member.teamId, member.createdAt, member.id),
    createdAt: member.createdAt,
    updatedAt: now,
  }
}

/**
 * Stamp a team row as touched without changing its editable fields, so an edit
 * confined to its member list still shows up in the browser's ordering.
 * @param team - the current row.
 * @param now - timestamp to stamp as `updatedAt`.
 * @returns the touched row.
 */
export function touchTeam(team: TeamDefinition, now: number): TeamDefinition {
  return { ...team, updatedAt: now }
}

/**
 * The order the browser renders teams in: explicit `order` ascending with
 * unordered teams last, then creation time ascending, then id. The comparator
 * is total, so the same ledger always renders identically.
 * @param teams - the teams to sort.
 * @returns a sorted copy.
 */
export function sortTeams(teams: readonly TeamDefinition[]): TeamDefinition[] {
  return [...teams].sort((left, right) => {
    const leftOrder = left.order ?? Number.POSITIVE_INFINITY
    const rightOrder = right.order ?? Number.POSITIVE_INFINITY
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/** Find one team by id. */
export function findTeam(teams: readonly TeamDefinition[], teamId: string): TeamDefinition | undefined {
  return teams.find(team => team.id === teamId)
}

/** Find one member inside a team. */
export function findMember(team: TeamDefinition, memberId: string): MemberDefinition | undefined {
  return team.members.find(member => member.id === memberId)
}
