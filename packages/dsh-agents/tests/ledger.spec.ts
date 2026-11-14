/**
 * Owns the ledger guarantees: atomic writes, the single-owner lock, and the
 * fail-closed rule that never destroys a user's definitions.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentsError } from '../src/core/errors.ts'
import { AGENTS_LEDGER_FILE, AGENTS_LEDGER_LOCK_FILE, AgentsLedger } from '../src/host/ledger.ts'
import { DSH_AGENTS_SCHEMA_VERSION, type RunRecord } from '../src/protocol.ts'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-agents-ledger-'))
  roots.push(dir)
  return dir
}

function ledgerFile(dir: string): string {
  return join(dir, AGENTS_LEDGER_FILE)
}

function run(id: string, createdAt: number): RunRecord {
  return { id, teamId: 'team-a', memberId: 'member-a', sessionId: 'session-' + id, createdAt, status: 'running' }
}

function codeOf(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    if (error instanceof AgentsError) return error.code
    throw error
  }
  throw new Error('the ledger did not refuse')
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('opening the ledger', () => {
  it('operator gets one document on a first mount and no temporary file left behind', () => {
    // Given an empty plugin directory, When the ledger opens, Then one document and one lock exist and the lock goes on dispose.
    const dir = tempDir()
    const ledger = AgentsLedger.open({ dir })
    expect(readdirSync(dir).sort()).toEqual([AGENTS_LEDGER_FILE, AGENTS_LEDGER_LOCK_FILE])
    expect(ledger.snapshot()).toEqual({ teams: [], runs: [] })
    const document = JSON.parse(readFileSync(ledgerFile(dir), 'utf8')) as { schemaVersion: number; revision: number }
    expect(document).toMatchObject({ schemaVersion: DSH_AGENTS_SCHEMA_VERSION, revision: 0 })
    ledger.dispose()
    expect(readdirSync(dir)).toEqual([AGENTS_LEDGER_FILE])
  })

  it('operator refuses a second writer while the first still owns the directory', () => {
    // Given an open ledger, When a second mount opens the same directory, Then it is refused as already owned.
    const dir = tempDir()
    const ledger = AgentsLedger.open({ dir })
    expect(codeOf(() => AgentsLedger.open({ dir }))).toBe('ledger-owned')
    ledger.dispose()
  })

  it('operator is told which pid owns the ledger, so the other host can be found', () => {
    // Given an open ledger, When a second mount is refused, Then the message names the owning pid.
    const dir = tempDir()
    const ledger = AgentsLedger.open({ dir })
    try {
      AgentsLedger.open({ dir })
      throw new Error('the second mount was admitted')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentsError)
      expect((error as AgentsError).message).toContain(String(process.pid))
    } finally {
      ledger.dispose()
    }
  })

  it('operator reclaims a lock whose recorded owner is gone', () => {
    // Given a lock left by a dead pid, When the ledger opens, Then the leftover is reclaimed by this process.
    const dir = tempDir()
    writeFileSync(join(dir, AGENTS_LEDGER_LOCK_FILE), JSON.stringify({ pid: 999_999, token: 'gone' }))
    const ledger = AgentsLedger.open({ dir })
    expect(ledger.ownerPid).toBe(process.pid)
    ledger.dispose()
  })

  it('operator refuses an unreadable lock instead of taking the directory over', () => {
    // Given a lock file that is not a lock record, When the ledger opens, Then it refuses rather than guessing.
    const dir = tempDir()
    writeFileSync(join(dir, AGENTS_LEDGER_LOCK_FILE), 'not a lock')
    expect(codeOf(() => AgentsLedger.open({ dir }))).toBe('ledger-owned')
  })
})

describe('fail-closed reading', () => {
  it('operator keeps a corrupt document byte-identical and never resets it', () => {
    // Given a corrupt ledger, When the Host mounts and retries, Then both attempts refuse and the bytes and mtime are unchanged.
    const dir = tempDir()
    const corrupt = '{ this is not json'
    writeFileSync(ledgerFile(dir), corrupt)
    const before = statSync(ledgerFile(dir)).mtimeMs
    expect(codeOf(() => AgentsLedger.open({ dir }))).toBe('ledger-corrupt')
    expect(readFileSync(ledgerFile(dir), 'utf8')).toBe(corrupt)
    expect(statSync(ledgerFile(dir)).mtimeMs).toBe(before)
    expect(readdirSync(dir)).toEqual([AGENTS_LEDGER_FILE])
    expect(codeOf(() => AgentsLedger.open({ dir }))).toBe('ledger-corrupt')
    expect(readFileSync(ledgerFile(dir), 'utf8')).toBe(corrupt)
  })

  it('operator refuses a document with one malformed row rather than dropping that row', () => {
    // Given a document whose member row lacks its fields, When the ledger loads, Then the whole read refuses and the file is kept.
    const dir = tempDir()
    const document = {
      schemaVersion: DSH_AGENTS_SCHEMA_VERSION,
      revision: 4,
      teams: [{ id: 'team-a', name: 'Squad', createdAt: 1, updatedAt: 1, members: [{ id: 'member-a', teamId: 'team-a' }] }],
      runs: [],
    }
    writeFileSync(ledgerFile(dir), JSON.stringify(document))
    expect(codeOf(() => AgentsLedger.open({ dir }))).toBe('ledger-corrupt')
    expect(JSON.parse(readFileSync(ledgerFile(dir), 'utf8'))).toEqual(document)
  })

  it('operator refuses a document written by another schema generation', () => {
    // Given a ledger from another generation, When this build opens it, Then it refuses instead of migrating silently.
    const dir = tempDir()
    writeFileSync(ledgerFile(dir), JSON.stringify({ schemaVersion: 99, revision: 0, teams: [], runs: [] }))
    expect(codeOf(() => AgentsLedger.open({ dir }))).toBe('ledger-corrupt')
  })

  it('operator refuses an empty document instead of treating it as a fresh ledger', () => {
    // Given a truncated file, When the ledger opens, Then it refuses rather than starting empty.
    const dir = tempDir()
    writeFileSync(ledgerFile(dir), '   ')
    expect(codeOf(() => AgentsLedger.open({ dir }))).toBe('ledger-corrupt')
  })
})

describe('committing', () => {
  it('operator lands one revision per write on disk', () => {
    // Given a fresh ledger, When one change commits, Then the revision moves by one and the file carries it.
    const dir = tempDir()
    const ledger = AgentsLedger.open({ dir })
    expect(ledger.revision).toBe(0)
    ledger.mutate(document => { document.runs = [run('a', 1)] })
    expect(ledger.revision).toBe(1)
    const onDisk = JSON.parse(readFileSync(ledgerFile(dir), 'utf8')) as { revision: number; runs: RunRecord[] }
    expect(onDisk.revision).toBe(1)
    expect(onDisk.runs).toHaveLength(1)
    ledger.dispose()
  })

  it('operator rolls memory and disk back together when a change throws', () => {
    // Given a committed run, When a change throws mid-way, Then neither the document nor the file moved.
    const dir = tempDir()
    const ledger = AgentsLedger.open({ dir })
    ledger.mutate(document => { document.runs = [run('a', 1)] })
    const before = readFileSync(ledgerFile(dir), 'utf8')
    expect(() => ledger.mutate((document) => {
      document.runs = []
      throw new Error('the caller changed its mind')
    })).toThrow('the caller changed its mind')
    expect(ledger.revision).toBe(1)
    expect(ledger.snapshot().runs).toHaveLength(1)
    expect(readFileSync(ledgerFile(dir), 'utf8')).toBe(before)
    ledger.dispose()
  })

  it('operator is told when a write could not land instead of being shown success', () => {
    // Given a blocked temporary path, When a change commits, Then it fails as a write failure and the revision does not move.
    const dir = tempDir()
    const ledger = AgentsLedger.open({ dir })
    const blocked = join(dir, AGENTS_LEDGER_FILE + '.tmp-' + process.pid)
    mkdirSync(blocked)
    try {
      expect(codeOf(() => ledger.mutate(document => { document.runs = [run('a', 1)] }))).toBe('ledger-write-failed')
      expect(ledger.revision).toBe(0)
      expect(ledger.snapshot().runs).toEqual([])
    } finally {
      rmSync(blocked, { recursive: true, force: true })
      ledger.dispose()
    }
  })

  it('user receives a copy of the document, so rewriting it cannot change the ledger', () => {
    // Given a committed run, When a caller rewrites its snapshot, Then the stored run is unchanged.
    const dir = tempDir()
    const ledger = AgentsLedger.open({ dir })
    ledger.mutate(document => { document.runs = [run('a', 1)] })
    const snapshot = ledger.snapshot()
    snapshot.runs[0].status = 'failed'
    expect(ledger.snapshot().runs[0].status).toBe('running')
    ledger.dispose()
  })
})
