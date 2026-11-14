/**
 * Model-facing tools for the squad definitions: the DSH-native counterpart of
 * the squad panel.
 *
 * Every tool drives the same `AgentsHostService` the browser drives, so a squad
 * defined in the GUI is immediately operable from any session and vice versa.
 * Nothing here restates a business rule: each call builds the wire body its
 * route serves, gates it through the frozen parsers in protocol.ts, and lets the
 * service decide. A refusal therefore arrives as an `ok:false` value the model
 * can correct, never as a stack trace, and only a genuine fault (something this
 * plugin did not decide) leaves as an exception.
 *
 * Two parameter choices follow from that. An argument that only names a target
 * (`squadId`, `memberId`) stays schema-optional, so omitting one answers
 * `invalid-request` as a value instead of failing the tool protocol before the
 * body runs; the parser is the gate either way. A partial update carries the
 * values the definition already has, because the ledger applies a full-draft
 * replacement. A destructive call must be confirmed explicitly, and the
 * confirmation is checked before the ledger is read or written.
 *
 * @module @linxin666/dsh-agents/host/agent-tools
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { isAgentsError } from '../core/errors.ts'
import {
  ID_MAX_LENGTH,
  parseMemberDeleteRequestBody,
  parseMemberDraft,
  parseMemberRequestBody,
  parseRunRequestBody,
  parseSquadRunRequestBody,
  parseTeamDeleteRequestBody,
  parseTeamRequestBody,
  type AgentsErrorCode,
  type AgentsStateView,
  type MemberDefinition,
  type MemberDraft,
  type RunRecord,
  type RunRequestBody,
  type SquadRunRequestBody,
  type TeamDefinition,
  type TeamDraft,
} from '../protocol.ts'

/** Registered tool names, in registration order. */
export const AGENTS_TOOL_NAMES = [
  'squads_list',
  'squads_read',
  'squads_create',
  'squads_update',
  'squads_delete',
  'squad_member_add',
  'squad_member_update',
  'squad_member_remove',
  'squads_run_member',
  'squads_run_squad',
] as const

/** Model-facing announcement: what the surface does, what it costs, what it refuses. */
export const AGENTS_TOOL_GUIDANCE = 'dsh-agents owns this Host\'s agent-squad definitions, and the Web GUI squad panel edits the same ledger. squads_list and squads_read inspect definitions; squads_create, squads_update, squads_delete, squad_member_add, squad_member_update and squad_member_remove edit them; squads_run_member and squads_run_squad launch sessions. A squad is a named set of member definitions sharing one workspace; a member may pin an agent preset, a permission preset, a model route with a reasoning effort, and a brief that becomes that member session system prompt. An update is a partial merge: an omitted field keeps its current value and an empty string clears it, and a name must not be blank. squads_delete and squad_member_remove require confirm: true and answer with the deleted name. A run costs API quota: squads_run_member opens one real DSH session for that member, and squads_run_squad opens the Lead session of the whole squad with the goal carried by the squad context, never by a first message. A squad that pins no workspace is runnable: its session is composed in the Host default session directory. A run is refused before any session exists when a pinned workspace cannot be resolved on this Host, when the pinned agent preset is unknown, or when the ledger is unreadable; refusals arrive as ok:false with a stable code. Chinese triggers: 小队 / 小队定义 / 智能体小队.'

/**
 * The narrow Host face the tools need. `AgentsHostService` satisfies it
 * structurally, so a test can drive the same surface over a real ledger.
 */
export interface AgentsToolHost {
  /** Read the ledger snapshot the panel renders. */
  stateView(): Promise<AgentsStateView>
  /** Create a squad, or replace the editable fields of the one the draft names. */
  saveTeam(draft: TeamDraft): TeamDefinition
  /** Delete one squad with its member definitions. */
  deleteTeam(teamId: string): void
  /** Add a member, or replace the editable fields of the member the draft names. */
  saveMember(teamId: string, draft: MemberDraft): TeamDefinition
  /** Delete one member definition. */
  deleteMember(teamId: string, memberId: string): TeamDefinition
  /** Launch one member session. */
  run(request: RunRequestBody): Promise<RunRecord>
  /** Launch the Lead session of one whole squad. */
  runSquad(request: SquadRunRequestBody): Promise<RunRecord>
}

/** Unconstrained JSON value the tools return (their output schema is the JSON node). */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Model-facing JSON rendering shared by every tool. */
function renderJson(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Mark an already JSON-safe projection as the tool's canonical value. */
function json(value: unknown): Json {
  return value as Json
}

/** A domain refusal the model is expected to read and act on. */
function refused(code: AgentsErrorCode, message: string): Json {
  return json({ ok: false, code, message })
}

/**
 * Translate one caught failure into a value.
 * A refusal this plugin decided carries a stable code and becomes a value the
 * model can correct; anything else is a fault this surface cannot classify and
 * stays an exception.
 * @param error - the caught value.
 * @returns the refusal value.
 */
function refusalOf(error: unknown): Json {
  if (isAgentsError(error)) return refused(error.code, error.message)
  throw error
}

/** The one refusal every unusable id argument shares. */
function invalidId(message: string): Json {
  return refused('invalid-request', message + ': every id must be a non-blank string of at most ' + ID_MAX_LENGTH + ' characters')
}

/** Gate one single-squad argument through the body parser the delete route uses. */
function squadIdOf(value: unknown): string | undefined {
  return parseTeamDeleteRequestBody({ teamId: value })?.teamId
}

/** One member row, as squads_list reports it. */
function memberSummary(member: MemberDefinition): Record<string, unknown> {
  return {
    id: member.id,
    name: member.name,
    ...(member.preset === undefined ? {} : { preset: member.preset }),
    ...(member.permission === undefined ? {} : { permission: member.permission }),
    ...(member.model === undefined ? {} : { model: member.model }),
    ...(member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort }),
  }
}

/** One squad row, as squads_list reports it: the roster without the briefs. */
function teamSummary(team: TeamDefinition): Record<string, unknown> {
  return {
    id: team.id,
    name: team.name,
    ...(team.description === undefined ? {} : { description: team.description }),
    ...(team.workspaceId === undefined ? {} : { workspaceId: team.workspaceId }),
    ...(team.leadPreset === undefined ? {} : { leadPreset: team.leadPreset }),
    memberCount: team.members.length,
    members: team.members.map(memberSummary),
  }
}

/** The squad one call addresses, or undefined when the ledger holds none. */
async function currentTeam(host: AgentsToolHost, squadId: string): Promise<TeamDefinition | undefined> {
  return (await host.stateView()).teams.find(team => team.id === squadId)
}

/**
 * A partial update's value for one optional field: an omitted field keeps what
 * the definition holds, and an empty string clears it.
 */
function merged(next: string | undefined, current: string | undefined): string | undefined {
  return next === '' ? undefined : next === undefined ? current : next
}

/**
 * Build every squad tool bound to one Host service.
 * @param host - the Host service (or the structural face a test drives).
 * @returns the tool definitions, in {@link AGENTS_TOOL_NAMES} order.
 */
export function buildAgentsTools(host: AgentsToolHost): ToolDefinition[] {
  return [
    buildListTool(host),
    buildReadTool(host),
    buildCreateTool(host),
    buildUpdateTool(host),
    buildDeleteTool(host),
    buildMemberAddTool(host),
    buildMemberUpdateTool(host),
    buildMemberRemoveTool(host),
    buildRunMemberTool(host),
    buildRunSquadTool(host),
  ]
}

function buildListTool(host: AgentsToolHost): ToolDefinition {
  return defineTool({
    name: 'squads_list',
    description: 'List every squad definition this Host holds, with its roster and the pins each member carries. Read-only and free. Use squads_read for one squad\'s full definition, including the member briefs it does not repeat here.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderJson },
    async execute() {
      try {
        const state = await host.stateView()
        return json({ ok: true, squads: state.teams.map(teamSummary) })
      } catch (error) {
        return refusalOf(error)
      }
    },
  })
}

function buildReadTool(host: AgentsToolHost): ToolDefinition {
  return defineTool({
    name: 'squads_read',
    description: 'Read one squad definition in full: identity, workspace and lead preset, timestamps, and every member with its brief. Read-only and free. Call it before a partial update, so the fields the update omits are known rather than assumed.',
    parameters: {
      squadId: { type: 'string', description: 'Squad id, as squads_list reports it. Required.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const squadId = squadIdOf(args.squadId)
      if (squadId === undefined) return invalidId('squads_read names one squad')
      try {
        const team = await currentTeam(host, squadId)
        if (team === undefined) return refused('team-not-found', 'no squad has the id "' + squadId + '"')
        return json({ ok: true, squad: team })
      } catch (error) {
        return refusalOf(error)
      }
    },
  })
}

function buildCreateTool(host: AgentsToolHost): ToolDefinition {
  return defineTool({
    name: 'squads_create',
    description: 'Create one squad definition, optionally with its members in the same call. A squad is a reusable roster, not a running team: nothing executes until squads_run_member or squads_run_squad is called. The whole request is validated before the ledger is written, so a rejected member never leaves a half-built squad behind.',
    parameters: {
      name: { type: 'string', required: true, description: 'Squad name; it must not be blank and prefixes the title of every session the squad launches.' },
      description: { type: 'string', description: 'What the squad is for, shown in the panel.' },
      workspaceId: { type: 'string', description: 'Host workspace id every run of this squad lands in. Optional: a squad that pins none runs in the Host default session directory.' },
      leadPreset: { type: 'string', description: 'Agent preset id the whole-squad run composes its Lead session from.' },
      members: {
        type: 'array',
        description: 'Member definitions to add in the same call, in roster order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Member display name; it must not be blank.' },
            preset: { type: 'string', description: 'Agent preset id this member session composes from.' },
            permission: { type: 'string', description: 'Permission preset applied to the member session before its first step: one of read-only, workspace-write or danger-full-access.' },
            model: { type: 'string', description: 'Model route as provider/model, or a bare model id.' },
            reasoningEffort: { type: 'string', description: 'Reasoning effort id for the pinned model; it travels only with a model pin.' },
            brief: { type: 'string', description: 'Member-level brief that becomes this member session system prompt.' },
          },
        },
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const body = parseTeamRequestBody({
        team: {
          name: args.name,
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
          ...(args.leadPreset === undefined ? {} : { leadPreset: args.leadPreset }),
        },
      })
      if (body === undefined) return refused('invalid-request', 'the squad draft is not a usable definition: the name must not be blank and every text field stays within its cap')
      const members: MemberDraft[] = []
      for (const candidate of args.members ?? []) {
        const member = parseMemberDraft(candidate)
        if (member === undefined) {
          return refused('invalid-request', 'member "' + candidate.name + '" is not a usable definition: the name must not be blank, a permission must be one of the three sandbox modes, and every text field stays within its cap')
        }
        members.push(member)
      }
      try {
        let team = host.saveTeam(body.team)
        for (const member of members) team = host.saveMember(team.id, member)
        return json({ ok: true, squad: team })
      } catch (error) {
        return refusalOf(error)
      }
    },
  })
}

function buildUpdateTool(host: AgentsToolHost): ToolDefinition {
  return defineTool({
    name: 'squads_update',
    description: 'Change one squad definition. A partial merge: a field this call omits keeps the value the squad already has, and an empty string clears an optional one. The name cannot be blank. Members are edited through squad_member_add, squad_member_update and squad_member_remove, never here.',
    parameters: {
      squadId: { type: 'string', description: 'Squad id to change. Required.' },
      name: { type: 'string', description: 'Replacement name; it must not be blank.' },
      description: { type: 'string', description: 'Replacement description; an empty string clears it.' },
      workspaceId: { type: 'string', description: 'Replacement workspace id; an empty string clears it, and a squad that pins none runs in the Host default session directory.' },
      leadPreset: { type: 'string', description: 'Replacement Lead agent preset id; an empty string clears it.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const squadId = squadIdOf(args.squadId)
      if (squadId === undefined) return invalidId('squads_update names one squad')
      try {
        const current = await currentTeam(host, squadId)
        if (current === undefined) return refused('team-not-found', 'no squad has the id "' + squadId + '"')
        const body = parseTeamRequestBody({
          team: {
            id: current.id,
            name: args.name === undefined ? current.name : args.name,
            description: merged(args.description, current.description),
            workspaceId: merged(args.workspaceId, current.workspaceId),
            leadPreset: merged(args.leadPreset, current.leadPreset),
            ...(current.order === undefined ? {} : { order: current.order }),
          },
        })
        if (body === undefined) return refused('invalid-request', 'the squad update is not a usable definition: the name must not be blank and every text field stays within its cap')
        return json({ ok: true, squad: host.saveTeam(body.team) })
      } catch (error) {
        return refusalOf(error)
      }
    },
  })
}

function buildDeleteTool(host: AgentsToolHost): ToolDefinition {
  return defineTool({
    name: 'squads_delete',
    description: 'Delete one squad definition with every member it holds. Destructive and irreversible: pass confirm: true only after the user confirmed it. Run history stays, because it records sessions this Host opened rather than part of the definition. The reply names what was deleted.',
    parameters: {
      squadId: { type: 'string', description: 'Squad id to delete. Required.' },
      confirm: { type: 'boolean', description: 'Must be exactly true; anything else is refused before the ledger is touched.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      if (args.confirm !== true) return refused('invalid-request', 'squads_delete removes a squad definition; pass confirm: true once the user has confirmed the deletion')
      const squadId = squadIdOf(args.squadId)
      if (squadId === undefined) return invalidId('squads_delete names one squad')
      try {
        const current = await currentTeam(host, squadId)
        if (current === undefined) return refused('team-not-found', 'no squad has the id "' + squadId + '"')
        host.deleteTeam(squadId)
        return json({ ok: true, deleted: { id: current.id, name: current.name } })
      } catch (error) {
        return refusalOf(error)
      }
    },
  })
}

function buildMemberAddTool(host: AgentsToolHost): ToolDefinition {
  return defineTool({
    name: 'squad_member_add',
    description: 'Add one member definition to a squad. Nothing executes here: the member becomes reachable through squads_run_member, and a whole-squad run composes the Lead from the squad Lead preset, not from this member. The reply carries the saved squad and the new member with the id the Host minted.',
    parameters: {
      squadId: { type: 'string', description: 'Squad to add the member to. Required.' },
      name: { type: 'string', required: true, description: 'Member display name; it must not be blank.' },
      preset: { type: 'string', description: 'Agent preset id this member session composes from.' },
      permission: { type: 'string', description: 'Permission preset applied to the member session before its first step: one of read-only, workspace-write or danger-full-access.' },
      model: { type: 'string', description: 'Model route as provider/model, or a bare model id.' },
      reasoningEffort: { type: 'string', description: 'Reasoning effort id for the pinned model; it travels only with a model pin.' },
      brief: { type: 'string', description: 'Member-level brief that becomes this member session system prompt.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const squadId = squadIdOf(args.squadId)
      if (squadId === undefined) return invalidId('squad_member_add names one squad')
      const body = parseMemberRequestBody({
        teamId: squadId,
        member: {
          name: args.name,
          ...(args.preset === undefined ? {} : { preset: args.preset }),
          ...(args.permission === undefined ? {} : { permission: args.permission }),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
          ...(args.brief === undefined ? {} : { brief: args.brief }),
        },
      })
      if (body === undefined) return refused('invalid-request', 'the member draft is not a usable definition: the name must not be blank, a permission must be one of the three sandbox modes, and every text field stays within its cap')
      try {
        const current = await currentTeam(host, body.teamId)
        if (current === undefined) return refused('team-not-found', 'no squad has the id "' + body.teamId + '"')
        const known = new Set(current.members.map(member => member.id))
        const saved = host.saveMember(body.teamId, body.member)
        const added = saved.members.find(member => !known.has(member.id))
        if (added === undefined) throw new Error('the host saved no member row for squad_member_add')
        return json({ ok: true, squad: saved, member: memberSummary(added) })
      } catch (error) {
        return refusalOf(error)
      }
    },
  })
}

function buildMemberUpdateTool(host: AgentsToolHost): ToolDefinition {
  return defineTool({
    name: 'squad_member_update',
    description: 'Change one member definition of one squad. A partial merge: a field this call omits keeps the value the member already has, and an empty string clears an optional one (including the permission pin). The name cannot be blank. A member cannot be moved to another squad; delete it and add it there instead.',
    parameters: {
      squadId: { type: 'string', description: 'Squad the member belongs to. Required.' },
      memberId: { type: 'string', description: 'Member id, as squads_read reports it. Required.' },
      name: { type: 'string', description: 'Replacement display name; it must not be blank.' },
      preset: { type: 'string', description: 'Replacement agent preset id; an empty string clears it.' },
      permission: { type: 'string', description: 'Replacement permission preset, one of read-only, workspace-write or danger-full-access; an empty string clears the pin.' },
      model: { type: 'string', description: 'Replacement model route; an empty string clears it.' },
      reasoningEffort: { type: 'string', description: 'Replacement reasoning effort id; an empty string clears it.' },
      brief: { type: 'string', description: 'Replacement member brief; an empty string clears it.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const target = parseMemberDeleteRequestBody({ teamId: args.squadId, memberId: args.memberId })
      if (target === undefined) return invalidId('squad_member_update names one member of one squad')
      try {
        const current = await currentTeam(host, target.teamId)
        if (current === undefined) return refused('team-not-found', 'no squad has the id "' + target.teamId + '"')
        const member = current.members.find(candidate => candidate.id === target.memberId)
        if (member === undefined) return refused('member-not-found', 'no member has the id "' + target.memberId + '" in squad "' + current.name + '"')
        const body = parseMemberRequestBody({
          teamId: current.id,
          member: {
            id: member.id,
            name: args.name === undefined ? member.name : args.name,
            preset: merged(args.preset, member.preset),
            permission: merged(args.permission, member.permission),
            model: merged(args.model, member.model),
            reasoningEffort: merged(args.reasoningEffort, member.reasoningEffort),
            brief: merged(args.brief, member.brief),
          },
        })
        if (body === undefined) return refused('invalid-request', 'the member update is not a usable definition: the name must not be blank, a permission must be one of the three sandbox modes, and every text field stays within its cap')
        const saved = host.saveMember(body.teamId, body.member)
        const updated = saved.members.find(candidate => candidate.id === member.id)
        if (updated === undefined) throw new Error('the host returned no row for the member it just updated')
        return json({ ok: true, squad: saved, member: memberSummary(updated) })
      } catch (error) {
        return refusalOf(error)
      }
    },
  })
}

function buildMemberRemoveTool(host: AgentsToolHost): ToolDefinition {
  return defineTool({
    name: 'squad_member_remove',
    description: 'Delete one member definition from one squad. Destructive and irreversible: pass confirm: true only after the user confirmed it. The squad itself stays, and so does its run history. The reply names the deleted member.',
    parameters: {
      squadId: { type: 'string', description: 'Squad the member belongs to. Required.' },
      memberId: { type: 'string', description: 'Member id to delete. Required.' },
      confirm: { type: 'boolean', description: 'Must be exactly true; anything else is refused before the ledger is touched.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      if (args.confirm !== true) return refused('invalid-request', 'squad_member_remove deletes a member definition; pass confirm: true once the user has confirmed the deletion')
      const target = parseMemberDeleteRequestBody({ teamId: args.squadId, memberId: args.memberId })
      if (target === undefined) return invalidId('squad_member_remove names one member of one squad')
      try {
        const current = await currentTeam(host, target.teamId)
        if (current === undefined) return refused('team-not-found', 'no squad has the id "' + target.teamId + '"')
        const member = current.members.find(candidate => candidate.id === target.memberId)
        if (member === undefined) return refused('member-not-found', 'no member has the id "' + target.memberId + '" in squad "' + current.name + '"')
        host.deleteMember(target.teamId, target.memberId)
        return json({ ok: true, deleted: { id: member.id, name: member.name, squadId: target.teamId } })
      } catch (error) {
        return refusalOf(error)
      }
    },
  })
}

function buildRunMemberTool(host: AgentsToolHost): ToolDefinition {
  return defineTool({
    name: 'squads_run_member',
    description: 'Launch one real DSH session for one member of one squad, and record the run. This is not free: it creates a session and spends API quota. It fails closed before any session exists when the pinned workspace or agent preset cannot be resolved on this Host, or when the member pins an unusable model route; a squad that pins no workspace runs in the Host default session directory. The member brief reaches the session through its system prompt, so firstMessage is only ever the first user message.',
    parameters: {
      squadId: { type: 'string', description: 'Squad the member belongs to. Required.' },
      memberId: { type: 'string', description: 'Member id to launch. Required.' },
      firstMessage: { type: 'string', description: 'Optional first user message queued on the new session. Omit to launch it without one.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const body = parseRunRequestBody({
        teamId: args.squadId,
        memberId: args.memberId,
        ...(args.firstMessage === undefined ? {} : { firstMessage: args.firstMessage }),
      })
      if (body === undefined) return invalidId('squads_run_member names one member of one squad')
      try {
        return json({ ok: true, run: await host.run(body) })
      } catch (error) {
        return refusalOf(error)
      }
    },
  })
}

function buildRunSquadTool(host: AgentsToolHost): ToolDefinition {
  return defineTool({
    name: 'squads_run_squad',
    description: 'Launch the Lead session of one whole squad, and record the run. This is not free: it creates a session and spends API quota, and the Lead then works through the teams it composes. The goal travels through the squad system-prompt context, never as a first message, so the Lead reads it as its own charter; a run without one leaves the Lead without a stated goal. The same definition and workspace checks refuse the run before any session exists, and a squad that pins no workspace runs in the Host default session directory.',
    parameters: {
      squadId: { type: 'string', description: 'Squad to lead. Required.' },
      goal: { type: 'string', description: 'What the squad must achieve, carried by the squad context. Omit to leave the Lead without a stated goal.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const body = parseSquadRunRequestBody({
        teamId: args.squadId,
        ...(args.goal === undefined ? {} : { goal: args.goal }),
      })
      if (body === undefined) return invalidId('squads_run_squad names one squad')
      try {
        return json({ ok: true, run: await host.runSquad(body) })
      } catch (error) {
        return refusalOf(error)
      }
    },
  })
}
