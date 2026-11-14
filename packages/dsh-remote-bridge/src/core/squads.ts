/**
 * The squads channel: the squad domain of the `dsh-agents` plugin — its
 * definitions and the runs that launch sessions — as a phone reads and drives
 * it.
 *
 * Nothing about a squad is modelled here. A squad is the plugin's own team row
 * with the definition timestamps dropped, a run is the plugin's own run record
 * with the goal it was given dropped, and a refusal the plugin raised crosses
 * with the plugin's own code. What this module owns is the mapping onto the
 * frozen `squads.v1` bodies plus the transport seam a Host half implements to
 * reach the domain.
 *
 * The seam answers the plugin's rows unread (`unknown`), so one mapping serves
 * both ways a Host can reach them: the plugin's HTTP routes over loopback, and
 * the read-only ledger fallback. A row this build cannot read is refused rather
 * than repaired, because a repaired squad is a squad the user never wrote.
 * @module dsh-remote-bridge/core/squads
 */

import {
  CODE_SQUADS_UNAVAILABLE,
  METHOD_SQUADS_LIST,
  METHOD_SQUADS_RUN_MEMBER,
  METHOD_SQUADS_RUNS,
  METHOD_SQUADS_RUN_SQUAD,
  METHOD_SQUADS_STATE,
} from './protocol.ts'

/**
 * Every method the squads capability puts in a client's protocol. The gate in
 * `connection.ts` reads this set once, so a method added beside these is gated
 * by the same declaration rather than by a second list to keep in step.
 */
export const SQUAD_METHODS: ReadonlySet<string> = new Set([
  METHOD_SQUADS_STATE,
  METHOD_SQUADS_LIST,
  METHOD_SQUADS_RUNS,
  METHOD_SQUADS_RUN_MEMBER,
  METHOD_SQUADS_RUN_SQUAD,
])

/** Sandbox modes a member may pin; the DSH permission presets, as the plugin spells them. */
export type SquadMemberPermission = 'read-only' | 'workspace-write' | 'danger-full-access'

const PERMISSIONS: ReadonlySet<string> = new Set<SquadMemberPermission>(['read-only', 'workspace-write', 'danger-full-access'])

/** One member of a squad: a display name and the pins its session is composed from. */
export interface SquadMember {
  id: string
  name: string
  preset?: string
  permission?: SquadMemberPermission
  model?: string
  reasoningEffort?: string
  brief?: string
}

/** One squad: an ordered set of member definitions sharing a workspace. */
export interface Squad {
  id: string
  name: string
  description?: string
  workspaceId?: string
  leadPreset?: string
  order?: number
  members: SquadMember[]
}

/** One launched session: a member session, or the Lead session of a whole squad. */
export interface SquadRun {
  id: string
  squadId: string
  kind: 'squad' | 'member'
  memberId?: string
  sessionId: string
  createdAt: number
  status: 'running' | 'settled' | 'failed'
  failure?: string
}

/** The `squads.state` body: definitions, run history, the offered presets and the owning pid. */
export interface SquadsState {
  squads: Squad[]
  runs: SquadRun[]
  presets?: string[]
  host: { ownerPid?: number }
}

/** What `squads.runMember` asks the domain to launch. */
export interface SquadMemberRunRequest {
  squadId: string
  memberId: string
  firstMessage?: string
}

/** What `squads.runSquad` asks the domain to launch. */
export interface SquadRunRequest {
  squadId: string
  goal?: string
}

/**
 * A refusal this channel answers with. The transport raises it and the
 * connection publishes its `code` and text unchanged, so a domain refusal
 * (`team-not-found`, `preset-unknown`) and a capability refusal
 * (`squads-unavailable`, `squads-run-unavailable`) reach the client the same way.
 */
export class SquadRefusal extends Error {
  /** Stable machine code the client switches on. */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SquadRefusal'
    this.code = code
  }
}

/** @returns whether a caught value is this channel's own refusal. */
export function isSquadRefusal(value: unknown): value is SquadRefusal {
  return value instanceof SquadRefusal
}

/**
 * How a Host reaches the squad domain. Every method answers the plugin's own
 * body unread: `state` is one `{teams, runs, host, presets?}` document, and the
 * two run methods answer one `{run}` document.
 */
export interface SquadTransport {
  /** Definitions, run history and the owning pid, as the domain publishes them. */
  state(): Promise<unknown>
  /** Launch one member session. */
  runMember(request: SquadMemberRunRequest): Promise<unknown>
  /** Launch the Lead session of one whole squad. */
  runSquad(request: SquadRunRequest): Promise<unknown>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Read one optional text field.
 * @returns the text, `undefined` when the row does not carry it, or `null` when
 *   it carries something this build cannot read as text.
 */
function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' && value !== '' ? value : null
}

function unusable(what: string): SquadRefusal {
  return new SquadRefusal(CODE_SQUADS_UNAVAILABLE, `the dsh-agents answer carries ${what} this bridge cannot read`)
}

/**
 * Map one persisted member row.
 * @param value - the row as the domain stored it.
 * @param squadId - the squad the row belongs to, when the row is read from a squad.
 * @returns the member, without the definition timestamps and the team backlink.
 */
function memberOf(value: unknown, squadId?: string): SquadMember {
  const row = record(value)
  if (row === undefined) throw unusable('a member row that is not an object')
  if (typeof row.id !== 'string' || row.id === '' || typeof row.name !== 'string' || row.name === '') {
    throw unusable('a member row without an id and a name')
  }
  if (squadId !== undefined && row.teamId !== undefined && row.teamId !== squadId) {
    throw unusable('a member row of another squad')
  }
  const preset = optionalText(row.preset)
  const model = optionalText(row.model)
  const reasoningEffort = optionalText(row.reasoningEffort)
  const brief = optionalText(row.brief)
  if (preset === null || model === null || reasoningEffort === null || brief === null) throw unusable('a member pin that is not text')
  if (row.permission !== undefined && !PERMISSIONS.has(String(row.permission))) throw unusable('a member permission outside the DSH presets')
  return {
    id: row.id,
    name: row.name,
    ...(preset === undefined ? {} : { preset }),
    ...(row.permission === undefined ? {} : { permission: row.permission as SquadMemberPermission }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(brief === undefined ? {} : { brief }),
  }
}

/**
 * Map one persisted squad row.
 * @param value - the team row as the domain stored it.
 * @returns the squad, its members' own definition timestamps dropped with it.
 */
function squadOf(value: unknown): Squad {
  const row = record(value)
  if (row === undefined) throw unusable('a squad row that is not an object')
  if (typeof row.id !== 'string' || row.id === '' || typeof row.name !== 'string' || row.name === '') {
    throw unusable('a squad row without an id and a name')
  }
  const description = optionalText(row.description)
  const workspaceId = optionalText(row.workspaceId)
  const leadPreset = optionalText(row.leadPreset)
  if (description === null || workspaceId === null || leadPreset === null) throw unusable('a squad pin that is not text')
  if (row.order !== undefined && (typeof row.order !== 'number' || !Number.isInteger(row.order))) throw unusable('a squad order that is not a whole number')
  if (!Array.isArray(row.members)) throw unusable('a squad row with no member list')
  return {
    id: row.id,
    name: row.name,
    ...(description === undefined ? {} : { description }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(leadPreset === undefined ? {} : { leadPreset }),
    ...(row.order === undefined ? {} : { order: row.order }),
    members: row.members.map(member => memberOf(member, row.id as string)),
  }
}

/**
 * Map one run record. `kind` is required on this wire and absent on every run the
 * domain recorded before whole-squad runs existed, so an absent kind reads as the
 * member run it is by construction — the same default the plugin itself applies.
 * @param value - the run as the domain stored it.
 * @returns the run, the goal its Lead was given dropped.
 */
function runOf(value: unknown): SquadRun {
  const row = record(value)
  if (row === undefined) throw unusable('a run row that is not an object')
  if (typeof row.id !== 'string' || row.id === '' || typeof row.teamId !== 'string' || row.teamId === '') {
    throw unusable('a run row without an id and a squad id')
  }
  if (typeof row.sessionId !== 'string' || row.sessionId === '') throw unusable('a run row without a session id')
  if (typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt)) throw unusable('a run row without a creation time')
  if (row.status !== 'running' && row.status !== 'settled' && row.status !== 'failed') throw unusable('a run row outside the three statuses')
  if (row.kind !== undefined && row.kind !== 'member' && row.kind !== 'squad') throw unusable('a run of an unknown kind')
  if (row.failure !== undefined && typeof row.failure !== 'string') throw unusable('a run failure that is not text')
  const kind = row.kind === 'squad' ? 'squad' : 'member'
  if (kind === 'member' && (typeof row.memberId !== 'string' || row.memberId === '')) throw unusable('a member run without a member id')
  if (kind === 'squad' && row.memberId !== undefined) throw unusable('a squad run that names a member')
  return {
    id: row.id,
    squadId: row.teamId,
    kind,
    ...(kind === 'squad' ? {} : { memberId: row.memberId as string }),
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    status: row.status,
    ...(row.failure === undefined ? {} : { failure: row.failure }),
  }
}

/**
 * Read the preset ids the domain offers as a Lead preset.
 * @param value - the answer's `presets`.
 * @returns the ids, or `undefined` when the host published no usable list — an
 *   empty list would say this deployment serves none, which is a different claim.
 */
function presetsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.every(entry => typeof entry === 'string' && entry !== '') ? [...value] as string[] : undefined
}

/**
 * Read the owning pid beside the definitions.
 * @param value - the answer's `host`.
 * @returns `{ownerPid}` when the domain named one, or an empty object.
 */
function hostOf(value: unknown): SquadsState['host'] {
  const pid = record(value)?.ownerPid
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { ownerPid: pid } : {}
}

/**
 * Map one `squads.state` answer.
 * @param source - the domain's `{teams, runs, host, presets?}` document, from
 *   either the plugin's route or its ledger.
 * @returns the frozen state body.
 */
export function squadsStateOf(source: unknown): SquadsState {
  const body = record(source)
  if (body === undefined || !Array.isArray(body.teams) || !Array.isArray(body.runs)) {
    throw new SquadRefusal(CODE_SQUADS_UNAVAILABLE, 'the dsh-agents state answer is not a squad domain this bridge can read')
  }
  const presets = presetsOf(body.presets)
  return {
    squads: body.teams.map(squadOf),
    runs: body.runs.map(runOf),
    ...(presets === undefined ? {} : { presets }),
    host: hostOf(body.host),
  }
}

/**
 * Map one run answer.
 * @param source - the domain's `{run}` document.
 * @returns the frozen run row.
 */
export function squadRunOf(source: unknown): SquadRun {
  const run = record(record(source)?.run)
  if (run === undefined) throw new SquadRefusal(CODE_SQUADS_UNAVAILABLE, 'the dsh-agents run answer carries no run this bridge can read')
  return runOf(run)
}

/** @returns a non-empty string payload value, or undefined. */
function textArg(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read an optional message field.
 * @returns the text as the client wrote it, `undefined` when it is absent or
 *   blank, or `null` when the field carries something that is not text.
 */
function messageArg(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  return value.trim() === '' ? undefined : value
}

/**
 * Gate `squads.runMember`'s payload. Only the two names this command needs are
 * required; the lengths the domain accepts are the domain's own, so an oversized
 * message is forwarded and refused there instead of being cut here.
 * @param payload - the request's `p`.
 * @returns the request, or undefined when it does not name a squad and a member.
 */
export function parseSquadMemberRun(payload: Readonly<Record<string, unknown>>): SquadMemberRunRequest | undefined {
  const squadId = textArg(payload, 'squadId')
  const memberId = textArg(payload, 'memberId')
  if (squadId === undefined || memberId === undefined) return undefined
  const firstMessage = messageArg(payload.firstMessage)
  if (firstMessage === null) return undefined
  return { squadId, memberId, ...(firstMessage === undefined ? {} : { firstMessage }) }
}

/**
 * Gate `squads.runSquad`'s payload.
 * @param payload - the request's `p`.
 * @returns the request, or undefined when it does not name a squad.
 */
export function parseSquadRun(payload: Readonly<Record<string, unknown>>): SquadRunRequest | undefined {
  const squadId = textArg(payload, 'squadId')
  if (squadId === undefined) return undefined
  const goal = messageArg(payload.goal)
  if (goal === null) return undefined
  return { squadId, ...(goal === undefined ? {} : { goal }) }
}
