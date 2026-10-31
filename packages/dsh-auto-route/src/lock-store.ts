/**
 * Durable storage for the manual-lock ledger (2026-11-01 ruling A: 锁持久化).
 * The A-case ruling (2026-10-27) made human locks authoritative over both
 * policy edges, but the ledger lived in memory — a Host restart dropped it
 * and the first reconcile pass after boot would have dragged deliberately
 * parked sessions back across, breaking the ruling. This store persists the
 * lock ENTRIES only: the controller's own-write ledger stays in memory (it
 * rebuilds from the first events after boot, and a lost ledger only ever
 * makes the classifier MORE cautious, never less — a missing ledger entry
 * turns a would-be `aligned` into a `manual-lock`, which skips edges rather
 * than switching anything).
 *
 * File format: one JSON document `{ version: 1, locks: [...] }` written
 * atomically (tmp + rename). A missing file is a cold start; a corrupt file
 * warns and starts cold too — fail-open, because locks protect sessions from
 * automation, and losing the file must not stop the controller from mounting.
 * @module dsh-auto-route/lock-store
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ManualLockEntry } from './manual-lock.ts'

/** Store surface the ManualLockTracker consumes (injectable for tests). */
export interface LockStore {
  /** Persisted locks, or undefined on a cold/failed start. */
  load(): ManualLockEntry[] | undefined
  /** Replace the persisted lock set. */
  save(locks: readonly ManualLockEntry[]): void
}

/** Current on-disk format version. */
export const LOCK_STORE_VERSION = 1

/** Minimal logger surface (the Host logger satisfies it). */
export interface LockStoreLogger {
  warn(message: string): void
}

/** Runtime shape guard for one persisted entry. */
function isEntry(value: unknown): value is ManualLockEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.sessionId === 'string'
    && entry.sessionId !== ''
    && typeof entry.value === 'string'
    && entry.value !== ''
    && typeof entry.lockedAt === 'number'
    && Number.isFinite(entry.lockedAt)
}

/** File-backed lock store: atomic writes, corrupt-file fail-open. */
export class FileLockStore implements LockStore {
  constructor(
    private readonly path: string,
    private readonly logger?: LockStoreLogger,
  ) {}

  /** Read the persisted locks; undefined on cold start or an unreadable file. */
  load(): ManualLockEntry[] | undefined {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return undefined // cold start: no file yet is the normal first run.
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
      const document = parsed as Record<string, unknown>
      if (document.version !== LOCK_STORE_VERSION) {
        throw new Error(`unsupported version ${String(document.version)}`)
      }
      if (!Array.isArray(document.locks)) throw new Error('locks is not an array')
      const locks = document.locks.filter(isEntry)
      if (locks.length !== document.locks.length) {
        this.logger?.warn(`dsh-auto-route: lock store dropped ${document.locks.length - locks.length} malformed entry/entries in ${this.path}`)
      }
      return locks
    } catch (error) {
      this.logger?.warn(
        `dsh-auto-route: lock store unreadable (${error instanceof Error ? error.message : String(error)}); starting with no persisted locks — ${this.path}`,
      )
      return undefined
    }
  }

  /**
   * Replace the persisted lock set. Atomic (tmp + rename) so a crash mid-write
   * can never leave a half JSON behind; write failures warn, never throw —
   * persistence is best-effort, in-memory locks stay authoritative.
   */
  save(locks: readonly ManualLockEntry[]): void {
    const payload = `${JSON.stringify({ version: LOCK_STORE_VERSION, locks }, null, 2)}\n`
    const temp = join(dirname(this.path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.locktmp`)
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(temp, payload, 'utf8')
      renameSync(temp, this.path)
    } catch (error) {
      try { unlinkSync(temp) } catch { /* the temp never landed or is already gone */ }
      this.logger?.warn(
        `dsh-auto-route: lock store write failed (${error instanceof Error ? error.message : String(error)}) — in-memory locks remain authoritative for this Host lifetime`,
      )
    }
  }
}
