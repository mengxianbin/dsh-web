/**
 * File store for `~/.dsh/task-fsm-state.json` (§2.6 机器权威, 回执
 * `state-file-name`: flat single file, taskbot-state 同构, never a directory).
 * Every write is a full-document atomic rename (temp + rename) — a torn file
 * must never be what the host table-checks against. Fail-closed on parse:
 * a corrupt file refuses new transitions loudly (可用性评估 ④) instead of
 * being silently rebuilt empty over the machine authority.
 * @module @linxin666/dsh-task-fsm/host/store
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emptyFsmFile, parseFsmFile, type FsmFile } from '../core/schema.ts'

/** The state file lives flat under the DSH home (回执 state-file-name). */
export function defaultFsmPath(dshHome: string): string {
  return join(dshHome, 'task-fsm-state.json')
}

export class FsmStore {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  /**
   * Load the file; an absent file yields an empty document (first run),
   * a present-but-corrupt file THROWS (fail-closed: never silently reset
   * the machine authority).
   */
  load(): FsmFile {
    if (!existsSync(this.path)) return emptyFsmFile()
    const raw = readFileSync(this.path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`task-fsm-state.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`, { cause: error })
    }
    return parseFsmFile(parsed)
  }

  /** Atomic full-document write (unique temp file + rename). */
  save(file: FsmFile): void {
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true })
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, JSON.stringify(file, null, 1), 'utf8')
    renameSync(temp, this.path)
  }

  /**
   * Load → mutate → save under one synchronous critical section (the host
   * event loop serializes route handlers, so read-modify-write is atomic
   * within a process).
   * @param mutate - receives the loaded file, returns the result to hand back.
   * @returns whatever `mutate` returned.
   */
  update<T>(mutate: (file: FsmFile) => T): T {
    const file = this.load()
    const result = mutate(file)
    this.save(file)
    return result
  }
}
