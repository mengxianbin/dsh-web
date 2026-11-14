/**
 * The squad tool surface: every tool drives the real Host service, so these
 * suites run the real ledger in a temporary directory behind a gateway double
 * and assert the same refusals, the same merge rules and the same destructive
 * gate the browser's routes enforce.
 *
 * A refusal is a value here, not an exception: the tool names a stable code the
 * model can correct from, and the ledger bytes stay untouched.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENTS_TOOL_NAMES, buildAgentsTools } from '../src/host/agent-tools.ts'
import { AGENTS_LEDGER_FILE } from '../src/host/ledger.ts'
import type { MemberRunGateway } from '../src/host/run-gateway.ts'
import { AgentsHostService } from '../src/host/service.ts'
import type { MemberDefinition, RunRecord, TeamDefinition } from '../src/protocol.ts'

const NOW = 1_700_000_000_000
const services: AgentsHostService[] = []
const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-tools-'))
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

interface Harness {
  host: AgentsHostService
  tools: ToolDefinition[]
}

interface HarnessOptions {
  gateway?: MemberRunGateway
  workspaces?: FakeRegistry | undefined
  dir?: string
}

function harness(options: HarnessOptions = {}): Harness {
  const dir = options.dir ?? tempDir()
  let counter = 0
  const picked = 'workspaces' in options ? options.workspaces : workspaces
  const host = new AgentsHostService({
    dir,
    gateway: options.gateway ?? gateway(),
    ...(picked === undefined ? {} : { workspaces: () => picked }),
    now: () => NOW + counter++,
    idFactory: () => 'id-' + String(++counter),
  })
  services.push(host)
  return { host, tools: buildAgentsTools(host) }
}

/** Run one tool by name; defineTool validates the arguments first. */
async function call(live: Harness, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = live.tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error('unknown tool ' + name)
  return await tool.execute(args, {} as never) as Record<string, unknown>
}

/** The ledger document exactly as it sits on disk. */
function storedLedger(live: Harness): { teams: TeamDefinition[]; runs: RunRecord[] } {
  return JSON.parse(readFileSync(live.host.ledgerFile, 'utf8')) as { teams: TeamDefinition[]; runs: RunRecord[] }
}

/** The ledger's raw bytes, for the "nothing was written" assertions. */
function ledgerBytes(live: Harness): string {
  return readFileSync(live.host.ledgerFile, 'utf8')
}

/** A squad whose one member can run: workspace pinned, preset served. */
async function seedRunnable(live: Harness): Promise<{ squadId: string; memberId: string }> {
  const created = await call(live, 'squads_create', {
    name: 'Squad',
    workspaceId: 'ws-1',
    members: [{ name: 'Reviewer', preset: 'xundong', permission: 'read-only', model: 'deepseek/deepseek-chat', reasoningEffort: 'high', brief: 'reads the diff' }],
  })
  const squad = created.squad as TeamDefinition
  return { squadId: squad.id, memberId: squad.members[0].id }
}

afterEach(() => {
  for (const host of services.splice(0)) host.dispose()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the declared surface', () => {
  it('operator gets exactly the ten declared squad tools, each with a description and a renderer', () => {
    // Given a live Host service, When the surface is built, Then it is the declared list in order.
    const live = harness()
    const names = live.tools.map(tool => tool.name)
    expect(names).toEqual([...AGENTS_TOOL_NAMES])
    expect(names).toHaveLength(10)
    expect(new Set(names).size).toBe(names.length)
    expect(live.tools.every(tool => tool.description.length > 0)).toBe(true)
    expect(live.tools.every(tool => typeof tool.output.render === 'function')).toBe(true)
  })
})

describe('argument gates', () => {
  it('user naming no squad is refused as invalid before the ledger is read or written', async () => {
    // Given an empty ledger, When every tool that needs an id is called with none
    const live = harness()
    const before = ledgerBytes(live)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['squads_read', {}],
      ['squads_update', {}],
      ['squads_delete', { confirm: true }],
      ['squad_member_add', { name: 'M' }],
      ['squad_member_update', {}],
      ['squad_member_remove', { confirm: true }],
      ['squads_run_member', {}],
      ['squads_run_squad', {}],
    ]

    // Then each answers the same invalid-request value and no byte moved
    for (const [name, args] of calls) {
      const refused = await call(live, name, args)
      expect({ name, ok: refused.ok, code: refused.code }).toEqual({ name, ok: false, code: 'invalid-request' })
    }
    expect(ledgerBytes(live)).toBe(before)
  })

  it('user creating a squad with a blank name is refused and nothing is written', async () => {
    // Given an empty ledger, When the name is empty or only whitespace, Then the write is refused.
    const live = harness()
    const before = ledgerBytes(live)
    for (const name of ['', '   ', '\t']) {
      const refused = await call(live, 'squads_create', { name })
      expect(refused).toMatchObject({ ok: false, code: 'invalid-request' })
    }
    expect(ledgerBytes(live)).toBe(before)
    expect(live.host.state.teams).toEqual([])
  })

  it('user creating a squad whose member pins an unusable permission is refused before the squad exists', async () => {
    // Given an empty ledger, When one member carries a permission that is not a sandbox mode
    const live = harness()
    const before = ledgerBytes(live)
    const refused = await call(live, 'squads_create', { name: 'Squad', members: [{ name: 'M', permission: 'root' }] })

    // Then the whole request is refused and no half-built squad is left behind
    expect(refused).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(ledgerBytes(live)).toBe(before)
    expect(live.host.state.teams).toEqual([])
  })

  it('user adding a member with an unusable permission is refused and nothing is written', async () => {
    // Given a squad, When a member pins a permission the ledger does not know
    const live = harness()
    const created = await call(live, 'squads_create', { name: 'Squad' })
    const squadId = (created.squad as TeamDefinition).id
    const before = ledgerBytes(live)

    // Then the refusal is a value and the squad keeps the roster it had
    expect(await call(live, 'squad_member_add', { squadId, name: 'M', permission: 'root' })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(ledgerBytes(live)).toBe(before)
    expect(storedLedger(live).teams[0].members).toEqual([])
  })

  it('user renaming a squad or a member to an empty name is refused and the stored name survives', async () => {
    // Given a named squad with a named member, When either update carries a blank name
    const live = harness()
    const { squadId, memberId } = await seedRunnable(live)
    const before = ledgerBytes(live)

    // Then both are refused and the ledger keeps the names it had
    expect(await call(live, 'squads_update', { squadId, name: '  ' })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(await call(live, 'squad_member_update', { squadId, memberId, name: '' })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(ledgerBytes(live)).toBe(before)
    expect(storedLedger(live).teams[0].name).toBe('Squad')
    expect(storedLedger(live).teams[0].members[0].name).toBe('Reviewer')
  })

  it('user updating a member with a permission the ledger does not hold is refused', async () => {
    // Given a member, When its update names a permission outside the three modes
    const live = harness()
    const { squadId, memberId } = await seedRunnable(live)
    const before = ledgerBytes(live)

    // Then the permission pin survives untouched
    expect(await call(live, 'squad_member_update', { squadId, memberId, permission: 'root' })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(ledgerBytes(live)).toBe(before)
    expect(storedLedger(live).teams[0].members[0].permission).toBe('read-only')
  })
})

describe('destructive operations', () => {
  it('operator deleting or removing without an explicit confirmation changes no byte on disk', async () => {
    // Given a squad with one member, When the destructive calls omit or falsify confirm
    const live = harness()
    const { squadId, memberId } = await seedRunnable(live)
    const before = ledgerBytes(live)

    // Then every unconfirmed call is refused as invalid before the ledger is touched
    for (const args of [{ squadId }, { squadId, confirm: false }]) {
      expect(await call(live, 'squads_delete', args)).toMatchObject({ ok: false, code: 'invalid-request' })
    }
    for (const args of [{ squadId, memberId }, { squadId, memberId, confirm: false }]) {
      expect(await call(live, 'squad_member_remove', args)).toMatchObject({ ok: false, code: 'invalid-request' })
    }

    expect(ledgerBytes(live)).toBe(before)
    expect(storedLedger(live).teams).toHaveLength(1)
    expect(storedLedger(live).teams[0].members).toHaveLength(1)
  })

  it('user confirming a deletion gets the deleted name back', async () => {
    // Given a squad with two members, When one member and then the squad are confirmed for deletion
    const live = harness()
    const { squadId, memberId } = await seedRunnable(live)
    const added = await call(live, 'squad_member_add', { squadId, name: 'Builder' })
    expect(added.member).toMatchObject({ name: 'Builder' })

    // Then each reply names what it deleted and the ledger agrees
    expect(await call(live, 'squad_member_remove', { squadId, memberId, confirm: true }))
      .toMatchObject({ ok: true, deleted: { id: memberId, name: 'Reviewer', squadId } })
    expect(await call(live, 'squads_delete', { squadId, confirm: true }))
      .toMatchObject({ ok: true, deleted: { id: squadId, name: 'Squad' } })
    expect(storedLedger(live).teams).toEqual([])
  })
})

describe('domain refusals carry a stable code', () => {
  it('operator reading or editing a squad the ledger never held is refused as team-not-found', async () => {
    // Given an empty ledger, When a tool names a squad id the ledger never minted
    const live = harness()

    // Then every path answers the same code
    expect(await call(live, 'squads_read', { squadId: 'ghost' })).toMatchObject({ ok: false, code: 'team-not-found' })
    expect(await call(live, 'squads_update', { squadId: 'ghost', name: 'Renamed' })).toMatchObject({ ok: false, code: 'team-not-found' })
    expect(await call(live, 'squads_delete', { squadId: 'ghost', confirm: true })).toMatchObject({ ok: false, code: 'team-not-found' })
    expect(await call(live, 'squad_member_add', { squadId: 'ghost', name: 'M' })).toMatchObject({ ok: false, code: 'team-not-found' })
    expect(await call(live, 'squads_run_member', { squadId: 'ghost', memberId: 'ghost' })).toMatchObject({ ok: false, code: 'team-not-found' })
    expect(await call(live, 'squads_run_squad', { squadId: 'ghost' })).toMatchObject({ ok: false, code: 'team-not-found' })
  })

  it('operator editing a member another squad holds is refused as member-not-found', async () => {
    // Given a member of squad A, When the edit addresses it through squad B
    const live = harness()
    const { memberId } = await seedRunnable(live)
    const other = await call(live, 'squads_create', { name: 'Other' })
    const otherId = (other.squad as TeamDefinition).id

    // Then the member is not reachable from the other squad, and the first squad keeps it
    expect(await call(live, 'squad_member_update', { squadId: otherId, memberId, name: 'Moved' }))
      .toMatchObject({ ok: false, code: 'member-not-found' })
    expect(await call(live, 'squad_member_remove', { squadId: otherId, memberId, confirm: true }))
      .toMatchObject({ ok: false, code: 'member-not-found' })
    expect(live.host.state.teams[0].members[0].name).toBe('Reviewer')
  })

  it('operator running a member whose preset the host registry does not hold is refused as preset-unknown', async () => {
    // Given a registry that holds another preset, When the member runs
    const live = harness({ gateway: gateway({ listPresets: vi.fn(async () => [{ id: 'other' }]) }) })
    const { squadId, memberId } = await seedRunnable(live)

    // Then the run fails closed before a session exists
    expect(await call(live, 'squads_run_member', { squadId, memberId })).toMatchObject({ ok: false, code: 'preset-unknown' })
    expect(live.host.state.runs).toEqual([])
  })

  it('operator running a member whose preset the host reports unusable is refused as preset-unavailable', async () => {
    // Given a preset the registry marks broken, When the member runs
    const live = harness({ gateway: gateway({ listPresets: vi.fn(async () => [{ id: 'xundong', broken: 'its model route is gone' }]) }) })
    const { squadId, memberId } = await seedRunnable(live)

    // Then the refusal carries the host's own reason
    const refused = await call(live, 'squads_run_member', { squadId, memberId })
    expect(refused.code).toBe('preset-unavailable')
    expect(String(refused.message)).toContain('its model route is gone')
  })

  it('operator running a squad that pins no workspace launches its Lead on the host default directory', async () => {
    // Given a squad without a workspace, When its Lead run is asked for
    const requested: unknown[] = []
    const fake = gateway({ createSession: vi.fn(async (input) => { requested.push(input); return { sessionId: 'session-1' } }) })
    const live = harness({ gateway: fake })
    const created = await call(live, 'squads_create', { name: 'Squad' })
    const squadId = (created.squad as TeamDefinition).id

    // Then a real session is created with no workspaceId and the squad run is recorded
    const launched = await call(live, 'squads_run_squad', { squadId, goal: 'ship it' })
    expect(launched.ok).toBe(true)
    expect(fake.createSession).toHaveBeenCalledTimes(1)
    expect(requested).toEqual([{}])
    expect(requested.map(input => Object.keys(input as Record<string, unknown>))).toEqual([[]])
    expect(live.host.state.runs.map(run => ({ kind: run.kind, teamId: run.teamId, status: run.status })))
      .toEqual([{ kind: 'squad', teamId: squadId, status: 'running' }])
  })

  it('operator running on a deployment that serves no workspace registry is refused as workspace-unavailable', async () => {
    // Given no workspace registry at all, When a pinned squad runs
    const live = harness({ workspaces: undefined })
    const { squadId, memberId } = await seedRunnable(live)

    // Then the pin cannot be validated and the run fails closed
    expect(await call(live, 'squads_run_member', { squadId, memberId })).toMatchObject({ ok: false, code: 'workspace-unavailable' })
    expect(await call(live, 'squads_run_squad', { squadId })).toMatchObject({ ok: false, code: 'workspace-unavailable' })
  })

  it('operator running a squad whose pinned workspace the registry does not serve is refused as workspace-unknown', async () => {
    // Given a workspace id the host registry does not list, When the member runs
    const live = harness()
    const created = await call(live, 'squads_create', { name: 'Squad', workspaceId: 'ws-gone', members: [{ name: 'M' }] })
    const squad = created.squad as TeamDefinition

    // Then the run is refused before any session exists
    expect(await call(live, 'squads_run_member', { squadId: squad.id, memberId: squad.members[0].id }))
      .toMatchObject({ ok: false, code: 'workspace-unknown' })
    expect(live.host.state.runs).toEqual([])
  })

  it('operator whose ledger cannot be read is refused as ledger-corrupt and the file stays as it was found', async () => {
    // Given a ledger file this build cannot parse, When the surface is used
    const dir = tempDir()
    const corrupt = '{ this is not the dsh-agents ledger'
    writeFileSync(join(dir, AGENTS_LEDGER_FILE), corrupt)
    const live = harness({ dir })
    const before = readFileSync(join(dir, AGENTS_LEDGER_FILE), 'utf8')

    // Then every path answers the same code and no byte is overwritten
    expect(await call(live, 'squads_list')).toMatchObject({ ok: false, code: 'ledger-corrupt' })
    expect(await call(live, 'squads_read', { squadId: 'id-1' })).toMatchObject({ ok: false, code: 'ledger-corrupt' })
    expect(await call(live, 'squads_create', { name: 'Squad' })).toMatchObject({ ok: false, code: 'ledger-corrupt' })
    expect(await call(live, 'squads_run_squad', { squadId: 'id-1' })).toMatchObject({ ok: false, code: 'ledger-corrupt' })
    expect(readFileSync(join(dir, AGENTS_LEDGER_FILE), 'utf8')).toBe(before)
  })
})

describe('partial merge', () => {
  it('user renaming a squad keeps its description, workspace and roster', async () => {
    // Given a squad with a description, a workspace and one member, When only the name changes
    const live = harness()
    const created = await call(live, 'squads_create', { name: 'Squad', description: 'keeps this', workspaceId: 'ws-1', members: [{ name: 'M' }] })
    const squad = created.squad as TeamDefinition

    const updated = await call(live, 'squads_update', { squadId: squad.id, name: 'Renamed' })

    // Then the untouched fields are the ones the squad already had
    expect(updated.squad).toMatchObject({ id: squad.id, name: 'Renamed', description: 'keeps this', workspaceId: 'ws-1', createdAt: squad.createdAt })
    expect((updated.squad as TeamDefinition).members).toHaveLength(1)
  })

  it('user clearing one squad field with an empty string drops only that field', async () => {
    // Given a squad with a description and a lead preset, When the description is cleared
    const live = harness()
    const created = await call(live, 'squads_create', { name: 'Squad', description: 'gone soon', workspaceId: 'ws-1', leadPreset: 'xundong' })
    const squadId = (created.squad as TeamDefinition).id

    const updated = await call(live, 'squads_update', { squadId, description: '' })

    // Then the cleared field is absent and the other pin survives
    expect((updated.squad as TeamDefinition).description).toBeUndefined()
    expect((updated.squad as TeamDefinition).workspaceId).toBe('ws-1')
    expect((updated.squad as TeamDefinition).leadPreset).toBe('xundong')
  })

  it('user clearing one member pin leaves the other pins and the brief untouched', async () => {
    // Given a member with every pin set, When only the permission is cleared
    const live = harness()
    const { squadId, memberId } = await seedRunnable(live)
    const updated = await call(live, 'squad_member_update', { squadId, memberId, permission: '' })

    // Then the permission is gone and every other field is what it was
    expect((updated.member as Record<string, unknown>).permission).toBeUndefined()
    const stored = storedLedger(live).teams[0].members[0]
    expect(stored).toMatchObject({ preset: 'xundong', model: 'deepseek/deepseek-chat', reasoningEffort: 'high', brief: 'reads the diff' })
    expect(stored.permission).toBeUndefined()
  })
})

describe('runs', () => {
  it('user running one member gets the run record of the session the host opened', async () => {
    // Given a runnable member, When it is launched with a first message
    const fake = gateway()
    const live = harness({ gateway: fake })
    const { squadId, memberId } = await seedRunnable(live)
    const run = await call(live, 'squads_run_member', { squadId, memberId, firstMessage: 'start' })

    // Then the record names that session and the message reached the inbox
    expect(run.ok).toBe(true)
    expect(run.run).toMatchObject({ teamId: squadId, memberId, sessionId: 'session-1', status: 'running' })
    expect(fake.prompt).toHaveBeenCalledWith({ sessionId: 'session-1', text: 'start' })
    expect(live.host.state.runs).toHaveLength(1)
  })

  it('user running a whole squad hands the goal to the squad context and never to a first message', async () => {
    // Given a runnable squad, When the whole squad is launched with a goal
    const fake = gateway()
    const live = harness({ gateway: fake })
    const { squadId } = await seedRunnable(live)
    const run = await call(live, 'squads_run_squad', { squadId, goal: 'ship the review' })

    // Then the record carries the goal as a squad run and the session was never prompted
    const record = run.run as RunRecord
    expect(run.ok).toBe(true)
    expect(record).toMatchObject({ teamId: squadId, kind: 'squad', goal: 'ship the review', sessionId: 'session-1', status: 'running' })
    expect(record.memberId).toBeUndefined()
    expect(fake.prompt).not.toHaveBeenCalled()
  })

  it('user launching a member without a first message creates an unprompted session', async () => {
    // Given a runnable member, When it is launched with no message
    const fake = gateway()
    const live = harness({ gateway: fake })
    const { squadId, memberId } = await seedRunnable(live)

    const run = await call(live, 'squads_run_member', { squadId, memberId })

    // Then the session exists and nothing was queued into it
    expect(run.ok).toBe(true)
    expect(fake.prompt).not.toHaveBeenCalled()
  })
})

describe('one squad through its whole life', () => {
  it('user creates, extends, renames, prunes and deletes a squad while the ledger follows every step', async () => {
    // Given an empty ledger
    const live = harness()

    // When the squad is created with its first member
    const created = await call(live, 'squads_create', {
      name: 'Review squad',
      description: 'checks the diff',
      workspaceId: 'ws-1',
      members: [{ name: 'Reviewer', permission: 'read-only', brief: 'reads the diff' }],
    })
    const squad = created.squad as TeamDefinition

    // Then it is the only squad, with the roster the call named
    expect(created.ok).toBe(true)
    expect(storedLedger(live).teams).toHaveLength(1)
    expect(squad.members.map(member => member.name)).toEqual(['Reviewer'])

    // And a second member can be added by name
    const added = await call(live, 'squad_member_add', { squadId: squad.id, name: 'Builder', preset: 'xundong', model: 'deepseek/deepseek-chat', reasoningEffort: 'high', brief: 'builds it' })
    const builder = added.member as MemberDefinition
    expect(added.ok).toBe(true)
    expect((added.squad as TeamDefinition).members.map(member => member.name)).toEqual(['Reviewer', 'Builder'])

    // And a read reports the full definition, briefs included
    const read = await call(live, 'squads_read', { squadId: squad.id })
    expect((read.squad as TeamDefinition).members.map(member => member.brief)).toEqual(['reads the diff', 'builds it'])
    expect(storedLedger(live).teams[0].members).toHaveLength(2)

    // When the squad is renamed, Then only the name moved
    const renamed = await call(live, 'squads_update', { squadId: squad.id, name: 'Renamed squad' })
    expect(renamed.squad).toMatchObject({ id: squad.id, name: 'Renamed squad', description: 'checks the diff', workspaceId: 'ws-1' })
    expect(storedLedger(live).teams[0].name).toBe('Renamed squad')

    // When the added member is removed, Then the squad keeps the first one
    const removed = await call(live, 'squad_member_remove', { squadId: squad.id, memberId: builder.id, confirm: true })
    expect(removed.deleted).toEqual({ id: builder.id, name: 'Builder', squadId: squad.id })
    const listed = await call(live, 'squads_list')
    expect(listed.squads).toMatchObject([{ id: squad.id, name: 'Renamed squad', memberCount: 1 }])
    expect(storedLedger(live).teams[0].members.map(member => member.name)).toEqual(['Reviewer'])

    // When the squad is deleted, Then nothing is left to read or to store
    const deleted = await call(live, 'squads_delete', { squadId: squad.id, confirm: true })
    expect(deleted.deleted).toEqual({ id: squad.id, name: 'Renamed squad' })
    expect(await call(live, 'squads_read', { squadId: squad.id })).toMatchObject({ ok: false, code: 'team-not-found' })
    expect((await call(live, 'squads_list')).squads).toEqual([])
    expect(storedLedger(live).teams).toEqual([])
  })
})
