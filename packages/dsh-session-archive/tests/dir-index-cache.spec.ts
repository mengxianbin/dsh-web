// @vitest-environment node
/**
 * The sessions-root directory index cache: reuse inside its window, a fresh
 * scan once the window lapses, and explicit invalidation after the owner
 * removes session storage. The walk is the dominant cost of an inventory
 * pass, and one user action triggers several passes.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirIndexCache } from '../src/host/dir-index-cache.ts'
import { indexSessionDirs } from '../src/host/session-files.ts'
import { buildInventory } from '../src/host/inventory.ts'
import { createFakeHost } from './fixtures.ts'

/** A sessions root with one project dir holding the named session dirs. */
function makeRoot(ids: readonly string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dir-index-cache-'))
  const project = join(home, 'sessions', '--demo--')
  mkdirSync(project, { recursive: true })
  for (const id of ids) {
    const dir = join(project, id.startsWith('session-') ? id.slice('session-'.length) : id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.alloc(32, 3))
  }
  return join(home, 'sessions')
}

describe('Given a sessions root whose directory walk is expensive', () => {
  it('operator pays for one scan across the passes of a single action', async () => {
    // Given a root with a session directory
    const root = makeRoot(['abc'])
    let clock = 1_000
    const cache = new DirIndexCache({ ttlMs: 2_000, scan: () => indexSessionDirs(root), now: () => clock })

    // When several passes read the index inside the window
    const first = await cache.get()
    clock += 500
    const second = await cache.get()
    clock += 1_000
    const third = await cache.get()

    // Then one real scan served them all, and the shared index is the scan's
    expect(cache.scans).toBe(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect([...first.byId.keys()]).toEqual(['session-abc'])
    expect(first.sizes.get('session-abc')).toBe(32)
  })

  it('operator gets a fresh walk once the window has lapsed', async () => {
    // Given a cache whose window has expired
    const root = makeRoot(['abc'])
    let clock = 1_000
    const cache = new DirIndexCache({ ttlMs: 2_000, scan: () => indexSessionDirs(root), now: () => clock })
    const stale = await cache.get()

    // When a pass reads it after the window
    clock += 2_000
    const refreshed = await cache.get()

    // Then the tree was walked again, producing a distinct index object
    expect(cache.scans).toBe(2)
    expect(refreshed).not.toBe(stale)
    expect([...refreshed.byId.keys()]).toEqual(['session-abc'])
  })

  it('operator sees the storage it deleted disappear from the next pass', async () => {
    // Given a cached scan that includes one session directory
    const root = makeRoot(['abc', 'gone'])
    const cache = new DirIndexCache({ ttlMs: 60_000, scan: () => indexSessionDirs(root), now: () => 1_000 })
    expect([...(await cache.get()).byId.keys()].sort()).toEqual(['session-abc', 'session-gone'])

    // When the owner removes that storage and invalidates
    rmSync(join(root, '--demo--', 'gone'), { recursive: true, force: true })
    cache.invalidate()
    const after = await cache.get()

    // Then the removed session is gone while the surviving one stays indexed
    expect(cache.scans).toBe(2)
    expect([...after.byId.keys()]).toEqual(['session-abc'])
  })

  it('operator still sees a genuinely expired window rescanned, never an unbounded stale index', async () => {
    // Given a cache whose clock never advances
    const root = makeRoot(['abc'])
    let clock = 5_000
    const cache = new DirIndexCache({ ttlMs: 2_000, scan: () => indexSessionDirs(root), now: () => clock })

    // When a new directory appears and the window lapses
    await cache.get()
    mkdirSync(join(root, '--demo--', 'later'), { recursive: true })
    clock += 2_001
    const refreshed = await cache.get()

    // Then the newly added session is discovered
    expect([...refreshed.byId.keys()].sort()).toEqual(['session-abc', 'session-later'])
  })

  it('operator requests during an in-flight scan join it instead of starting competing walks', async () => {
    // Given a slow scan that has started
    const root = makeRoot(['abc'])
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let scans = 0
    const cache = new DirIndexCache({
      ttlMs: 2_000,
      scan: async () => {
        scans += 1
        await gate
        return indexSessionDirs(root)
      },
      now: () => 1_000,
    })

    // When several readers arrive while it is still running
    const first = cache.get()
    const second = cache.get()
    const third = cache.get()
    release?.()
    const results = await Promise.all([first, second, third])

    // Then all three share one walk (single flight), not three
    expect(scans).toBe(1)
    expect(results[1]).toBe(results[0])
    expect(results[2]).toBe(results[0])
    expect(cache.scans).toBe(1)
  })
})

describe('Given an inventory pass', () => {
  it('operator gets identical rows whether the walk is done here or supplied', async () => {
    // Given a fake host with a session directory and its projcache facts
    const host = createFakeHost({ dirs: ['session-abc'] })

    // When the pass walks the tree itself and when it is handed that same index
    const own = await buildInventory(host.sources(), AbortSignal.timeout(5000))
    const supplied = await buildInventory(
      { ...host.sources(), dirIndex: await indexSessionDirs(join(host.home, 'sessions')) },
      AbortSignal.timeout(5000),
    )

    // Then the resulting document is the same
    expect(supplied.rows).toEqual(own.rows)
    expect(supplied.workspaces).toEqual(own.workspaces)
    expect(supplied.archivedSessionIds).toEqual(own.archivedSessionIds)
  })
})
