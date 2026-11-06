// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mayArchive, readIdentityTable, resolveActorClass } from '../src/host/identity.ts'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-identity-'))
}

describe('mayArchive (triclass decision table)', () => {
  it('lets a human archive anything', () => {
    expect(mayArchive('human', 'human')).toBe(true)
    expect(mayArchive('human', 'bot-boss')).toBe(true)
    expect(mayArchive('human', 'bot-worker')).toBe(true)
  })

  it('lets a boss archive workers and successor-archive bosses, never a human session', () => {
    expect(mayArchive('bot-boss', 'bot-worker')).toBe(true)
    expect(mayArchive('bot-boss', 'bot-boss')).toBe(true)
    expect(mayArchive('bot-boss', 'human')).toBe(false)
  })

  it('lets a worker archive nothing', () => {
    expect(mayArchive('bot-worker', 'bot-worker')).toBe(false)
    expect(mayArchive('bot-worker', 'bot-boss')).toBe(false)
    expect(mayArchive('bot-worker', 'human')).toBe(false)
  })

  it('denies an unclassified actor', () => {
    expect(mayArchive(undefined, 'human')).toBe(false)
    expect(mayArchive(undefined, 'bot-worker')).toBe(false)
  })
})

describe('resolveActorClass', () => {
  const table = new Map([
    ['session-boss', 'bot-boss' as const],
    ['session-worker', 'bot-worker' as const],
    ['session-human', 'human' as const],
  ])

  it('resolves a session id against the table', () => {
    expect(resolveActorClass('session-boss', table)).toBe('bot-boss')
    expect(resolveActorClass('session-worker', table)).toBe('bot-worker')
    expect(resolveActorClass('session-human', table)).toBe('human')
  })

  it('canonicalizes a bare uuid actor to the session- spelling', () => {
    const bare = '550e8400-e29b-41d4-a716-446655440000'
    expect(resolveActorClass(bare, new Map([[`session-${bare}`, 'bot-boss' as const]]))).toBe('bot-boss')
  })

  it('denies an unrecorded session actor instead of guessing human', () => {
    expect(resolveActorClass('session-unknown', table)).toBeUndefined()
  })

  it('denies a missing or blank actor', () => {
    expect(resolveActorClass(undefined, table)).toBeUndefined()
    expect(resolveActorClass('', table)).toBeUndefined()
    expect(resolveActorClass('   ', table)).toBeUndefined()
  })

  it('treats a non-session channel name as a human declaration', () => {
    expect(resolveActorClass('manual', table)).toBe('human')
    expect(resolveActorClass('human:skill', table)).toBe('human')
  })
})

describe('readIdentityTable', () => {
  it('reads classes, normalizes the legacy bot row, and drops unknown classes', async () => {
    const home = tempHome()
    try {
      writeFileSync(join(home, 'session-attention.json'), JSON.stringify({
        version: 1,
        sessions: {
          'session-h': { class: 'human', defaultApplied: true, source: 'startup', updatedAt: 't' },
          'session-b': { class: 'bot-boss', defaultApplied: true, source: 'dispatch', updatedAt: 't' },
          'session-w': { class: 'bot-worker', defaultApplied: true, source: 'dispatch', updatedAt: 't' },
          'session-legacy': { class: 'bot', defaultApplied: true, source: 'dispatch', updatedAt: 't' },
          'session-junk': { class: 'machine', defaultApplied: true, source: 'dispatch', updatedAt: 't' },
        },
      }), 'utf8')

      const table = await readIdentityTable(home)
      expect(table.get('session-h')).toBe('human')
      expect(table.get('session-b')).toBe('bot-boss')
      expect(table.get('session-w')).toBe('bot-worker')
      expect(table.get('session-legacy')).toBe('bot-worker')
      expect(table.has('session-junk')).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('answers an empty table for an absent or corrupt ledger (automation denied by the rules)', async () => {
    const home = tempHome()
    try {
      expect((await readIdentityTable(home)).size).toBe(0)
      writeFileSync(join(home, 'session-attention.json'), '{not json', 'utf8')
      expect((await readIdentityTable(home)).size).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
