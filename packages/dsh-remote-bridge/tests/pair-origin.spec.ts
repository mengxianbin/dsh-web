import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELAY_DOMAIN, RELAY_REGISTRY_DIR, discoverPairOrigin } from '../src/host/pair-origin.ts'

/** Homes created by one case, removed when it ends. */
const homes: string[] = []

/** A throwaway DSH home, optionally carrying one relay registry row. */
function homeWith(profile: string, row: unknown | 'unreadable'): string {
  const home = mkdtempSync(join(tmpdir(), 'pair-origin-'))
  homes.push(home)
  const dir = join(home, RELAY_REGISTRY_DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${profile}.json`), row === 'unreadable' ? '{ not json' : JSON.stringify(row))
  return home
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true })
})

describe('pairing origin discovery', () => {
  it('operator sets the environment contract and that origin is the one discovered', () => {
    // Given the variable dsh-remote-web-ui also reads, with a trailing slash
    const env = { DSH_REMOTE_PUBLIC_BASE_URL: 'wss://typed.example.com/', DSH_PROFILE: 'desktop' }
    // When the origin is discovered
    const facts = discoverPairOrigin({ env })
    // Then it wins over everything else and is normalised to a bare origin
    expect(facts).toEqual({ origin: 'wss://typed.example.com', source: 'env' })
  })

  it('operator pairs from a machine whose only address is its registered relay subdomain', () => {
    // Given a registry row written by dsh-remote-web-ui for this profile
    const home = homeWith('desktop', { id: 'abc123def456', secret: 'irrelevant' })
    // When the origin is discovered
    const facts = discoverPairOrigin({ env: { DSH_PROFILE: 'desktop' }, home })
    // Then it is the stable relay origin for that subdomain
    expect(facts).toEqual({ origin: `wss://abc123def456.${RELAY_DOMAIN}`, source: 'registry' })
  })

  it('operator pairs a profile with no registry row and no origin is invented', () => {
    // Given a home whose registry holds a different profile
    const home = homeWith('rescue', { id: 'abc123def456' })
    // When the desktop profile asks
    const facts = discoverPairOrigin({ env: { DSH_PROFILE: 'desktop' }, home })
    // Then nothing is invented
    expect(facts).toBeUndefined()
  })

  it('operator has an unreadable or id-less registry row and no origin is invented', () => {
    // Given one row that is not JSON and one that carries no id
    const broken = homeWith('broken', 'unreadable')
    const idless = homeWith('idless', { secret: 'only-a-secret' })
    // When each is discovered
    const first = discoverPairOrigin({ env: { DSH_PROFILE: 'broken' }, home: broken })
    const second = discoverPairOrigin({ env: { DSH_PROFILE: 'idless' }, home: idless })
    // Then both report no origin rather than throwing or half-naming one
    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
  })

  it('operator leaves the profile unset and the desktop registry row is the one read', () => {
    // Given a home with the desktop row and no DSH_PROFILE in the environment
    const home = homeWith('desktop', { id: 'abc123def456' })
    // When the origin is discovered
    const facts = discoverPairOrigin({ env: {}, home })
    // Then the desktop row is the one read
    expect(facts?.source).toBe('registry')
    expect(facts?.origin).toBe(`wss://abc123def456.${RELAY_DOMAIN}`)
  })
})
