import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  aliveSessionIdsFromWorkspaceStore,
  canonicalSessionId,
  createBindingsDocument,
  defaultStorePaths,
  deserializeBindings,
  FileBindingStore,
  writeJsonAtomic,
} from '../src/host/bindings.ts'

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-bindings-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  // Temp dirs live under the OS temp root; cleanup is best-effort bookkeeping,
  // the assertions above already ran.
  tempDirs.length = 0
})

/** A minimal workspace store: one workspace row plus the global archive set. */
function workspaceStore(sessionIds: string[], archivedSessionIds: string[] = []): string {
  return JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds },
    tables: { workspaces: { 'ws-1': { path: 'D:\\x', title: 'x', sessionIds, createdAt: '', updatedAt: '' } } },
  })
}

/** Write the workspace store, creating its `storages/` directory like the Host does. */
async function writeWorkspaceStore(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

describe('deserializeBindings', () => {
  it('keeps well-formed bindings and drops malformed entries', () => {
    const doc = deserializeBindings(JSON.stringify({
      version: 1,
      bindings: [
        { taskRef: 'a#1', sessionId: 'session-1', workspaceId: 'ws-1', createdAt: '2026-10-19T00:00:00.000Z' },
        { taskRef: 'a#2', sessionId: 'session-2', workspaceId: 'ws-1', title: 42, createdAt: '2026-10-19T00:00:00.000Z' },
        { taskRef: '', sessionId: 'session-3', workspaceId: 'ws-1', createdAt: '2026-10-19T00:00:00.000Z' },
        { taskRef: 'a#4', sessionId: 'session-4', workspaceId: 'ws-1' },
      ],
    }))
    expect(doc?.bindings).toHaveLength(1)
    expect(doc?.bindings[0]?.taskRef).toBe('a#1')
  })

  it('answers undefined for corrupt or foreign documents', () => {
    expect(deserializeBindings('{not json')).toBeUndefined()
    expect(deserializeBindings('[]')).toBeUndefined()
    expect(deserializeBindings(JSON.stringify({ version: 2, bindings: [] }))).toBeUndefined()
  })
})

describe('canonicalSessionId', () => {
  it('normalizes bare uuids to the session- spelling', () => {
    expect(canonicalSessionId('abc')).toBe('session-abc')
    expect(canonicalSessionId('session-abc')).toBe('session-abc')
  })
})

describe('aliveSessionIdsFromWorkspaceStore', () => {
  it('subtracts the archive set from the workspace session ids', () => {
    const alive = aliveSessionIdsFromWorkspaceStore(JSON.parse(workspaceStore(
      ['session-a', 'session-b'],
      ['b'], // bare-uuid spelling must still match
    )))
    expect([...alive]).toEqual(['session-a'])
  })

  it('answers an empty set for unreadable shapes', () => {
    expect(aliveSessionIdsFromWorkspaceStore(null).size).toBe(0)
    expect(aliveSessionIdsFromWorkspaceStore({ garbage: true }).size).toBe(0)
  })
})

describe('FileBindingStore', () => {
  it('persists a recorded binding to disk and finds it alive', async () => {
    const dir = await tempDir()
    const paths = defaultStorePaths(dir)
    const store = new FileBindingStore(paths)
    await writeWorkspaceStore(paths.workspaceStorePath, workspaceStore(['session-1']))
    await store.record({ taskRef: 'board.md#item-1', sessionId: 'session-1', workspaceId: 'ws-1', title: 'T', createdAt: '2026-10-19T00:00:00.000Z' })
    const onDisk = JSON.parse(await readFile(paths.bindingsPath, 'utf8'))
    expect(onDisk).toMatchObject({
      version: 1,
      bindings: [{ taskRef: 'board.md#item-1', sessionId: 'session-1', workspaceId: 'ws-1', title: 'T', createdAt: '2026-10-19T00:00:00.000Z' }],
    })
    const found = await store.findAlive('board.md#item-1')
    expect(found?.sessionId).toBe('session-1')
  })

  it('treats an archived binding as dead: findAlive answers undefined and list reports alive=false', async () => {
    const dir = await tempDir()
    const paths = defaultStorePaths(dir)
    const store = new FileBindingStore(paths)
    await writeWorkspaceStore(paths.workspaceStorePath, workspaceStore(['session-1'], ['session-1']))
    await store.record({ taskRef: 'board.md#item-1', sessionId: 'session-1', workspaceId: 'ws-1', createdAt: '2026-10-19T00:00:00.000Z' })
    expect(await store.findAlive('board.md#item-1')).toBeUndefined()
    expect(await store.list()).toEqual([
      { taskRef: 'board.md#item-1', sessionId: 'session-1', workspaceId: 'ws-1', createdAt: '2026-10-19T00:00:00.000Z', alive: false },
    ])
  })

  it('returns the newest live binding when a taskRef was re-dispatched', async () => {
    const dir = await tempDir()
    const paths = defaultStorePaths(dir)
    const store = new FileBindingStore(paths)
    await writeWorkspaceStore(paths.workspaceStorePath, workspaceStore(['session-old', 'session-new']))
    await store.record({ taskRef: 'a#1', sessionId: 'session-old', workspaceId: 'ws-1', createdAt: '2026-10-19T00:00:00.000Z' })
    await store.record({ taskRef: 'a#1', sessionId: 'session-new', workspaceId: 'ws-1', createdAt: '2026-10-19T01:00:00.000Z' })
    expect((await store.findAlive('a#1'))?.sessionId).toBe('session-new')
  })

  it('fails open on an unreadable workspace store: no 409 gate, alive=false in list', async () => {
    const dir = await tempDir()
    const store = new FileBindingStore(defaultStorePaths(dir))
    await store.record({ taskRef: 'a#1', sessionId: 'session-1', workspaceId: 'ws-1', createdAt: '2026-10-19T00:00:00.000Z' })
    expect(await store.findAlive('a#1')).toBeUndefined()
    expect((await store.list())[0]?.alive).toBe(false)
  })

  it('quarantines a corrupt ledger with a trace and rebuilds empty', async () => {
    const dir = await tempDir()
    const paths = defaultStorePaths(dir)
    const store = new FileBindingStore(paths)
    await writeWorkspaceStore(paths.workspaceStorePath, workspaceStore(['session-1']))
    await writeFile(paths.bindingsPath, '{corrupt', 'utf8')
    expect(await store.findAlive('a#1')).toBeUndefined()
    const files = await readdir(dir)
    const quarantined = files.filter((name) => name.startsWith('dispatch-bindings.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(dir, quarantined[0]!), 'utf8')).toBe('{corrupt')
  })

  it('answers an empty ledger for a fresh machine (no files at all)', async () => {
    const dir = await tempDir()
    const store = new FileBindingStore(defaultStorePaths(dir))
    expect(await store.list()).toEqual([])
    expect(await store.findAlive('any')).toBeUndefined()
  })

  it('keeps every row when appends race: concurrent record calls serialize in-process', async () => {
    const dir = await tempDir()
    const paths = defaultStorePaths(dir)
    const store = new FileBindingStore(paths)
    await Promise.all(['session-1', 'session-2', 'session-3'].map((sessionId, index) =>
      store.record({ taskRef: `board.md#item-${index + 1}`, sessionId, workspaceId: 'ws-1', createdAt: '2026-10-24T00:00:00.000Z' }),
    ))
    const onDisk = JSON.parse(await readFile(paths.bindingsPath, 'utf8'))
    expect(onDisk.bindings).toHaveLength(3)
    expect(onDisk.bindings.map((binding: { sessionId: string }) => binding.sessionId)).toEqual(['session-1', 'session-2', 'session-3'])
  })
})

describe('writeJsonAtomic', () => {
  it('leaves no temp files behind on success', async () => {
    const dir = await tempDir()
    const path = join(dir, 'nested', 'doc.json')
    await writeJsonAtomic(path, createBindingsDocument())
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, bindings: [] })
    const files = await readdir(join(dir, 'nested'))
    expect(files).toEqual(['doc.json'])
  })
})
