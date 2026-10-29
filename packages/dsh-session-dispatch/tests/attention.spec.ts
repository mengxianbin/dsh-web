import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AttentionLedger,
  createAttentionDocument,
  defaultAttentionPath,
  deserializeAttention,
  type AttentionRegistry,
} from '../src/host/attention.ts'

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-attention-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  // Temp dirs live under the OS temp root; cleanup is best-effort bookkeeping,
  // the assertions above already ran.
  tempDirs.length = 0
})

/** In-memory registry double: workspace members, archive set, pin/unpin log. */
class FakeRegistry implements AttentionRegistry {
  readonly members: string[][] = []
  readonly archived: string[] = []
  readonly pinCalls: string[] = []
  readonly unpinCalls: string[] = []
  pinned: string[] = []
  failPin = false

  list(): readonly { readonly sessionIds: readonly string[] }[] {
    return this.members.map((sessionIds) => ({ sessionIds }))
  }

  get archivedSessionIds(): readonly string[] {
    return this.archived
  }

  async pinSession(sessionId: string): Promise<void> {
    this.pinCalls.push(sessionId)
    if (this.failPin) throw new Error('pin refused')
    if (!this.pinned.includes(sessionId)) this.pinned.unshift(sessionId)
  }

  async unpinSession(sessionId: string): Promise<void> {
    this.unpinCalls.push(sessionId)
    this.pinned = this.pinned.filter((id) => id !== sessionId)
  }
}

function ledgerFor(registry: FakeRegistry, path: string): AttentionLedger {
  return new AttentionLedger({ registry, attentionPath: path, now: () => '2026-10-29T00:00:00.000Z' })
}

async function readSessions(path: string): Promise<Record<string, { class: string; defaultApplied: boolean; source: string }>> {
  const doc = JSON.parse(await readFile(path, 'utf8')) as { sessions: Record<string, { class: string; defaultApplied: boolean; source: string }> }
  return doc.sessions
}

describe('deserializeAttention', () => {
  it('keeps well-formed rows and drops malformed ones', () => {
    const doc = deserializeAttention(JSON.stringify({
      version: 1,
      sessions: {
        'session-ok': { class: 'bot', defaultApplied: true, source: 'dispatch', updatedAt: 'now' },
        'session-bad-class': { class: 'machine', defaultApplied: true, source: 'dispatch', updatedAt: 'now' },
        'session-bad-applied': { class: 'human', defaultApplied: 'yes', source: 'startup', updatedAt: 'now' },
        'session-bad-source': { class: 'human', defaultApplied: false, source: 'elsewhere', updatedAt: 'now' },
        'session-not-object': 7,
        '': { class: 'human', defaultApplied: true, source: 'startup', updatedAt: 'now' },
      },
    }))
    expect(doc?.version).toBe(1)
    expect(Object.keys(doc?.sessions ?? {}).sort()).toEqual(['session-bad-source', 'session-ok'])
    // A foreign source falls back to startup rather than dropping the row.
    expect(doc?.sessions['session-bad-source']?.source).toBe('startup')
  })

  it('answers undefined for corrupt or foreign documents', () => {
    expect(deserializeAttention('{not json')).toBeUndefined()
    expect(deserializeAttention('[]')).toBeUndefined()
    expect(deserializeAttention(JSON.stringify({ version: 2, sessions: {} }))).toBeUndefined()
    expect(deserializeAttention(JSON.stringify({ version: 1, sessions: [] }))).toBeUndefined()
  })
})

describe('defaultAttentionPath', () => {
  it('spells the ledger under the DSH home', () => {
    expect(defaultAttentionPath('C:\\home\\.dsh')).toContain('session-attention.json')
  })
})

describe('AttentionLedger.startupPass', () => {
  it('classifies every current member as human and pins it once', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    const registry = new FakeRegistry()
    registry.members.push(['session-a', 'session-b'])
    registry.archived.push('session-archived')

    await ledgerFor(registry, path).startupPass()

    expect(registry.pinCalls.sort()).toEqual(['session-a', 'session-b'])
    expect(registry.pinned.sort()).toEqual(['session-a', 'session-b'])
    expect(registry.unpinCalls).toEqual([])
    const sessions = await readSessions(path)
    expect(sessions['session-a']).toEqual({ class: 'human', defaultApplied: true, source: 'startup', updatedAt: '2026-10-29T00:00:00.000Z' })
    expect(sessions['session-archived']).toBeUndefined()
  })

  it('never re-applies a default after a manual pin change, across restarts', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    const registry = new FakeRegistry()
    registry.members.push(['session-a'])
    const first = ledgerFor(registry, path)
    await first.startupPass()
    expect(registry.pinned).toEqual(['session-a'])

    // The user unpins by hand; a "restart" (fresh ledger instance) must not pin it back.
    await registry.unpinSession('session-a')
    await ledgerFor(registry, path).startupPass()
    expect(registry.pinned).toEqual([])

    // The same guarantee in the other direction: a manual pin survives too.
    await registry.pinSession('session-b')
    registry.members[0] = ['session-a', 'session-b']
    await ledgerFor(registry, path).startupPass()
    expect(registry.pinned).toEqual(['session-b'])
  })

  it('retries a record whose default never landed, under its recorded class', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    const registry = new FakeRegistry()
    registry.members.push(['session-bot'])
    await writeFile(path, JSON.stringify({
      version: 1,
      sessions: { 'session-bot': { class: 'bot', defaultApplied: false, source: 'dispatch', updatedAt: 'earlier' } },
    }), 'utf8')

    await ledgerFor(registry, path).startupPass()

    expect(registry.unpinCalls).toEqual(['session-bot'])
    expect((await readSessions(path))['session-bot']?.defaultApplied).toBe(true)
  })

  it('keeps a failed pin pending instead of recording it as applied', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    const registry = new FakeRegistry()
    registry.members.push(['session-a'])
    registry.failPin = true

    await ledgerFor(registry, path).startupPass()
    expect((await readSessions(path))['session-a']?.defaultApplied).toBe(false)

    // The registry recovers; the next pass lands the default.
    registry.failPin = false
    await ledgerFor(registry, path).startupPass()
    expect((await readSessions(path))['session-a']?.defaultApplied).toBe(true)
    expect(registry.pinned).toEqual(['session-a'])
  })

  it('quarantines a corrupt ledger and rebuilds from the live registry', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    await writeFile(path, '{corrupt', 'utf8')
    const registry = new FakeRegistry()
    registry.members.push(['session-a'])

    await ledgerFor(registry, path).startupPass()

    const files = await readdir(dir)
    expect(files.some((name) => name.startsWith('session-attention.json.corrupt-'))).toBe(true)
    expect((await readSessions(path))['session-a']?.class).toBe('human')
  })

  it('uses the id spelling the workspace lists when pinning', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    const registry = new FakeRegistry()
    registry.members.push(['bare-uuid'])

    await ledgerFor(registry, path).startupPass()

    expect(registry.pinCalls).toEqual(['bare-uuid'])
    // The record key is canonical, so either spelling resolves to one row.
    expect((await readSessions(path))['session-bare-uuid']?.defaultApplied).toBe(true)
  })
})

describe('AttentionLedger.declare', () => {
  it('records a human declaration and pins the session at creation', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    const registry = new FakeRegistry()
    registry.members.push(['session-x'])

    await ledgerFor(registry, path).declare('session-x', 'human')

    expect(registry.pinCalls).toEqual(['session-x'])
    expect((await readSessions(path))['session-x']).toEqual({ class: 'human', defaultApplied: true, source: 'dispatch', updatedAt: '2026-10-29T00:00:00.000Z' })
  })

  it('records a bot declaration without pinning, and startup leaves it unpinned', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    const registry = new FakeRegistry()
    registry.members.push(['session-x'])

    await ledgerFor(registry, path).declare('session-x', 'bot')
    expect(registry.pinCalls).toEqual([])
    expect(registry.unpinCalls).toEqual(['session-x'])

    await ledgerFor(registry, path).startupPass()
    expect(registry.pinCalls).toEqual([])
    expect((await readSessions(path))['session-x']?.class).toBe('bot')
  })

  it('rejects when the ledger itself cannot be written (route reports attentionRecorded:false)', async () => {
    const dir = await tempDir()
    // Point the ledger at a path whose parent is a file: the atomic write fails.
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a dir', 'utf8')
    const registry = new FakeRegistry()
    registry.members.push(['session-x'])

    await expect(ledgerFor(registry, join(blocker, 'session-attention.json')).declare('session-x', 'bot')).rejects.toThrow()
  })
})

describe('AttentionLedger.ensureFirstMessage', () => {
  it('gives an undeclared workspace member the human default', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    const registry = new FakeRegistry()
    registry.members.push(['session-ui'])

    await ledgerFor(registry, path).ensureFirstMessage('session-ui')

    expect(registry.pinCalls).toEqual(['session-ui'])
    expect((await readSessions(path))['session-ui']?.source).toBe('first-message')
  })

  it('never records or pins a non-member (subagent children, side threads, forks)', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    const registry = new FakeRegistry()
    registry.members.push(['session-member'])

    await ledgerFor(registry, path).ensureFirstMessage('session-child')

    expect(registry.pinCalls).toEqual([])
    // No record, no write: the ledger file never comes into existence.
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('leaves an already-applied record alone even while the pin set changed', async () => {
    const dir = await tempDir()
    const path = join(dir, 'session-attention.json')
    const registry = new FakeRegistry()
    registry.members.push(['session-a'])
    const ledger = ledgerFor(registry, path)
    await ledger.startupPass()
    await registry.unpinSession('session-a')

    await ledger.ensureFirstMessage('session-a')

    expect(registry.pinned).toEqual([])
    expect(registry.pinCalls).toEqual(['session-a']) // only the startup pass's own call
  })
})

describe('ledger document helpers', () => {
  it('creates an empty document', () => {
    expect(createAttentionDocument()).toEqual({ version: 1, sessions: {} })
  })
})
