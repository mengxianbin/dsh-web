// @vitest-environment node
/**
 * Targeted session-state location for `sealCheck` (seal-targeted-read-1106):
 * resolving only the named ids must equal the full sessions-root index
 * restricted to those ids — same keying, same containment checks, first
 * project dir wins — while never paying for the full `indexSessionDirs`
 * walk (no `dirSize` recursion, no cache scan). The judgement itself is the
 * four-tuple since lamp-wiring-1126 (archive-verdict.spec pins its
 * semantics); this file pins how existence is found, that a miss still
 * answers the fail-closed `UNKNOWN`, and that the full index cache is never
 * paid for on the way.
 * @module tests/seal-targeted-read.spec
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveService } from '../src/host/janitor.ts'
import { indexSessionDirs, resolveSessionDirs } from '../src/host/session-files.ts'
import { createFakeHost, fakeContext, fixtureSources } from './fixtures.ts'

/**
 * A sessions root exercising every shape the full index distinguishes: two
 * project dirs, bare and `session-`-prefixed segment names, a duplicate id
 * across projects, a stray file wearing a session name, and a symlink that
 * escapes the root (indexed by neither).
 */
function shapedRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-seal-targeted-'))
  const root = join(home, 'sessions')
  const projectA = join(root, '--A--')
  const projectB = join(root, '--B--')
  mkdirSync(projectA, { recursive: true })
  mkdirSync(projectB, { recursive: true })
  mkdirSync(join(projectA, 'aaa-1'), { recursive: true })
  mkdirSync(join(projectA, 'session-bbb-2'), { recursive: true })
  mkdirSync(join(projectB, 'ccc-3'), { recursive: true })
  // Duplicate id: same segment under a second project — first project wins.
  mkdirSync(join(projectB, 'aaa-1'), { recursive: true })
  // A file, not a directory, wearing a session name: indexed by neither.
  writeFileSync(join(projectA, 'session-notadir'), 'x')
  // A symlink out of the root: recorded unreadable by the full index,
  // skipped by the targeted probe — both leave it unresolvable.
  const outside = mkdtempSync(join(tmpdir(), 'dsh-seal-targeted-outside-'))
  symlinkSync(outside, join(projectA, 'session-escaped'))
  return root
}

describe('resolveSessionDirs — targeted lookup equals the full index restricted to the ids', () => {
  it('operator resolves ids exactly as indexSessionDirs does, and no others', async () => {
    // Given a sessions root the full index walks end to end
    const root = shapedRoot()
    const full = await indexSessionDirs(root)
    expect([...full.byId.keys()].sort()).toEqual(['session-aaa-1', 'session-bbb-2', 'session-ccc-3'])

    // When the same ids (plus a miss) are resolved without the full walk
    const ids = [...full.byId.keys(), 'session-ghost-0000']
    const targeted = resolveSessionDirs(root, ids)

    // Then every located dir matches the full index, and the miss stays a miss
    for (const id of full.byId.keys()) {
      expect(targeted.get(id), id).toBe(full.byId.get(id))
    }
    expect(targeted.get('session-ghost-0000')).toBeUndefined()
    expect(targeted.size).toBe(full.byId.size)
  })

  it('operator resolves nothing when the sessions root is absent', () => {
    // Given a home with no sessions root at all
    const home = mkdtempSync(join(tmpdir(), 'dsh-seal-targeted-'))
    // When an id is resolved against the absent root
    const targeted = resolveSessionDirs(join(home, 'sessions'), ['session-aaa-1'])
    // Then nothing resolves — the caller answers UNKNOWN for every id
    expect(targeted.size).toBe(0)
  })
})

describe('ArchiveService.sealCheck — targeted read behind the four-tuple grouping', () => {
  it('operator gets the four-tuple verdicts without ever triggering the full directory scan', async () => {
    // Given a service over a fixture home with one live session and one miss
    const host = createFakeHost({ feedItems: [{ sessionId: 'session-green', updatedAt: 1 }] })
    const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home, verdictSources: fixtureSources() })

    // When a seal-check runs on a fresh service
    const results = await service.sealCheck(['session-green', 'session-ghost'])

    // Then it located the id by probe — the full index cache was never paid
    // for — and the miss still answers UNKNOWN (fail-closed unchanged)
    const dirIndex = (service as unknown as { dirIndex: { scans: number } }).dirIndex
    expect(dirIndex.scans).toBe(0)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual(expect.objectContaining({ id: 'session-green', verdict: 'DONE', detail: '4t-pass' }))
    expect(results[0].readings.contract.state).toBe('pass')
    expect(results[1]).toEqual(expect.objectContaining({ id: 'session-ghost', verdict: 'UNKNOWN', detail: 'session-not-found' }))

    // And the counter is live: the next full-index consumer still scans once
    const full = await indexSessionDirs(join(host.home, 'sessions'))
    expect(full.byId.has('session-green')).toBe(false) // feed-only session: no dir on disk
  })
})
