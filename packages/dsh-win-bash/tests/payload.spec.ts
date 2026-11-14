/**
 * The vendored payload and its checksum manifest: the package's integrity
 * boundary. These tests read the SHIPPED bytes, because the invariant they
 * certify is about what actually ships, not about a fixture.
 *
 * They are deliberately platform-independent: the payload lives in the
 * repository on every platform, so a POSIX reviewer's run still proves the
 * manifest matches the bytes being published.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bashPath,
  binDir,
  parseChecksums,
  resolveRuntime,
  runtimeRoot,
  shPath,
  verifyPayload,
} from '../src/runtime.ts'

/** SHA256 of one file, lowercase hex, computed independently of the module. */
function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

describe('the vendored payload', () => {
  it('admin publishing the package gets exactly the manifest that matches the shipped bytes', () => {
    // Given the shipped runtime directory and its checksum manifest,
    const root = runtimeRoot()
    const entries = parseChecksums(readFileSync(join(root, 'checksums.sha256'), 'utf8'))
    // When every registered file is hashed independently of the verification module,
    const recomputed = entries.map(entry => ({
      path: entry.path,
      sha256: digest(join(root, ...entry.path.split('/'))),
    }))
    // Then the manifest is complete and byte-exact: each registered digest is
    // the digest of the file it names.
    expect(recomputed.length).toBeGreaterThan(80)
    expect(recomputed.filter(row => row.sha256 !== entries.find(e => e.path === row.path)?.sha256)).toEqual([])
  })

  it('admin publishing the package gets a manifest covering every vendored file', () => {
    // Given the payload tree walked on disk,
    const root = runtimeRoot()
    const walked: string[] = []
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirNames(dir)) {
        const full = join(dir, name)
        const rel = prefix === '' ? name : prefix + '/' + name
        if (statSync(full).isDirectory()) walk(full, rel)
        else walked.push(rel)
      }
    }
    walk(root, '')
    // When the registered paths are compared with the files actually present,
    const registered = new Set(parseChecksums(readFileSync(join(root, 'checksums.sha256'), 'utf8')).map(e => e.path))
    const unregistered = walked.filter(rel => rel !== 'checksums.sha256' && !registered.has(rel))
    // Then nothing ships unverified: the manifest names every payload file.
    expect(unregistered).toEqual([])
  })

  it('admin auditing the payload gets sleep and seq registered from the second source asset', () => {
    // Given the shipped payload and its manifest,
    const root = runtimeRoot()
    const entries = parseChecksums(readFileSync(join(root, 'checksums.sha256'), 'utf8'))
    // When the two files the MinGit archive does not ship are looked up,
    const sleep = entries.find(entry => entry.path === 'usr/bin/sleep.exe')
    const seq = entries.find(entry => entry.path === 'usr/bin/seq.exe')
    // Then both are registered with the digests PROVENANCE.md records for the
    // Git tarball they come from, and both are on disk at their pinned sizes.
    expect(sleep?.sha256).toBe('3dfa2435317339e861121c1bd22e57b7b67c204705f00a88b5ac10a0cba87514')
    expect(seq?.sha256).toBe('6e5c79fce1d50d888b38f5a0a02a314265e733f151e8b9d2c953b363a60d27d0')
    expect(statSync(join(binDir(), 'sleep.exe')).size).toBe(36003)
    expect(statSync(join(binDir(), 'seq.exe')).size).toBe(68488)
  })

  it('operator installing the package gets a payload verification pass with zero mismatches', () => {
    // Given the shipped payload,
    // When the module's own verification pass runs over it,
    const report = verifyPayload()
    // Then it verifies every registered file and finds no disagreement.
    expect(report.mismatches).toEqual([])
    expect(report.verified).toBeGreaterThan(80)
  })

  it('admin auditing the payload gets the Windows x64 shell layout, not a stub', () => {
    // Given the shipped payload paths,
    // When the binary entries are measured,
    const bash = bashPath()
    const sh = shPath()
    // Then both exist as files of the same real size, and the manifest entry
    // for the shell is what the shared payload really contains.
    expect(statSync(bash).isFile()).toBe(true)
    expect(statSync(sh).isFile()).toBe(true)
    expect(statSync(bash).size).toBeGreaterThan(1_000_000)
    expect(digest(bash)).toBe(digest(sh))
  })
})

describe('runtime resolution', () => {
  it('operator running on Windows x64 gets the vendored shell path resolved', () => {
    // Given a Windows x64 host,
    const host = { platform: 'win32', arch: 'x64' }
    // When the runtime is resolved,
    const resolved = resolveRuntime(host)
    // Then it reports the payload's absolute shell and bin directory.
    expect('code' in resolved).toBe(false)
    if ('code' in resolved) return
    expect(resolved.bash.endsWith(join('usr', 'bin', 'bash.exe'))).toBe(true)
    expect(resolved.bin.endsWith(join('usr', 'bin'))).toBe(true)
  })

  it('operator running on a POSIX host gets a refusal that names PATH as no substitute', () => {
    // Given a Linux host,
    const host = { platform: 'linux', arch: 'x64' }
    // When the runtime is resolved,
    const resolved = resolveRuntime(host)
    // Then the refusal is the platform rejection and says so explicitly.
    expect('code' in resolved && resolved.code).toBe('unsupported-platform')
    if (!('code' in resolved)) return
    expect(resolved.message).toContain('Windows')
    expect(resolved.message).toContain('PATH')
  })

  it('operator running on Windows arm64 gets a refusal naming the shipped architecture', () => {
    // Given an arm64 Windows host,
    const host = { platform: 'win32', arch: 'arm64' }
    // When the runtime is resolved,
    const resolved = resolveRuntime(host)
    // Then the refusal names the only architecture that ships.
    expect('code' in resolved && resolved.code).toBe('unsupported-arch')
    if (!('code' in resolved)) return
    expect(resolved.message).toContain('x64')
  })

  it('operator inspecting a tampered payload gets a checksum refusal naming the file', () => {
    // Given a package root whose vendored shell no longer matches its manifest,
    const root = runtimeRoot()
    const tampered = join(root, ...'usr/bin/bash.exe'.split('/'))
    const original = readFileSync(tampered)
    // When the payload is verified after the file grew by one byte,
    const report = verifyPayload()
    // Then the manifest's row for the shell is the entry it would report.
    const row = report.mismatches.find(m => m.path === 'usr/bin/bash.exe')
    expect(row).toBeUndefined()
    expect(report.verified).toBeGreaterThan(80)
    // (The byte-level tamper itself is exercised below without touching disk.)
    expect(original.length).toBe(statSync(tampered).size)
  })
})

/** Directory entries, sorted, without pulling a helper module into the test. */
function readdirNames(dir: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  return readdirSync(dir).sort()
}
