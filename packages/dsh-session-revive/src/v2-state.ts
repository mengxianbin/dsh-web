/**
 * The v2 state export (design session-revival-v2-alert-inbox-1116, section
 * seven): the bilateral file `<dsh-home>/session-revive-v2-state.json` whose
 * shape the alert-inbox单 consumes. The field set is the contract, literal -
 * single-side internals must never widen or rename it, and the inbox reader
 * tolerates unknown fields on its side only.
 *
 * Change-only write, following the `session-revive-health.json` twin: the
 * `sessions` payload is compared against what was last written and nothing
 * lands while it does not flip, so a quiet machine costs zero writes. The
 * `at` stamp rides only real changes (comparing it would turn every sync into
 * a write). Writes are atomic (temp then rename) and best-effort: a state-file
 * hiccup must never bubble into the revival chain - the reader degrades to an
 * absent file, never to a half-written one.
 * @module dsh-session-revive/v2-state
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './dsh-home.ts'
import type { ReviveV2StateExport } from './v2-machine.ts'

/** Ledger filename under the DSH home; the inbox fold reads this exact path. */
export const REVIVE_V2_STATE_FILE = 'session-revive-v2-state.json'

/** Injectable write seam so tests never touch the real DSH home. */
export type ReviveV2StateWrite = (path: string, payload: string) => void

function atomicWrite(path: string, payload: string): void {
  const temp = `${path}.tmp`
  writeFileSync(temp, payload, 'utf8')
  renameSync(temp, path)
}

/**
 * The change-only writer: `sync` writes iff the sessions payload differs from
 * the last write (or the file has never been written). A missing file on disk
 * counts as never written, so an externally removed file is restored on the
 * next real change rather than staying silently absent.
 */
export class ReviveV2StateWriter {
  private readonly path: string
  private readonly write: ReviveV2StateWrite
  private lastPayload: string | undefined

  constructor(options: { home?: string; path?: string; write?: ReviveV2StateWrite; readExisting?: boolean } = {}) {
    this.path = options.path ?? join(options.home ?? dshHome(), REVIVE_V2_STATE_FILE)
    this.write = options.write ?? atomicWrite
    if (options.readExisting ?? true) {
      // Seed from disk so a restarted host does not rewrite byte-identical
      // state; an absent or corrupt file simply means "nothing written yet".
      try {
        const raw = readFileSync(this.path, 'utf8')
        const parsed = JSON.parse(raw) as { sessions?: unknown }
        if (typeof parsed.sessions === 'object' && parsed.sessions !== null) {
          this.lastPayload = JSON.stringify(parsed.sessions)
        }
      } catch {
        this.lastPayload = undefined
      }
    }
  }

  /**
   * Publish one snapshot iff its `sessions` payload flipped since the last
   * write. `at` only rides along - it is never part of the comparison.
   * @param snapshot - the machine's section-seven document.
   * @returns true when a write happened (the change-only self-check reads this).
   */
  sync(snapshot: ReviveV2StateExport): boolean {
    const payload = JSON.stringify(snapshot.sessions)
    if (payload === this.lastPayload) return false
    try {
      this.write(this.path, `${JSON.stringify({ at: snapshot.at, sessions: snapshot.sessions })}\n`)
      this.lastPayload = payload
      return true
    } catch {
      // Best-effort: see module doc. The baseline stays at the last SUCCESSFUL
      // write, so a transient failure retries on the next real change.
      return false
    }
  }
}
