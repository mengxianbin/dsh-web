/**
 * The Host-authoritative dsh-agents ledger: one JSON document under the
 * plugin-owned directory, written by exactly one owner process.
 *
 * Three rules decide this file:
 * - Atomic writes only: an fsynced temporary file plus rename, so a crash
 *   leaves the previous document intact rather than a truncated one.
 * - One writer: an exclusive lock file records the owning pid; a live owner
 *   refuses the second mount instead of letting two processes interleave.
 * - Fail closed: an unreadable or corrupt document is reported and NEVER
 *   reset, quarantined or overwritten. A user's definitions are not this
 *   plugin's to discard, so every read raises and every write is refused while
 *   the bytes on disk stay exactly as they were found.
 *
 * @module @linxin666/dsh-agents/host/ledger
 */
import { closeSync, chmodSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AgentsError } from '../core/errors.ts'
import { agentsHomeDirectory } from './home.ts'
import {
  BRIEF_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  DSH_AGENTS_SCHEMA_VERSION,
  ID_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PIN_MAX_LENGTH,
  SQUAD_GOAL_MAX_LENGTH,
  isAgentsPermission,
  type MemberDefinition,
  type RunRecord,
  type TeamDefinition,
} from '../protocol.ts'

/** Ledger file name inside the plugin directory. */
export const AGENTS_LEDGER_FILE = 'ledger.json'

/** Lock file name beside it. */
export const AGENTS_LEDGER_LOCK_FILE = 'ledger.json.lock'

/** How many runs the ledger keeps; the oldest are dropped on append. */
export const RUN_HISTORY_LIMIT = 200

/** The persisted document. `revision` increases with every committed write. */
export interface AgentsLedgerDocument {
  schemaVersion: typeof DSH_AGENTS_SCHEMA_VERSION
  revision: number
  teams: TeamDefinition[]
  runs: RunRecord[]
}

/** What the browser panel reads. */
export interface AgentsLedgerData {
  teams: TeamDefinition[]
  runs: RunRecord[]
}

/** Construction options; every field has a production default. */
export interface AgentsLedgerOptions {
  /** Plugin-owned directory; defaults to `$DSH_HOME/dsh-agents`. */
  dir?: string
  /** Clock seam. */
  now?: () => number
  /** Owner pid seam. */
  pid?: number
}

function emptyDocument(): AgentsLedgerDocument {
  return { schemaVersion: DSH_AGENTS_SCHEMA_VERSION, revision: 0, teams: [], runs: [] }
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
}

function optionalText(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Whether a pid names a live process. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists under another user; only ESRCH is a
    // positive "no such process".
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Validate one persisted member row. A row is accepted only exactly as this
 * build would write it: an unknown or malformed field makes the whole document
 * corrupt rather than letting a repaired row stand in for the user's data.
 */
function readMemberRow(value: unknown, teamId: string): MemberDefinition | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!isText(row.id, ID_MAX_LENGTH) || row.teamId !== teamId) return undefined
  if (!isText(row.name, NAME_MAX_LENGTH)) return undefined
  if (!optionalText(row.preset, PIN_MAX_LENGTH) || !optionalText(row.model, PIN_MAX_LENGTH)) return undefined
  if (!optionalText(row.reasoningEffort, PIN_MAX_LENGTH) || !optionalText(row.brief, BRIEF_MAX_LENGTH)) return undefined
  if (row.permission !== undefined && !isAgentsPermission(row.permission)) return undefined
  if (!isTimestamp(row.createdAt) || !isTimestamp(row.updatedAt)) return undefined
  return {
    id: row.id,
    teamId,
    name: row.name,
    ...(row.preset === undefined ? {} : { preset: row.preset as string }),
    ...(row.permission === undefined ? {} : { permission: row.permission }),
    ...(row.model === undefined ? {} : { model: row.model as string }),
    ...(row.reasoningEffort === undefined ? {} : { reasoningEffort: row.reasoningEffort as string }),
    ...(row.brief === undefined ? {} : { brief: row.brief as string }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Validate one persisted team row and its member list. */
function readTeamRow(value: unknown): TeamDefinition | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!isText(row.id, ID_MAX_LENGTH) || !isText(row.name, NAME_MAX_LENGTH)) return undefined
  if (!optionalText(row.description, DESCRIPTION_MAX_LENGTH) || !optionalText(row.workspaceId, PIN_MAX_LENGTH)) return undefined
  if (!optionalText(row.leadPreset, PIN_MAX_LENGTH)) return undefined
  if (row.order !== undefined && (typeof row.order !== 'number' || !Number.isInteger(row.order))) return undefined
  if (!isTimestamp(row.createdAt) || !isTimestamp(row.updatedAt)) return undefined
  if (!Array.isArray(row.members)) return undefined
  const members: MemberDefinition[] = []
  for (const candidate of row.members) {
    const member = readMemberRow(candidate, row.id)
    if (member === undefined) return undefined
    if (members.some(existing => existing.id === member.id)) return undefined
    members.push(member)
  }
  return {
    id: row.id,
    name: row.name,
    ...(row.description === undefined ? {} : { description: row.description as string }),
    ...(row.workspaceId === undefined ? {} : { workspaceId: row.workspaceId as string }),
    ...(row.leadPreset === undefined ? {} : { leadPreset: row.leadPreset as string }),
    ...(row.order === undefined ? {} : { order: row.order }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    members,
  }
}

/**
 * Validate one persisted run row. A member run carries the member it launched;
 * a squad run carries the goal its Lead session was given and no member at all,
 * so a squad run can never be mistaken for a member run in the browser's
 * member rows.
 */
function readRunRow(value: unknown): RunRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!isText(row.id, ID_MAX_LENGTH) || !isText(row.teamId, ID_MAX_LENGTH)) return undefined
  if (!isText(row.sessionId, ID_MAX_LENGTH) || !isTimestamp(row.createdAt)) return undefined
  if (row.status !== 'running' && row.status !== 'settled' && row.status !== 'failed') return undefined
  if (row.failure !== undefined && typeof row.failure !== 'string') return undefined
  if (row.kind !== undefined && row.kind !== 'member' && row.kind !== 'squad') return undefined
  const kind = row.kind ?? 'member'
  if (kind === 'member' && !isText(row.memberId, ID_MAX_LENGTH)) return undefined
  if (kind === 'squad' && row.memberId !== undefined) return undefined
  if (row.goal !== undefined && (typeof row.goal !== 'string' || row.goal.length > SQUAD_GOAL_MAX_LENGTH)) return undefined
  return {
    id: row.id,
    teamId: row.teamId,
    ...(kind === 'squad' ? {} : { memberId: row.memberId as string }),
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    status: row.status,
    ...(row.failure === undefined ? {} : { failure: row.failure }),
    ...(kind === 'squad' ? { kind: 'squad' as const } : {}),
    ...(row.goal === undefined ? {} : { goal: row.goal }),
  }
}

function parseDocument(text: string): AgentsLedgerDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new AgentsError('ledger-corrupt', 'the dsh-agents ledger is not valid JSON: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AgentsError('ledger-corrupt', 'the dsh-agents ledger is not a JSON object')
  }
  const document = parsed as Record<string, unknown>
  if (document.schemaVersion !== DSH_AGENTS_SCHEMA_VERSION) {
    throw new AgentsError('ledger-corrupt', 'the dsh-agents ledger declares schema version ' + String(document.schemaVersion) + ', this build reads ' + String(DSH_AGENTS_SCHEMA_VERSION))
  }
  if (typeof document.revision !== 'number' || !Number.isInteger(document.revision) || document.revision < 0) {
    throw new AgentsError('ledger-corrupt', 'the dsh-agents ledger carries no usable revision')
  }
  if (!Array.isArray(document.teams) || !Array.isArray(document.runs)) {
    throw new AgentsError('ledger-corrupt', 'the dsh-agents ledger has no teams/runs arrays')
  }
  const teams: TeamDefinition[] = []
  for (const candidate of document.teams) {
    const team = readTeamRow(candidate)
    if (team === undefined) throw new AgentsError('ledger-corrupt', 'the dsh-agents ledger holds a malformed team record')
    if (teams.some(existing => existing.id === team.id)) throw new AgentsError('ledger-corrupt', 'the dsh-agents ledger holds a duplicate team id')
    teams.push(team)
  }
  const runs: RunRecord[] = []
  for (const candidate of document.runs) {
    const run = readRunRow(candidate)
    if (run === undefined) throw new AgentsError('ledger-corrupt', 'the dsh-agents ledger holds a malformed run record')
    runs.push(run)
  }
  return { schemaVersion: DSH_AGENTS_SCHEMA_VERSION, revision: document.revision, teams, runs }
}

/**
 * The single-writer ledger.
 *
 * Construct through {@link AgentsLedger.open}: it acquires the owner lock and
 * loads the document, throwing {@link AgentsError} with `ledger-owned` or
 * `ledger-corrupt` rather than starting on top of someone else's data.
 */
export class AgentsLedger {
  /** Absolute path of the ledger document. */
  readonly file: string
  /** Absolute path of the owner lock. */
  readonly lockFile: string
  /** Pid that owns this ledger's lock. */
  readonly ownerPid: number

  private readonly now: () => number
  private readonly lockToken: string
  private lockFd: number | undefined
  private document: AgentsLedgerDocument

  private constructor(directory: string, ownerPid: number, now: () => number, lockToken: string, lockFd: number, document: AgentsLedgerDocument) {
    this.file = join(directory, AGENTS_LEDGER_FILE)
    this.lockFile = join(directory, AGENTS_LEDGER_LOCK_FILE)
    this.ownerPid = ownerPid
    this.now = now
    this.lockToken = lockToken
    this.lockFd = lockFd
    this.document = document
  }

  /**
   * Open the ledger in `dir`, taking the single-owner lock first.
   * @param options - directory, clock and pid seams.
   * @returns the opened ledger.
   * @throws AgentsError `ledger-owned` when a live process holds the lock, or
   *   `ledger-corrupt` when the document cannot be read exactly as written.
   */
  static open(options: AgentsLedgerOptions = {}): AgentsLedger {
    const directory = options.dir ?? agentsHomeDirectory()
    const now = options.now ?? Date.now
    const ownerPid = options.pid ?? process.pid
    mkdirSync(directory, { recursive: true })
    const lockFile = join(directory, AGENTS_LEDGER_LOCK_FILE)
    const lockToken = ownerPid + '-' + now() + '-' + Math.random().toString(16).slice(2)
    const lockFd = acquireLock(lockFile, ownerPid, lockToken, now)
    try {
      const ledger = new AgentsLedger(directory, ownerPid, now, lockToken, lockFd, readDocument(join(directory, AGENTS_LEDGER_FILE)))
      // A first mount materializes the document so the file, its permissions
      // and the revision counter exist before anything is written.
      if (!existsSync(ledger.file)) ledger.commit()
      return ledger
    } catch (error) {
      closeLock(lockFd)
      try { unlinkSync(lockFile) } catch { /* the lock is ours; a failed cleanup must not mask the load error */ }
      throw error
    }
  }

  /** The current revision the document was written at. */
  get revision(): number {
    return this.document.revision
  }

  /**
   * Read the document. The returned value is a deep copy: a caller cannot
   * mutate ledger state without going through {@link mutate}.
   * @returns teams in stored order and runs newest first.
   */
  snapshot(): AgentsLedgerData {
    return { teams: structuredClone(this.document.teams), runs: structuredClone(this.document.runs) }
  }

  /**
   * Apply one change and commit it atomically.
   *
   * The callback receives a deep copy, so a callback that throws — or a write
   * that fails — leaves both the in-memory document and the file at their
   * previous state. `revision` increases by exactly one per committed write.
   * @param change - mutation of the draft document.
   * @returns whatever the callback returns.
   */
  mutate<T>(change: (document: AgentsLedgerDocument) => T): T {
    const draft = structuredClone(this.document)
    const result = change(draft)
    draft.revision = this.document.revision + 1
    this.commitDocument(draft)
    this.document = draft
    return result
  }

  /** Release the owner lock. Idempotent. */
  dispose(): void {
    if (this.lockFd === undefined) return
    closeLock(this.lockFd)
    this.lockFd = undefined
    try {
      const owner = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { token?: unknown }
      if (owner.token === this.lockToken) unlinkSync(this.lockFile)
    } catch {
      // A vanished or re-owned lock file is not this instance's to delete.
    }
  }

  private commit(): void {
    this.commitDocument(this.document)
  }

  /**
   * Fsync + rename write of one document. The temporary file carries the owner
   * pid so a leftover from a crashed process is identifiable.
   */
  private commitDocument(document: AgentsLedgerDocument): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = this.file + '.tmp-' + this.ownerPid
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'w', 0o600)
      writeFileSync(fd, JSON.stringify(document, null, 2), { encoding: 'utf8' })
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      try { chmodSync(temporary, 0o600) } catch { /* Windows ACLs own access */ }
      renameSync(temporary, this.file)
      try {
        const directoryFd = openSync(dirname(this.file), 'r')
        try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      } catch {
        // Windows does not permit fsync on a directory handle; rename stays atomic.
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch { /* best-effort temporary cleanup */ }
      throw new AgentsError('ledger-write-failed', 'the dsh-agents ledger could not be written: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
}

function readDocument(file: string): AgentsLedgerDocument {
  if (!existsSync(file)) return emptyDocument()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new AgentsError('ledger-corrupt', 'the dsh-agents ledger could not be read: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (text.trim() === '') throw new AgentsError('ledger-corrupt', 'the dsh-agents ledger is empty')
  return parseDocument(text)
}

function closeLock(fd: number): void {
  try { closeSync(fd) } catch { /* the descriptor is gone either way */ }
}

/**
 * Take the exclusive owner lock, reclaiming one whose pid is dead.
 * @throws AgentsError `ledger-owned` when a live process holds it.
 */
function acquireLock(lockFile: string, pid: number, token: string, now: () => number): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify({ pid, token, startedAt: now() }), { encoding: 'utf8' })
      fsyncSync(fd)
      try { chmodSync(lockFile, 0o600) } catch { /* Windows ACLs own access */ }
      return fd
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw new AgentsError('ledger-write-failed', 'the dsh-agents ledger lock could not be created: ' + (error instanceof Error ? error.message : String(error)))
      }
      let ownerPid: number | undefined
      try {
        const owner = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid?: unknown }
        if (typeof owner.pid === 'number') ownerPid = owner.pid
      } catch {
        // An unreadable lock cannot admit anyone: it is either a crash mid-write
        // or a foreign file in our directory. Either way this mount refuses.
        throw new AgentsError('ledger-owned', 'the dsh-agents ledger lock is unreadable: ' + lockFile)
      }
      if (ownerPid !== undefined && processIsAlive(ownerPid)) {
        throw new AgentsError('ledger-owned', 'the dsh-agents ledger is already owned by process ' + ownerPid)
      }
      // The recorded owner is gone: reclaim the leftover lock exactly once.
      try { unlinkSync(lockFile) } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new AgentsError('ledger-write-failed', 'the stale dsh-agents ledger lock could not be removed: ' + (unlinkError instanceof Error ? unlinkError.message : String(unlinkError)))
        }
      }
    }
  }
  throw new AgentsError('ledger-owned', 'the dsh-agents ledger lock could not be acquired: ' + lockFile)
}
