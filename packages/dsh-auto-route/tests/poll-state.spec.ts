/**
 * Poll-state ledger (2026-11-04 ruling: sustained meter-poll failure feeds
 * the 安康盾). Facts-only publication: one atomic write per tick, removal on
 * disable/unload, and — the load-bearing property — a failed write never
 * throws back into the poll loop (the reader degrades to an absent plane).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLL_STATE_FILE, removePollState, writePollState, type PollStateSnapshot } from '../src/poll-state.ts'

const OK: PollStateSnapshot = { at: 1_700_000_000_000, ok: true }
const FAILING: PollStateSnapshot = {
  at: 1_700_000_045_000,
  ok: false,
  error: 'meter source unreachable: fetch failed (cause: connect ECONNREFUSED)',
  failingSince: 1_700_000_000_000,
}

describe('poll-state ledger — one write per tick, best-effort throughout', () => {
  let home: string
  let path: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'auto-route-poll-'))
    path = join(home, POLL_STATE_FILE)
    vi.stubEnv('DSH_HOME', home)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('writes a tick verdict the reader can parse (streak facts included)', () => {
    writePollState(FAILING)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(FAILING)
    // Atomic replace leaves no temp file behind.
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('overwrites every tick (freshness = writer liveness)', () => {
    writePollState(FAILING)
    writePollState(OK)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(OK)
  })

  it('swallows write failures instead of throwing into the poll loop', () => {
    // Point DSH_HOME at a path that cannot be a directory → writeFileSync fails.
    vi.stubEnv('DSH_HOME', join(home, 'missing', 'nested'))
    expect(() => writePollState(OK)).not.toThrow()
  })

  it('removes the ledger (disable/unload) and ignores absence', () => {
    writePollState(OK)
    removePollState()
    expect(existsSync(path)).toBe(false)
    expect(() => removePollState()).not.toThrow() // force + catch: absence is normal
  })
})
