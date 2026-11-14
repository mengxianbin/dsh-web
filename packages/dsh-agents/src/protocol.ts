/**
 * Frozen wire contract of the dsh-agents plugin.
 *
 * Owns the API prefix, the six route shapes, and the ledger record types the
 * Host serves and the browser imports. This file is the single source of the
 * contract: the client half type-imports these declarations and never restates
 * them, and no route outside the list below may be registered.
 *
 * M2 scope: definitions (teams and their members), single-member runs, and the
 * whole-squad run that creates the Lead session. Every M2 addition is additive:
 * a field this build adds is optional, and every M1 route keeps its exact shape,
 * so the existing browser half keeps compiling and working unchanged.
 *
 * @module @linxin666/dsh-agents/protocol
 */

/**
 * Root-absolute Host prefix. The browser half drops the leading slash, exactly
 * like the task board's `TASK_BOARD_API_PREFIX`.
 */
export const DSH_AGENTS_API_PREFIX = '/dsh-agents/api'

/** Ledger document generation this build reads and writes. */
export const DSH_AGENTS_SCHEMA_VERSION = 1 as const

/** Sandbox modes a member may pin; the DSH permission presets, verbatim. */
export const AGENTS_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One DSH permission preset a member may pin. */
export type AgentsPermission = (typeof AGENTS_PERMISSIONS)[number]

/** Longest accepted team or member display name. */
export const NAME_MAX_LENGTH = 120

/** Longest accepted team description. */
export const DESCRIPTION_MAX_LENGTH = 2_000

/** Longest accepted member-level brief (it lands in the system prompt). */
export const BRIEF_MAX_LENGTH = 4_000

/** Longest accepted pinned target (preset id, model route, effort id, workspace id). */
export const PIN_MAX_LENGTH = 200

/** Longest accepted definition id on the wire. */
export const ID_MAX_LENGTH = 128

/** Longest accepted first user message on a run request. */
export const FIRST_MESSAGE_MAX_LENGTH = 32_000

/** Longest accepted squad goal; it reaches the Lead through the system prompt. */
export const SQUAD_GOAL_MAX_LENGTH = 4_000

/** Longest accepted rough intent handed to the description model. */
export const DESCRIBE_INTENT_MAX_LENGTH = 1_000

/**
 * Stable machine codes every error reply carries. The browser switches on this
 * value; the human-readable `error` text beside it is not a contract and never
 * carries a stack trace.
 */
export const AGENTS_ERROR_CODES = [
  /** The request body is not a well-formed message of the addressed route. */
  'invalid-request',
  /** The body exceeded the route's byte cap. */
  'body-too-large',
  /** The route requires a JSON body and the caller sent something else. */
  'json-required',
  /** The method is not the one this route serves. */
  'method-not-allowed',
  /** The request did not arrive from this machine's own browser. */
  'forbidden',
  /** No team has that id. */
  'team-not-found',
  /** No member with that id exists in the addressed team. */
  'member-not-found',
  /** The deployment serves no host agent-preset registry. */
  'preset-registry-unavailable',
  /** The pinned agent preset id is not in the host registry. */
  'preset-unknown',
  /** The pinned agent preset exists but the host reports it unusable. */
  'preset-unavailable',
  /** The deployment serves no workspace registry. */
  'workspace-unavailable',
  /** The pinned workspace id is not in the host workspace registry. */
  'workspace-unknown',
  /** The member pins a model route that cannot be split into provider and model. */
  'model-pin-invalid',
  /** The session could not be created. */
  'session-create-failed',
  /** The session was created but could not be renamed to the member title. */
  'session-rename-failed',
  /** The session was created but refused the pinned permission or model. */
  'session-pin-failed',
  /** The session was created but the first message could not be queued. */
  'session-prompt-failed',
  /** A permission pin was requested and no command dispatcher serves `/permission`. */
  'permission-dispatcher-unavailable',
  /** The ledger on disk is unreadable or corrupt; nothing was overwritten. */
  'ledger-corrupt',
  /** Another process owns the ledger. */
  'ledger-owned',
  /** The ledger could not be written. */
  'ledger-write-failed',
  /** This deployment serves no model route, so no description can be written. */
  'describe-unavailable',
  /** The model behind a description failed, timed out, or answered nothing usable. */
  'describe-failed',
  /** The Host failed in a way this plugin did not anticipate. */
  'internal-error',
] as const

/** One stable machine code from {@link AGENTS_ERROR_CODES}. */
export type AgentsErrorCode = (typeof AGENTS_ERROR_CODES)[number]

/**
 * One reusable member definition: a display name, an optional DSH agent preset,
 * a permission, a model pin, a reasoning effort, and a member-level brief that
 * becomes part of that member session's system prompt.
 */
export interface MemberDefinition {
  id: string
  teamId: string
  name: string
  preset?: string
  permission?: 'read-only' | 'workspace-write' | 'danger-full-access'
  model?: string
  reasoningEffort?: string
  brief?: string
  createdAt: number
  updatedAt: number
}

/** One agent squad: an ordered set of member definitions sharing a workspace. */
export interface TeamDefinition {
  id: string
  name: string
  description?: string
  workspaceId?: string
  /**
   * Agent preset the whole-squad run composes the Lead session from. Absent
   * means the deployment (or the deployment preset) composes it.
   */
  leadPreset?: string
  order?: number
  createdAt: number
  updatedAt: number
  members: MemberDefinition[]
}

/** What one run launched: one member session, or the Lead session of a whole squad. */
export type RunKind = 'member' | 'squad'

/** One launched session: a member session, or the Lead session of a squad run. */
export interface RunRecord {
  id: string
  teamId: string
  /** The launched member; absent on a squad run, whose session leads the whole team. */
  memberId?: string
  sessionId: string
  createdAt: number
  status: 'running' | 'settled' | 'failed'
  failure?: string
  /** Absent on runs recorded before M2, which are member runs by construction. */
  kind?: RunKind
  /** The goal handed to the Lead session of a squad run; absent on member runs. */
  goal?: string
}

/** Definition fields a caller may write; `id` addresses an existing member. */
export type MemberDraft = Omit<MemberDefinition, 'id' | 'teamId' | 'createdAt' | 'updatedAt'> & { id?: string }

/** Definition fields a caller may write; `id` addresses an existing team. */
export type TeamDraft = Omit<TeamDefinition, 'id' | 'createdAt' | 'updatedAt' | 'members'> & { id?: string }

/**
 * One model route the Host's own model catalog offers, as a picker row of the
 * member form.
 */
export interface AgentsModelOption {
  /** Provider the route belongs to; the picker shows `provider/model`. */
  provider: string
  /** Model id inside that provider. */
  model: string
  /** Display label the catalog publishes; absent means show the route itself. */
  label?: string
  /**
   * The reasoning levels the catalog declares for this route. Absent when the
   * catalog published no reasoning metadata for the model at all; an empty list
   * means it published some and the model declares no level. The picker treats
   * the two differently, so they are not collapsed into one.
   */
  efforts?: readonly string[]
}

/** `GET {DSH_AGENTS_API_PREFIX}/state`: everything the browser panel renders. */
/**
 * One host workspace a squad can pin, as the panel's picker needs it.
 *
 * The picker shows the title and the path; the id is what the squad stores and
 * what the run gate validates against the host registry.
 */
export interface AgentsWorkspaceOption {
  /** Workspace id this squad pins. */
  id: string
  /** Display title the host registry gave it. */
  title: string
  /** Canonical directory path, when the host reports one. */
  path?: string
}

export interface AgentsStateView {
  teams: TeamDefinition[]
  runs: RunRecord[]
  host: { ownerPid: number }
  /**
   * Agent preset ids this deployment serves, as the Host's own preset registry
   * reports them. Additive and optional: M1 Hosts answer without it, and the
   * browser then offers no preset list instead of inventing one. The squad page
   * uses it to offer the Lead preset of a whole-squad run.
   */
  presets?: readonly string[]
  /**
   * Host workspaces this deployment offers as a squad pin, in registry order.
   * Additive and optional under the same rule as `presets`: a deployment that
   * serves no workspace registry answers without the key, and the squad form
   * then falls back to a typed id instead of an empty picker that reads as
   * "this machine has no workspace".
   */
  workspaces?: readonly AgentsWorkspaceOption[]
  /**
   * Model routes this deployment's own catalog offers. Additive and optional,
   * under the same rule as `presets`: a Host whose catalog service is absent,
   * empty or failing answers without the key, and the member form then offers no
   * model picker instead of an empty one that reads as "no model exists here".
   */
  models?: readonly AgentsModelOption[]
  /**
   * Every reasoning-effort level the offered models declare, in catalog order.
   * Absent whenever `models` is absent, and absent when no offered model
   * declares a level. A picker reads one model's own levels off
   * {@link AgentsModelOption.efforts} and falls back to this list only for a
   * route the catalog does not describe.
   */
  efforts?: readonly string[]
}

/** `POST {DSH_AGENTS_API_PREFIX}/team` body. */
export interface TeamRequestBody {
  team: TeamDraft
}

/** `POST {DSH_AGENTS_API_PREFIX}/team` reply. */
export interface TeamResponseBody {
  team: TeamDefinition
}

/** `POST {DSH_AGENTS_API_PREFIX}/team/delete` body. */
export interface TeamDeleteRequestBody {
  teamId: string
}

/** `POST {DSH_AGENTS_API_PREFIX}/member` body. */
export interface MemberRequestBody {
  teamId: string
  member: MemberDraft
}

/** `POST {DSH_AGENTS_API_PREFIX}/member` and `/member/delete` reply. */
export interface MemberResponseBody {
  team: TeamDefinition
}

/** `POST {DSH_AGENTS_API_PREFIX}/member/delete` body. */
export interface MemberDeleteRequestBody {
  teamId: string
  memberId: string
}

/** `POST {DSH_AGENTS_API_PREFIX}/run` body. */
export interface RunRequestBody {
  teamId: string
  memberId: string
  /** Optional first user message; the member brief never travels here. */
  firstMessage?: string
}

/** `POST {DSH_AGENTS_API_PREFIX}/run` reply. */
export interface RunResponseBody {
  run: RunRecord
}

/**
 * `POST {DSH_AGENTS_API_PREFIX}/squad/run` body: launch the Lead session of one
 * whole squad. The goal travels through the `team:squad` system-prompt context,
 * never through the first user message, which is reserved for the user.
 */
export interface SquadRunRequestBody {
  teamId: string
  /** What the squad must achieve; absent leaves the Lead without a stated goal. */
  goal?: string
  /** Optional first user message queued on the Lead session. */
  firstMessage?: string
}

/**
 * `POST {DSH_AGENTS_API_PREFIX}/describe` body: draft one squad description.
 *
 * The name is the identity the description has to fit; the intent is whatever
 * the user typed, which may be a bare phrase ("architecture review"). Both are
 * bounded here so a caller cannot turn the model call into a data pump.
 */
export interface DescribeRequestBody {
  /** The squad's display name. */
  name: string
  /** The user's rough intent, when they wrote one. */
  intent?: string
}

/** `POST {DSH_AGENTS_API_PREFIX}/describe` reply: one paragraph, ready to store. */
export interface DescribeResponseBody {
  description: string
}

/** `POST {DSH_AGENTS_API_PREFIX}/team/delete` reply. */
export interface OkResponseBody {
  ok: true
}

/** Every non-2xx reply: a stable code plus bounded human text, never a stack. */
export interface AgentsErrorBody {
  ok: false
  code: AgentsErrorCode
  error: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

/** Whether a value names one of the sandbox modes a member may pin. */
export function isAgentsPermission(value: unknown): value is AgentsPermission {
  return typeof value === 'string' && (AGENTS_PERMISSIONS as readonly string[]).includes(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/**
 * Read an optional bounded text field, trimming it and collapsing blank to
 * absent: the ledger never stores "" for a pin the user cleared.
 * @returns the trimmed text, undefined for blank, or null when the value is not
 *   a string within the cap (the caller rejects the request).
 */
function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined
  if (!boundedString(value, max)) return null
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function definitionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= ID_MAX_LENGTH ? value.trim() : undefined
}

/**
 * Gate one member draft from the wire. Unknown fields are refused rather than
 * ignored, so a caller cannot smuggle a timestamp or an id the Host did not
 * mint into a definition.
 * @param value - decoded JSON value.
 * @returns the normalized draft, or undefined when the request is rejected.
 */
export function parseMemberDraft(value: unknown): MemberDraft | undefined {
  const draft = record(value)
  if (draft === undefined || !exactKeys(draft, ['id', 'name', 'preset', 'permission', 'model', 'reasoningEffort', 'brief'])) return undefined
  if (typeof draft.name !== 'string') return undefined
  const name = draft.name.trim()
  if (name === '' || name.length > NAME_MAX_LENGTH) return undefined
  const id = draft.id === undefined ? undefined : definitionId(draft.id)
  if (draft.id !== undefined && id === undefined) return undefined
  if (draft.permission !== undefined && !isAgentsPermission(draft.permission)) return undefined
  const preset = optionalText(draft.preset, PIN_MAX_LENGTH)
  const model = optionalText(draft.model, PIN_MAX_LENGTH)
  const reasoningEffort = optionalText(draft.reasoningEffort, PIN_MAX_LENGTH)
  const brief = optionalText(draft.brief, BRIEF_MAX_LENGTH)
  if (preset === null || model === null || reasoningEffort === null || brief === null) return undefined
  return {
    ...(id === undefined ? {} : { id }),
    name,
    ...(preset === undefined ? {} : { preset }),
    ...(draft.permission === undefined ? {} : { permission: draft.permission }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(brief === undefined ? {} : { brief }),
  }
}

/**
 * Gate one team draft from the wire. Same rules as {@link parseMemberDraft}:
 * exact keys, bounded text, and `order` only as a finite integer.
 * @param value - decoded JSON value.
 * @returns the normalized draft, or undefined when the request is rejected.
 */
export function parseTeamDraft(value: unknown): TeamDraft | undefined {
  const draft = record(value)
  if (draft === undefined || !exactKeys(draft, ['id', 'name', 'description', 'workspaceId', 'leadPreset', 'order'])) return undefined
  if (typeof draft.name !== 'string') return undefined
  const name = draft.name.trim()
  if (name === '' || name.length > NAME_MAX_LENGTH) return undefined
  const id = draft.id === undefined ? undefined : definitionId(draft.id)
  if (draft.id !== undefined && id === undefined) return undefined
  if (draft.order !== undefined && (typeof draft.order !== 'number' || !Number.isInteger(draft.order))) return undefined
  const description = optionalText(draft.description, DESCRIPTION_MAX_LENGTH)
  const workspaceId = optionalText(draft.workspaceId, PIN_MAX_LENGTH)
  const leadPreset = optionalText(draft.leadPreset, PIN_MAX_LENGTH)
  if (description === null || workspaceId === null || leadPreset === null) return undefined
  return {
    ...(id === undefined ? {} : { id }),
    name,
    ...(description === undefined ? {} : { description }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(leadPreset === undefined ? {} : { leadPreset }),
    ...(draft.order === undefined ? {} : { order: draft.order }),
  }
}

/** Gate the `POST /team` body. */
export function parseTeamRequestBody(value: unknown): TeamRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['team'])) return undefined
  const team = parseTeamDraft(body.team)
  return team === undefined ? undefined : { team }
}

/** Gate the `POST /team/delete` body. */
export function parseTeamDeleteRequestBody(value: unknown): TeamDeleteRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['teamId'])) return undefined
  const teamId = definitionId(body.teamId)
  return teamId === undefined ? undefined : { teamId }
}

/** Gate the `POST /member` body. */
export function parseMemberRequestBody(value: unknown): MemberRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['teamId', 'member'])) return undefined
  const teamId = definitionId(body.teamId)
  if (teamId === undefined) return undefined
  const member = parseMemberDraft(body.member)
  return member === undefined ? undefined : { teamId, member }
}

/** Gate the `POST /member/delete` body. */
export function parseMemberDeleteRequestBody(value: unknown): MemberDeleteRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['teamId', 'memberId'])) return undefined
  const teamId = definitionId(body.teamId)
  const memberId = definitionId(body.memberId)
  return teamId === undefined || memberId === undefined ? undefined : { teamId, memberId }
}

/**
 * Gate the `POST /run` body. The first message is bounded here only; whether a
 * run prompts at all is the Host's decision (an absent message launches the
 * session without one, and the member brief never rides this field).
 */
export function parseRunRequestBody(value: unknown): RunRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['teamId', 'memberId', 'firstMessage'])) return undefined
  const teamId = definitionId(body.teamId)
  const memberId = definitionId(body.memberId)
  if (teamId === undefined || memberId === undefined) return undefined
  if (body.firstMessage !== undefined && !boundedString(body.firstMessage, FIRST_MESSAGE_MAX_LENGTH)) return undefined
  const firstMessage = typeof body.firstMessage === 'string' && body.firstMessage.trim() !== '' ? body.firstMessage : undefined
  return { teamId, memberId, ...(firstMessage === undefined ? {} : { firstMessage }) }
}

/**
 * Gate the `POST /squad/run` body. Same exact-key rule as every other route:
 * a caller cannot smuggle a field this build does not read.
 */
export function parseSquadRunRequestBody(value: unknown): SquadRunRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['teamId', 'goal', 'firstMessage'])) return undefined
  const teamId = definitionId(body.teamId)
  if (teamId === undefined) return undefined
  if (body.goal !== undefined && !boundedString(body.goal, SQUAD_GOAL_MAX_LENGTH)) return undefined
  if (body.firstMessage !== undefined && !boundedString(body.firstMessage, FIRST_MESSAGE_MAX_LENGTH)) return undefined
  const goal = typeof body.goal === 'string' && body.goal.trim() !== '' ? body.goal.trim() : undefined
  const firstMessage = typeof body.firstMessage === 'string' && body.firstMessage.trim() !== '' ? body.firstMessage : undefined
  return { teamId, ...(goal === undefined ? {} : { goal }), ...(firstMessage === undefined ? {} : { firstMessage }) }
}

/**
 * Gate the `POST /describe` body. The name is required — the description is
 * written for it — while an absent intent is a legitimate request: it asks the
 * model to describe the squad from its name alone.
 */
export function parseDescribeRequestBody(value: unknown): DescribeRequestBody | undefined {
  const body = record(value)
  if (body === undefined || !exactKeys(body, ['name', 'intent'])) return undefined
  const name = optionalText(body.name, NAME_MAX_LENGTH)
  if (name === undefined || name === null) return undefined
  const intent = optionalText(body.intent, DESCRIBE_INTENT_MAX_LENGTH)
  if (intent === null) return undefined
  return { name, ...(intent === undefined ? {} : { intent }) }
}

/**
 * The read-only roster route the browser falls back to when the shared session
 * store's `agentTeam` projection is not reachable from its context.
 *
 * PROPOSED, not served by this build: it is deliberately OUTSIDE
 * {@link DSH_AGENTS_ROUTE_PATHS}, which stays the exact list of routes the Host
 * registers today. A Host that adopts it answers
 * `{ members, failure? }` for one Lead session id and nothing else; the browser
 * half reads it through `src/client/team-source.ts`, so adopting it is one file
 * (plus this route) and no page change.
 */
export const DSH_AGENTS_SQUAD_TEAM_PATH = DSH_AGENTS_API_PREFIX + '/squad/team'

/** One live squad session as the proposed roster route would report it. */
export interface SquadTeamMemberWire {
  /** Session id of the Lead or of one teammate session. */
  id: string
  /** Display name the Lead gave the teammate; the projection names the Lead `lead`. */
  name: string
  role: 'lead' | 'teammate'
  phase: 'provisioning' | 'active' | 'failed'
  /** Why this member failed to start, when it did. */
  error?: string
}

/** `GET {DSH_AGENTS_SQUAD_TEAM_PATH}?sessionId=<lead session id>` reply. */
export interface SquadTeamResponseBody {
  members: SquadTeamMemberWire[]
  /** The Lead's own projection failure, when the team state could not be folded. */
  failure?: string
}

/**
 * The exact path of every route this plugin serves. The Host registers these
 * and nothing else; a caller that wants a new operation amends this list first.
 */
export const DSH_AGENTS_ROUTE_PATHS = [
  DSH_AGENTS_API_PREFIX + '/state',
  DSH_AGENTS_API_PREFIX + '/team',
  DSH_AGENTS_API_PREFIX + '/team/delete',
  DSH_AGENTS_API_PREFIX + '/member',
  DSH_AGENTS_API_PREFIX + '/member/delete',
  DSH_AGENTS_API_PREFIX + '/run',
  DSH_AGENTS_API_PREFIX + '/squad/run',
  DSH_AGENTS_API_PREFIX + '/describe',
] as const
