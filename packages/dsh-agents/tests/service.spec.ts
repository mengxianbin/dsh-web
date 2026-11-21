/**
 * Owns the squad service: definition CRUD over one ledger, the served ordering,
 * and every run path that must fail closed before a session exists plus every
 * one that must leave a run record behind.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsError } from '../src/core/errors.ts'
import { AGENTS_LEDGER_FILE, RUN_HISTORY_LIMIT } from '../src/host/ledger.ts'
import type { MemberRunGateway } from '../src/host/run-gateway.ts'
import { AgentsHostService } from '../src/host/service.ts'
import { DSH_AGENTS_SCHEMA_VERSION, type RunRecord } from '../src/protocol.ts'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'

const NOW = 1_700_000_000_000
const services: AgentsHostService[] = []
const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-service-'))
  roots.push(dir)
  return dir
}

function gateway(overrides: Partial<MemberRunGateway> = {}): MemberRunGateway {
  return {
    listPresets: vi.fn(async () => [{ id: 'xundong' }]),
    createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
    renameSession: vi.fn(async () => undefined),
    applyPermission: vi.fn(async () => undefined),
    selectModel: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    ...overrides,
  }
}

/** One fake host workspace registry: the face the service resolves per call. */
interface FakeRegistry {
  list(): readonly Workspace[]
}

const workspaces: FakeRegistry = { list: (): readonly Workspace[] => [{ id: 'ws-1', name: 'repo' } as unknown as Workspace] }

function service(options: { gateway?: MemberRunGateway; workspaces?: FakeRegistry; dir?: string } = {}): AgentsHostService {
  let counter = 0
  const picked = 'workspaces' in options ? options.workspaces : workspaces
  const instance = new AgentsHostService({
    dir: options.dir ?? tempDir(),
    gateway: options.gateway ?? gateway(),
    ...(picked === undefined ? {} : { workspaces: () => picked }),
    now: () => NOW + counter++,
    idFactory: () => 'id-' + (++counter),
  })
  services.push(instance)
  return instance
}

function codeOf(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    if (error instanceof AgentsError) return error.code
    throw error
  }
  throw new Error('the service did not refuse')
}

async function asyncCodeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
  } catch (error) {
    if (error instanceof AgentsError) return error.code
    throw error
  }
  throw new Error('the service did not refuse')
}

/** A team whose one member can run: workspace pinned, preset served. */
function seedRunnable(instance: AgentsHostService): { teamId: string; memberId: string } {
  const created = instance.saveTeam({ name: 'Squad', workspaceId: 'ws-1' })
  const withMember = instance.saveMember(created.id, { name: '寻冬', preset: 'xundong', permission: 'read-only', model: 'deepseek/deepseek-chat', reasoningEffort: 'high', brief: '你是寻冬。' })
  return { teamId: created.id, memberId: withMember.members[0].id }
}

afterEach(() => {
  for (const instance of services.splice(0)) instance.dispose()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('definition CRUD', () => {
  it('user creates a team and replaces it by id without losing its identity', () => {
    // Given a created team, When a draft naming its id replaces it, Then the id and stamp survive and the new name lands.
    const instance = service()
    const created = instance.saveTeam({ name: 'Squad' })
    expect(created.members).toEqual([])
    const updated = instance.saveTeam({ id: created.id, name: 'Renamed', order: 2 })
    expect(updated).toMatchObject({ id: created.id, createdAt: created.createdAt, name: 'Renamed', order: 2 })
    expect(instance.state.teams).toHaveLength(1)
  })

  it('operator refuses an update that names a team the ledger does not hold', () => {
    // Given no such team, When an update names it, Then the write is refused as not found.
    expect(codeOf(() => service().saveTeam({ id: 'ghost', name: 'Squad' }))).toBe('team-not-found')
  })

  it('user adds, edits and deletes a member with its id stable throughout', () => {
    // Given a team, When a member is added, edited and deleted, Then the id survives the edit and the team stamp moves.
    const instance = service()
    const team = instance.saveTeam({ name: 'Squad' })
    const withMember = instance.saveMember(team.id, { name: 'A', permission: 'read-only' })
    const member = withMember.members[0]
    expect(withMember.updatedAt).toBeGreaterThan(team.updatedAt)

    const edited = instance.saveMember(team.id, { id: member.id, name: 'B', brief: 'b' })
    expect(edited.members[0]).toMatchObject({ id: member.id, createdAt: member.createdAt, name: 'B', brief: 'b' })
    expect(edited.members[0].permission).toBeUndefined()

    const cleared = instance.deleteMember(team.id, member.id)
    expect(cleared.members).toEqual([])
    expect(codeOf(() => instance.deleteMember(team.id, member.id))).toBe('member-not-found')
  })

  it('user sees members in insertion order and teams in their declared order', () => {
    // Given two teams with and without an order, When they are read back, Then the ordered team comes first and members keep insertion order.
    const instance = service()
    const first = instance.saveTeam({ name: 'First', order: 5 })
    const second = instance.saveTeam({ name: 'Second' })
    instance.saveMember(first.id, { name: 'member-1' })
    instance.saveMember(first.id, { name: 'member-2' })
    expect(instance.state.teams.map(team => team.id)).toEqual([first.id, second.id])
    expect(instance.state.teams[0].members.map(member => member.name)).toEqual(['member-1', 'member-2'])
  })

  it('operator refuses a member edit that addresses another team', () => {
    // Given a member of team A, When the edit names team B, Then it is refused and team A keeps the member.
    const instance = service()
    const teamA = instance.saveTeam({ name: 'A' })
    const teamB = instance.saveTeam({ name: 'B' })
    const member = instance.saveMember(teamA.id, { name: 'M' }).members[0]
    expect(codeOf(() => instance.saveMember(teamB.id, { id: member.id, name: 'M2' }))).toBe('member-not-found')
    expect(codeOf(() => instance.saveMember('ghost', { name: 'M2' }))).toBe('team-not-found')
    expect(instance.state.teams[0].members[0].id).toBe(member.id)
  })

  it('user deletes a squad while the run history it produced stays readable', async () => {
    // Given a launched run, When its team is deleted, Then no team remains and the run record still names that session.
    const instance = service()
    const { teamId } = seedRunnable(instance)
    const run = await instance.run({ teamId, memberId: instance.state.teams[0].members[0].id })
    instance.deleteTeam(teamId)
    expect(instance.state.teams).toEqual([])
    expect(instance.state.runs).toEqual([run])
  })
})

describe('run: failures before a session exists', () => {
  it('operator runs a member of a team that pins no workspace and the session lands on the host default', async () => {
    // Given an unpinned team, When its member runs, Then a session is created with no workspaceId at all and the run is recorded.
    const requested: unknown[] = []
    const fake = gateway({ createSession: vi.fn(async (input) => { requested.push(input); return { sessionId: 'session-1' } }) })
    const instance = service({ gateway: fake })
    const team = instance.saveTeam({ name: 'Squad' })
    const member = instance.saveMember(team.id, { name: 'M' }).members[0]

    const run = await instance.run({ teamId: team.id, memberId: member.id })
    expect(fake.createSession).toHaveBeenCalledTimes(1)
    expect(requested).toEqual([{}])
    expect(requested.map(input => Object.keys(input as Record<string, unknown>))).toEqual([[]])
    expect(run).toMatchObject({ teamId: team.id, memberId: member.id, sessionId: 'session-1', status: 'running' })
    expect(instance.state.runs).toEqual([run])
  })

  it('operator refuses to run when the deployment serves no workspace registry', async () => {
    // Given no workspace registry, When a member runs, Then the pinned workspace cannot be validated and the run is refused.
    const instance = service({ workspaces: undefined })
    const { teamId, memberId } = seedRunnable(instance)
    expect(await asyncCodeOf(() => instance.run({ teamId, memberId }))).toBe('workspace-unavailable')
  })

  it('operator refuses a pinned workspace the registry does not serve', async () => {
    // Given a workspace id the host does not list, When the member runs, Then the run is refused before any session exists.
    const instance = service()
    const team = instance.saveTeam({ name: 'Squad', workspaceId: 'ws-gone' })
    const member = instance.saveMember(team.id, { name: 'M' }).members[0]
    expect(await asyncCodeOf(() => instance.run({ teamId: team.id, memberId: member.id }))).toBe('workspace-unknown')
    expect(instance.state.runs).toEqual([])
  })

  it('operator refuses an unusable model pin before a session exists', async () => {
    // Given a model pin with a blank model beside the slash, When the member runs, Then the route is refused rather than half-read.
    const instance = service()
    const team = instance.saveTeam({ name: 'Squad', workspaceId: 'ws-1' })
    const member = instance.saveMember(team.id, { name: 'M', model: 'deepseek/' }).members[0]
    expect(await asyncCodeOf(() => instance.run({ teamId: team.id, memberId: member.id }))).toBe('model-pin-invalid')
  })

  it('operator refuses to run when the deployment serves no agent-preset registry', async () => {
    // Given no preset registry, When a member pins a preset, Then the run fails closed instead of composing a default session.
    const instance = service({ gateway: gateway({ listPresets: vi.fn(async () => undefined) }) })
    const { teamId, memberId } = seedRunnable(instance)
    expect(await asyncCodeOf(() => instance.run({ teamId, memberId }))).toBe('preset-registry-unavailable')
  })

  it('operator refuses an unknown preset id', async () => {
    // Given a registry that does not hold the pinned id, When the member runs, Then the run is refused as an unknown preset.
    const instance = service({ gateway: gateway({ listPresets: vi.fn(async () => [{ id: 'other' }]) }) })
    const { teamId, memberId } = seedRunnable(instance)
    expect(await asyncCodeOf(() => instance.run({ teamId, memberId }))).toBe('preset-unknown')
  })

  it('operator refuses a preset the registry reports broken, quoting the reason', async () => {
    // Given a preset marked unusable, When the member runs, Then the run is refused and the host reason is carried to the caller.
    const instance = service({ gateway: gateway({ listPresets: vi.fn(async () => [{ id: 'xundong', broken: 'missing dependency' }]) }) })
    const { teamId, memberId } = seedRunnable(instance)
    expect(await asyncCodeOf(() => instance.run({ teamId, memberId }))).toBe('preset-unavailable')
    await asyncCodeOf(() => instance.run({ teamId, memberId })).catch((error: AgentsError) => {
      expect(error.message).toContain('missing dependency')
    })
  })

  it('operator records nothing when the host refuses to create the session', async () => {
    // Given a host that refuses the session, When the member runs, Then the failure is named and the ledger gains no run.
    const createSession = vi.fn(async () => { throw new Error('quota') })
    const instance = service({ gateway: gateway({ createSession }) })
    const { teamId, memberId } = seedRunnable(instance)
    expect(await asyncCodeOf(() => instance.run({ teamId, memberId }))).toBe('session-create-failed')
    expect(instance.state.runs).toEqual([])
  })

  it('operator refuses a member or team the ledger does not hold', async () => {
    // Given ids the ledger never minted, When a run names them, Then it is refused before any host call.
    const instance = service()
    expect(await asyncCodeOf(() => instance.run({ teamId: 'ghost', memberId: 'ghost' }))).toBe('team-not-found')
    const team = instance.saveTeam({ name: 'Squad', workspaceId: 'ws-1' })
    expect(await asyncCodeOf(() => instance.run({ teamId: team.id, memberId: 'ghost' }))).toBe('member-not-found')
  })
})

describe('run: a launched session is never invisible', () => {
  it('user runs a member and gets the composed session with its run record', async () => {
    // Given a runnable member, When it runs, Then the session is composed from the pinned definition and one run record names it.
    const fake = gateway()
    const instance = service({ gateway: fake })
    const { teamId, memberId } = seedRunnable(instance)
    const run = await instance.run({ teamId, memberId, firstMessage: '开始' })

    expect(fake.createSession).toHaveBeenCalledWith({ workspaceId: 'ws-1', agentPreset: 'xundong' })
    expect(fake.renameSession).toHaveBeenCalledWith('session-1', 'Squad / 寻冬')
    expect(fake.applyPermission).toHaveBeenCalledWith('session-1', 'read-only')
    expect(fake.selectModel).toHaveBeenCalledWith('session-1', { model: 'deepseek-chat', provider: 'deepseek' }, 'high')
    expect(fake.prompt).toHaveBeenCalledWith({ sessionId: 'session-1', text: '开始' })
    expect(run).toMatchObject({ teamId, memberId, sessionId: 'session-1', status: 'running' })
    expect(run.failure).toBeUndefined()
    expect(instance.state.runs).toEqual([run])
  })

  it('user runs a member without a first message and the session carries none', async () => {
    // Given no first message, When the member runs, Then a session is recorded and nothing was queued into it.
    const fake = gateway()
    const instance = service({ gateway: fake })
    const { teamId, memberId } = seedRunnable(instance)
    const run = await instance.run({ teamId, memberId })
    expect(fake.prompt).not.toHaveBeenCalled()
    expect(run).toMatchObject({ sessionId: 'session-1', status: 'running' })
    expect(instance.state.runs).toHaveLength(1)
  })

  it('user runs a member that pins no preset on the deployment default', async () => {
    // Given a member with no preset and no pins, When it runs, Then only the workspace is composed and no preset is resolved.
    const fake = gateway()
    const instance = service({ gateway: fake })
    const team = instance.saveTeam({ name: 'Squad', workspaceId: 'ws-1' })
    const member = instance.saveMember(team.id, { name: 'M' }).members[0]
    await instance.run({ teamId: team.id, memberId: member.id })
    expect(fake.createSession).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
    expect(fake.listPresets).not.toHaveBeenCalled()
    expect(fake.applyPermission).not.toHaveBeenCalled()
    expect(fake.selectModel).not.toHaveBeenCalled()
  })

  it('operator records a failed run when the session cannot be renamed', async () => {
    // Given a rename the host refuses, When the member runs, Then the session is recorded as a failed run carrying the reason.
    const instance = service({ gateway: gateway({ renameSession: vi.fn(async () => { throw new Error('no title') }) }) })
    const { teamId, memberId } = seedRunnable(instance)
    expect(await asyncCodeOf(() => instance.run({ teamId, memberId }))).toBe('session-rename-failed')
    expect(instance.state.runs).toHaveLength(1)
    expect(instance.state.runs[0]).toMatchObject({ sessionId: 'session-1', status: 'failed' })
    expect(instance.state.runs[0].failure).toContain('no title')
  })

  it('operator records a failed run when a pinned route is refused', async () => {
    // Given a session that refuses the pinned model, When the member runs, Then the run is failed and names that session.
    const instance = service({ gateway: gateway({ selectModel: vi.fn(async () => { throw new Error('route refused') }) }) })
    const { teamId, memberId } = seedRunnable(instance)
    expect(await asyncCodeOf(() => instance.run({ teamId, memberId }))).toBe('session-pin-failed')
    expect(instance.state.runs[0]).toMatchObject({ sessionId: 'session-1', status: 'failed' })
  })

  it('operator records a failed run when the first message cannot be queued', async () => {
    // Given an inbox that refuses the message, When the member runs, Then the run is failed rather than silently empty.
    const instance = service({ gateway: gateway({ prompt: vi.fn(async () => { throw new Error('inbox full') }) }) })
    const { teamId, memberId } = seedRunnable(instance)
    expect(await asyncCodeOf(() => instance.run({ teamId, memberId, firstMessage: 'go' }))).toBe('session-prompt-failed')
    expect(instance.state.runs[0]).toMatchObject({ sessionId: 'session-1', status: 'failed' })
  })

  it('operator keeps the newest runs and evicts the oldest once the history is full', async () => {
    // Given a full history, When one more run lands, Then the count stays at the cap and the oldest record is gone.
    const dir = tempDir()
    const seeded: RunRecord[] = Array.from({ length: RUN_HISTORY_LIMIT }, (_, index) => {
      const id = RUN_HISTORY_LIMIT - 1 - index
      return {
        id: 'old-' + id,
        teamId: 'team-a',
        memberId: 'member-a',
        sessionId: 'session-old-' + id,
        createdAt: id,
        status: 'running',
      }
    })
    writeFileSync(join(dir, AGENTS_LEDGER_FILE), JSON.stringify({ schemaVersion: DSH_AGENTS_SCHEMA_VERSION, revision: 1, teams: [], runs: seeded }))
    const instance = service({ dir })
    const { teamId, memberId } = seedRunnable(instance)
    const run = await instance.run({ teamId, memberId })
    expect(instance.state.runs).toHaveLength(RUN_HISTORY_LIMIT)
    expect(instance.state.runs[0].id).toBe(run.id)
    expect(instance.state.runs.map(entry => entry.id)).not.toContain('old-0')
    expect(instance.state.runs.at(-1)?.id).toBe('old-1')
  })
})

describe('the preset list the state view reports', () => {
  it('user reads the presets this deployment serves and is not offered the unusable one', async () => {
    // Given a registry holding two presets, one reported unusable, When the panel reads state, Then only the composeable id is offered.
    const instance = service({ gateway: gateway({ listPresets: vi.fn(async () => [{ id: 'xundong' }, { id: 'michun', broken: 'its model route is gone' }]) }) })
    expect(await instance.stateView()).toMatchObject({ presets: ['xundong'] })
  })

  it('operator omits the field entirely when the deployment serves no preset registry', async () => {
    // Given no registry, When the panel reads state, Then the body carries no presets key, so the page states the squad's own pin instead of "none exist".
    const instance = service({ gateway: gateway({ listPresets: vi.fn(async () => undefined) }) })
    const state = await instance.stateView()
    expect(state.presets).toBeUndefined()
    expect('presets' in state).toBe(false)
    expect(state.host).toEqual({ ownerPid: process.pid })
  })

  it('operator offers nothing at all when every preset in the registry is unusable', async () => {
    // Given a registry whose only preset is broken, When the panel reads state, Then the field is absent rather than an empty list.
    const instance = service({ gateway: gateway({ listPresets: vi.fn(async () => [{ id: 'michun', broken: 'its model route is gone' }]) }) })
    expect('presets' in await instance.stateView()).toBe(false)
  })

  it('operator omits the field when the registry itself fails', async () => {
    // Given a registry read that throws, When the panel reads state, Then the body still answers and carries no presets key.
    const instance = service({ gateway: gateway({ listPresets: vi.fn(async () => { throw new Error('no agentPresets namespace here') }) }) })
    const state = await instance.stateView()
    expect('presets' in state).toBe(false)
  })

  it('operator refuses the state view when the ledger is unreadable, as every other read does', async () => {
    // Given a corrupt ledger, When the panel reads the served state, Then the named failure survives the async path and the registry is never consulted.
    const dir = tempDir()
    writeFileSync(join(dir, AGENTS_LEDGER_FILE), '{ teams: ')
    const fake = gateway()
    const instance = service({ dir, gateway: fake })
    expect(await asyncCodeOf(() => instance.stateView())).toBe('ledger-corrupt')
    expect(fake.listPresets).not.toHaveBeenCalled()
  })
})

describe('the model catalog the state view reports', () => {
  /** A reply shaped like the `session/modelCatalog` this Host serves. */
  const catalogReply = {
    groups: [{ id: 'deepseek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }] }],
  }

  it('user reads the routes and the levels this deployment serves', async () => {
    // Given a readable catalog, When the panel reads state, Then it receives one row per route and every declared level.
    const instance = service({ gateway: gateway({ modelCatalog: vi.fn(async () => catalogReply) }) })
    expect(await instance.stateView()).toMatchObject({
      models: [{ provider: 'deepseek', model: 'deepseek-v4', label: 'DeepSeek V4', efforts: ['low', 'high'] }],
      efforts: ['low', 'high'],
    })
  })

  it('operator omits both fields when the deployment serves no catalog', async () => {
    // Given a gateway with no catalog face, When the panel reads state, Then neither key is present, so no picker claims "no model exists".
    const state = await service().stateView()
    expect('models' in state).toBe(false)
    expect('efforts' in state).toBe(false)
  })

  it('operator omits both fields when the catalog holds nothing usable', async () => {
    // Given a catalog reply with no route in it, When the panel reads state, Then the fields are absent rather than empty lists.
    const instance = service({ gateway: gateway({ modelCatalog: vi.fn(async () => ({ groups: [] })) }) })
    const state = await instance.stateView()
    expect('models' in state).toBe(false)
    expect('efforts' in state).toBe(false)
  })

  it('operator omits both fields when the catalog read itself fails', async () => {
    // Given a catalog read that throws, When the panel reads state, Then the body still answers and carries neither key.
    const instance = service({ gateway: gateway({ modelCatalog: vi.fn(async () => { throw new Error('no session namespace here') }) }) })
    const state = await instance.stateView()
    expect(state.host).toEqual({ ownerPid: process.pid })
    expect('models' in state).toBe(false)
    expect('efforts' in state).toBe(false)
  })

  it('operator omits the level list when no offered model declares one', async () => {
    // Given a catalog whose only model declares no level, When the panel reads state, Then the routes are served and the level list is absent.
    const instance = service({ gateway: gateway({ modelCatalog: vi.fn(async () => ({ groups: [{ id: 'deepseek', models: [{ id: 'quiet', reasoning: { efforts: [] } }] }] })) }) })
    const state = await instance.stateView()
    expect(state.models).toEqual([{ provider: 'deepseek', model: 'quiet', efforts: [] }])
    expect('efforts' in state).toBe(false)
  })
})

describe('a ledger this host cannot read', () => {
  it('operator refuses every operation with the named failure and leaves the file alone', () => {
    // Given a corrupt ledger, When definitions are read or written, Then each call answers ledger-corrupt and the bytes are untouched.
    const dir = tempDir()
    const corrupt = '{ teams: '
    writeFileSync(join(dir, AGENTS_LEDGER_FILE), corrupt)
    const instance = service({ dir })
    expect(codeOf(() => instance.state)).toBe('ledger-corrupt')
    expect(codeOf(() => instance.saveTeam({ name: 'Squad' }))).toBe('ledger-corrupt')
    expect(codeOf(() => instance.saveMember('team-a', { name: 'M' }))).toBe('ledger-corrupt')
    expect(codeOf(() => instance.deleteTeam('team-a'))).toBe('ledger-corrupt')
    expect(instance.promptView()).toEqual({ teams: [], runs: [] })
    expect(readFileSync(join(dir, AGENTS_LEDGER_FILE), 'utf8')).toBe(corrupt)
  })

  it('operator names a foreign owner instead of taking the ledger over', () => {
    // Given a ledger another service instance owns, When a second service mounts, Then its reads refuse as already owned.
    const dir = tempDir()
    const owner = service({ dir })
    expect(owner.state.teams).toEqual([])
    const second = service({ dir })
    expect(codeOf(() => second.state)).toBe('ledger-owned')
  })
})

describe('workspaces and description drafts this Host can offer', () => {
  it('operator offers the workspaces the registry serves and omits the field when none can be listed', async () => {
    // Given a registry holding one titled workspace and a Host serving none, When the panel reads state, Then the picker rows carry id/title/path and the field is absent rather than empty.
    const titled = { list: (): readonly Workspace[] => [{ id: 'ws-1', title: 'repo', path: '/repo' } as unknown as Workspace] }
    expect(await service({ workspaces: titled }).stateView()).toMatchObject({ workspaces: [{ id: 'ws-1', title: 'repo', path: '/repo' }] })
    const without = service({ workspaces: undefined })
    expect('workspaces' in await without.stateView()).toBe(false)
    const throwing = { list: (): readonly Workspace[] => { throw new Error('no workspace registry here') } }
    expect('workspaces' in await service({ workspaces: throwing }).stateView()).toBe(false)
  })

  it('operator sees a registry that activates after construction on the next state read and the next run', async () => {
    // Given a Host whose registry appears only later, When the panel reads state and a pinned member then runs, Then both read the registry as it is now.
    const fake = gateway()
    let current: FakeRegistry | undefined
    let minted = 0
    const instance = new AgentsHostService({
      dir: tempDir(),
      gateway: fake,
      workspaces: () => current,
      now: () => NOW,
      idFactory: () => 'id-' + String(++minted),
    })
    services.push(instance)
    const team = instance.saveTeam({ name: 'Squad', workspaceId: 'ws-1' })
    const member = instance.saveMember(team.id, { name: 'M' }).members[0]

    // Before it activates there is no picker to offer and the pin cannot be validated.
    expect('workspaces' in await instance.stateView()).toBe(false)
    expect(await asyncCodeOf(() => instance.run({ teamId: team.id, memberId: member.id }))).toBe('workspace-unavailable')

    // Once it activates, the same instance serves the picker and launches the pinned session.
    current = { list: () => [{ id: 'ws-1', title: 'repo' } as unknown as Workspace] }
    expect(await instance.stateView()).toMatchObject({ workspaces: [{ id: 'ws-1', title: 'repo' }] })
    const run = await instance.run({ teamId: team.id, memberId: member.id })
    expect(fake.createSession).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
    expect(run).toMatchObject({ sessionId: 'session-1', status: 'running' })
  })

  it('operator drafts a description through the catalog route it offers', async () => {
    // Given a describer and a catalog with a default route, When the form asks for a description, Then the name and intent are handed over with that route and its text comes back.
    const seen: unknown[] = []
    const instance = new AgentsHostService({
      dir: tempDir(),
      gateway: gateway({ modelCatalog: vi.fn(async () => ({ groups: [{ id: 'deepseek', models: [{ id: 'chat' }] }], default: { provider: 'deepseek', model: 'chat' } })) }),
      describer: async (facts, route) => {
        seen.push({ facts, route })
        return 'Two reviewers and one builder.'
      },
      now: () => NOW,
    })
    services.push(instance)
    expect(await instance.describe({ name: 'Squad one', intent: 'architecture review' })).toBe('Two reviewers and one builder.')
    expect(seen).toEqual([{ facts: { name: 'Squad one', intent: 'architecture review' }, route: { provider: 'deepseek', model: 'chat' } }])
  })

  it('operator falls back to the first offered route when the catalog states no default', async () => {
    // Given a catalog without a default route, When a description is drafted, Then the first offered route is used instead of refusing.
    const seen: unknown[] = []
    const instance = new AgentsHostService({
      dir: tempDir(),
      gateway: gateway({ modelCatalog: vi.fn(async () => ({ groups: [{ id: 'deepseek', models: [{ id: 'chat' }, { id: 'reasoner' }] }] })) }),
      describer: async (_facts, route) => {
        seen.push(route)
        return 'text'
      },
      now: () => NOW,
    })
    services.push(instance)
    expect(await instance.describe({ name: 'Squad one' })).toBe('text')
    expect(seen).toEqual([{ provider: 'deepseek', model: 'chat' }])
  })

  it('operator refuses a description when this deployment serves no describer or no route', async () => {
    // Given a Host with no model service and one with no usable route, When a description is asked for, Then both answer describe-unavailable instead of an empty string.
    expect(await asyncCodeOf(() => service().describe({ name: 'Squad' }))).toBe('describe-unavailable')
    const noRoute = new AgentsHostService({ dir: tempDir(), gateway: gateway(), describer: async () => 'x', now: () => NOW })
    services.push(noRoute)
    expect(await asyncCodeOf(() => noRoute.describe({ name: 'Squad' }))).toBe('describe-unavailable')
  })

  it('operator reports a model failure as describe-failed carrying the model sentence', async () => {
    // Given a describer that throws, When a description is asked for, Then the refusal is describe-failed and the model sentence survives.
    const instance = new AgentsHostService({
      dir: tempDir(),
      gateway: gateway({ modelCatalog: vi.fn(async () => ({ groups: [{ id: 'deepseek', models: [{ id: 'chat' }] }] })) }),
      describer: async () => { throw new Error('the model did not answer within 90s') },
      now: () => NOW,
    })
    services.push(instance)
    let message = ''
    try {
      await instance.describe({ name: 'Squad' })
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(await asyncCodeOf(() => instance.describe({ name: 'Squad' }))).toBe('describe-failed')
    expect(message).toContain('did not answer within 90s')
  })
})
