import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileLockStore, LOCK_STORE_VERSION } from '../src/lock-store.ts'
import type { ManualLockEntry } from '../src/manual-lock.ts'

const LOCK: ManualLockEntry = { sessionId: 'session-a', value: 'mimo/mimo-v2.6-flash', lockedAt: 1_700_000_000_000 }

describe('FileLockStore — durable manual locks (2026-11-01 ruling A 锁持久化)', () => {
  let dir: string
  let path: string
  let warnings: string[]
  const store = (): FileLockStore => new FileLockStore(path, { warn: message => { warnings.push(message) } })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-route-lock-'))
    path = join(dir, 'auto-route-locks.json')
    warnings = []
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('round-trips locks through the file', () => {
    store().save([LOCK, { sessionId: 'session-b', value: 'deepseek-official/x', lockedAt: 2 }])
    expect(store().load()).toEqual([LOCK, { sessionId: 'session-b', value: 'deepseek-official/x', lockedAt: 2 }])
    expect(warnings).toEqual([])
    // Versioned document, so a future format can refuse rather than misread.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: LOCK_STORE_VERSION })
  })

  it('loads nothing (cold start) when the file does not exist', () => {
    expect(store().load()).toBeUndefined()
    expect(warnings).toEqual([]) // a missing file is the normal first run, not a warning
  })

  it('overwrites the whole set on save (unlocks persist as removals)', () => {
    const file = store()
    file.save([LOCK, { sessionId: 'session-b', value: 'x/y', lockedAt: 1 }])
    file.save([]) // both realigned
    expect(file.load()).toEqual([])
  })

  it('fails open on a corrupt file: warns and starts cold instead of refusing to mount', () => {
    writeFileSync(path, '{not json', 'utf8')
    expect(store().load()).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('lock store unreadable')
    expect(warnings[0]).toContain(path)
  })

  it('drops malformed entries with a warning rather than trusting the shape', () => {
    writeFileSync(path, JSON.stringify({
      version: LOCK_STORE_VERSION,
      locks: [LOCK, { sessionId: '', value: 42, lockedAt: 'nope' }, null],
    }), 'utf8')
    expect(store().load()).toEqual([LOCK])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('dropped 2 malformed')
  })

  it('refuses an unknown document version instead of misreading it', () => {
    writeFileSync(path, JSON.stringify({ version: LOCK_STORE_VERSION + 1, locks: [LOCK] }), 'utf8')
    expect(store().load()).toBeUndefined()
    expect(warnings[0]).toContain('unsupported version')
  })

  it('save warns but never throws when the write fails (locks stay in-memory authoritative)', () => {
    // Point the store at an unwritable path: a directory where the file should be.
    const blocked = join(dir, 'as-directory')
    writeFileSync(blocked, '', 'utf8') // a FILE where mkdir wants to create a dir
    const failing = new FileLockStore(join(blocked, 'nested', 'locks.json'), { warn: m => { warnings.push(m) } })
    expect(() => failing.save([LOCK])).not.toThrow()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('lock store write failed')
  })

  it('leaves no temp file behind after a successful save', () => {
    store().save([LOCK])
    const names = readdirSync(dir)
    expect(names).toEqual(['auto-route-locks.json']) // atomic rename: no .locktmp residue
  })
})
