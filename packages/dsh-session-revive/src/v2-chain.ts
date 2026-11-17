/**
 * The archive-relay-save chain (design session-revival-v2-alert-inbox-1116,
 * section four): the ordered execution behind the machine's
 * `v2-archive-relay` intent. The order is not negotiable - pre-flight, then
 * archive with the structured reason, then spawn the relay seeded with
 * relayDepth=1, then fold the relay id back into the ledger reason. The relay
 * session itself performs the代劳 save by reading the OLD transcript (seed
 * text below); this module only guarantees the order and the fail-closed
 * pre-flight.
 *
 * Pre-flight is the same fail-closed claim the machine was constructed on,
 * aimed at the concrete target: if the transcript about to lose its saver is
 * not readable, the chain stops and reports before anything is archived -
 * never archive first and discover the loss later.
 *
 * All four effects are ports. The host wires loopback REST (archive and
 * dispatch are separate plugins with no in-process face); tests wire fakes
 * and assert the order.
 * @module dsh-session-revive/v2-chain
 */

import type { V2ArchiveReason, V2Record } from './v2-machine.ts'
import { verifyTranscriptReadable } from './v2-transcript.ts'

/**
 * The channel actor the archive identity gate sees: a non-session-id actor
 * resolves to the human channel class (archive package `resolveActorClass`),
 * which is the authority the ruling granted this chain (forced archive with
 * a stated reason - the user's 「强制归档，并指明归档原因」).
 */
export const RELAY_ACTOR = 'dsh-session-revive'

/** Per-call ceilings: a wedged host must fail the chain, not hang it. */
const VERIFY_TIMEOUT_MS = 20_000
const ARCHIVE_TIMEOUT_MS = 30_000
const SPAWN_TIMEOUT_MS = 30_000
const BINDINGS_TIMEOUT_MS = 10_000

/** One step's outcome. */
export interface ChainStep {
  ok: boolean
  detail: string
}

/** Where the relay session must be spawned (from the dead session's binding). */
export interface SpawnTarget {
  workspaceId: string
  taskRef?: string
}

/** The four effects the chain orders; the host supplies real ones. */
export interface ChainPorts {
  /** Fail-closed re-check: is this session's transcript still readable? */
  verifyTranscript(sessionId: string): Promise<ChainStep>
  /** Resolve the dead session's workspace/taskRef so the relay lands beside it. */
  resolveSpawnTarget(sourceSessionId: string): Promise<{ ok: true; target: SpawnTarget } | { ok: false; detail: string }>
  /** Archive the dead session with the structured reason (forced, stated reason). */
  archive(sessionId: string, reason: string): Promise<ChainStep>
  /** Create the relay session and queue the seed prompt. */
  spawnRelay(input: { sourceSessionId: string; target: SpawnTarget; seed: string; title: string }): Promise<{
    ok: boolean
    relaySessionId?: string
    detail: string
  }>
  /** Fold the relay id back into the ledger reason (same entry, archivedAt kept). */
  updateArchiveReason(sessionId: string, reason: string): Promise<ChainStep>
}

/** The chain's full report: step records for the log plus the final verdict. */
export interface ChainOutcome {
  records: V2Record[]
  ok: boolean
  relaySessionId?: string
  detail: string
}

/**
 * The structured ledger reason (section four: reason code + spend + start/end
 * times + relay id - structured, never prose). The relay id is `pending`
 * until the spawn lands, then the reason is rewritten with the real id.
 */
export function buildArchiveReason(reason: V2ArchiveReason, relaySessionId?: string): string {
  const iso = (at: number): string => new Date(at).toISOString()
  return [
    reason.code,
    `tokens=${reason.tokens}`,
    `from=${iso(reason.from)}`,
    `to=${iso(reason.to)}`,
    `relay=${relaySessionId ?? 'pending'}`,
  ].join('; ')
}

/**
 * The relay session's seed prompt (section four): relayDepth=1 travels in the
 * text so the successor knows it is generation one, the first instruction is
 * the代劳 save off the OLD transcript (no dependency on save products the
 * dead session never wrote), and the no-further-relay discipline is stated up
 * front.
 */
export function buildRelaySeed(input: {
  sourceSessionId: string
  reason: string
  taskRef?: string
}): string {
  const lines = [
    `接力会话（relayDepth=1）：原会话 ${input.sourceSessionId} 复活失败已归档。`,
    `归档原因 = ${input.reason}`,
    '第一步（代劳 save）：读取原会话的转录，替它完成 save——原会话已经无法自行保存，不要依赖它的 save 产物。',
    '第二步：继续原任务。',
    '纪律：你是接力第 1 代（relayDepth=1）。若你再次失败，不要自行接力或归档，保留现场等人工。',
  ]
  if (input.taskRef !== undefined) lines.push(`任务锚 = ${input.taskRef}`)
  return lines.join('\n')
}

/**
 * Run the chain in section-four order. Pre-flight (transcript readability +
 * spawn target) runs BEFORE the archive so a doomed chain never leaves the
 * session archived with no successor; a failed archive stops everything; a
 * failed spawn is reported loudly (the session is archived and nobody came).
 * The reason rewrite after a successful spawn is best-effort - the state
 * export already carries `relaySessionId`, so a failed rewrite degrades to a
 * detail line, never to a false chain failure.
 * @param input - the intent's session and structured reason plus the ports.
 * @returns step records and the final verdict for {@link onChainResult}.
 */
export async function runArchiveRelayChain(input: {
  sessionId: string
  reason: V2ArchiveReason
  ports: ChainPorts
  now?: () => number
}): Promise<ChainOutcome> {
  const { sessionId, reason, ports } = input
  const now = input.now ?? (() => Date.now())
  const records: V2Record[] = []
  const step = (ok: boolean, detail: string): ChainStep => ({ ok, detail })
  const fail = (detail: string): ChainOutcome => {
    records.push({ kind: 'v2-chain', at: now(), sessionId, ok: false, detail })
    return { records, ok: false, detail }
  }

  // 1. Fail-closed pre-flight: the relay save reads this transcript, so it
  //    must be provably readable before the archive removes the saver.
  let verified: ChainStep
  try {
    verified = await ports.verifyTranscript(sessionId)
  } catch (error) {
    return fail(`verify threw: ${shortError(error)}`)
  }
  if (!verified.ok) return fail(`verify refused (fail-closed): ${verified.detail}`)

  // 2. Pre-flight: where would the relay land? No workspace, no archive.
  let target: SpawnTarget
  try {
    const resolved = await ports.resolveSpawnTarget(sessionId)
    if (!resolved.ok) return fail(`spawn target unresolved: ${resolved.detail}`)
    target = resolved.target
  } catch (error) {
    return fail(`resolve threw: ${shortError(error)}`)
  }

  // 3. Archive with the structured reason (forced, stated reason).
  const baseReason = buildArchiveReason(reason)
  let archived: ChainStep
  try {
    archived = await ports.archive(sessionId, baseReason)
  } catch (error) {
    return fail(`archive threw: ${shortError(error)}`)
  }
  if (!archived.ok) return fail(`archive refused: ${archived.detail}`)

  // 4. Spawn the relay, seeded with relayDepth=1 and the save instruction.
  const seed = buildRelaySeed({ sourceSessionId: sessionId, reason: baseReason, ...(target.taskRef === undefined ? {} : { taskRef: target.taskRef }) })
  let spawned: { ok: boolean; relaySessionId?: string; detail: string }
  try {
    spawned = await ports.spawnRelay({ sourceSessionId: sessionId, target, seed, title: `接力 ${sessionId}` })
  } catch (error) {
    return fail(`spawn threw after archive: ${shortError(error)}`)
  }
  if (!spawned.ok || spawned.relaySessionId === undefined) {
    return fail(`spawn failed after archive (session archived, no relay): ${spawned.detail}`)
  }

  // 5. Fold the relay id back into the ledger reason; best-effort only.
  let rewritten: ChainStep = step(true, 'not-attempted')
  try {
    rewritten = await ports.updateArchiveReason(sessionId, buildArchiveReason(reason, spawned.relaySessionId))
  } catch (error) {
    rewritten = step(false, `update threw: ${shortError(error)}`)
  }
  const detail = `archived+relayed relay=${spawned.relaySessionId}; verify=${verified.detail}; reason-update=${rewritten.ok ? 'ok' : rewritten.detail}`
  records.push({
    kind: 'v2-chain',
    at: now(),
    sessionId,
    ok: true,
    relaySessionId: spawned.relaySessionId,
    detail,
  })
  return { records, ok: true, relaySessionId: spawned.relaySessionId, detail }
}

/**
 * Loopback REST ports: the archive and dispatch plugins are siblings with no
 * in-process service face, so every effect is an HTTP call to this host's own
 * webserver (loopback, `NO_PROXY` covers 127.0.0.1 so the calls never detour
 * through the proxy the provider path uses).
 * @param options - the loopback base (`http://127.0.0.1:<port>`) and DSH home.
 * @returns the wired ports.
 */
export function createLoopbackChainPorts(options: { apiBase: string; home?: string }): ChainPorts {
  const base = options.apiBase.replace(/\/+$/, '')
  const home = options.home

  const post = async (path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    let json: Record<string, unknown> = {}
    try {
      json = (await response.json()) as Record<string, unknown>
    } catch {
      json = {}
    }
    return { status: response.status, json }
  }

  return {
    async verifyTranscript(sessionId) {
      const result = home === undefined ? verifyTranscriptReadable(sessionId) : verifyTranscriptReadable(sessionId, home)
      return { ok: result.ok, detail: result.detail }
    },
    async resolveSpawnTarget(sourceSessionId) {
      const response = await fetch(`${base}/api/session-dispatch/bindings`, { signal: AbortSignal.timeout(BINDINGS_TIMEOUT_MS) })
      const body = (await response.json()) as { bindings?: Array<Record<string, unknown>> }
      const bindings = Array.isArray(body.bindings) ? body.bindings : []
      const hit = bindings.find((row) => row.sessionId === sourceSessionId)
      if (hit === undefined) return { ok: false, detail: `no dispatch binding for ${sourceSessionId}` }
      const workspaceId = typeof hit.workspaceId === 'string' ? hit.workspaceId : undefined
      if (workspaceId === undefined) return { ok: false, detail: `binding for ${sourceSessionId} has no workspaceId` }
      const taskRef = typeof hit.taskRef === 'string' ? hit.taskRef : undefined
      return { ok: true, target: { workspaceId, ...(taskRef === undefined ? {} : { taskRef }) } }
    },
    async archive(sessionId, reason) {
      const { status, json } = await post(
        '/api/session-archive/archive',
        { ids: [sessionId], actor: RELAY_ACTOR, force: { reason } },
        ARCHIVE_TIMEOUT_MS,
      )
      if (status < 200 || status >= 300 || json.ok === false) {
        return { ok: false, detail: `http ${status}: ${stringify(json.error)}` }
      }
      const results = Array.isArray(json.results) ? (json.results as Array<Record<string, unknown>>) : undefined
      const mine = results?.find((row) => row.id === sessionId)
      if (mine !== undefined && mine.status !== 'ok') {
        return { ok: false, detail: `archive result ${stringify(mine.status)}: ${stringify(mine.reason ?? mine.detail)}` }
      }
      return { ok: true, detail: `archived http ${status}` }
    },
    async spawnRelay({ sourceSessionId, target, seed, title }) {
      const { status, json } = await post(
        '/api/session-dispatch',
        {
          workspaceId: target.workspaceId,
          prompt: seed,
          title,
          sessionClass: 'bot-worker',
          ...(target.taskRef === undefined ? {} : { taskRef: target.taskRef }),
        },
        SPAWN_TIMEOUT_MS,
      )
      const relaySessionId = typeof json.sessionId === 'string' ? json.sessionId : undefined
      if (status < 200 || status >= 300 || json.ok !== true || relaySessionId === undefined) {
        return { ok: false, detail: `dispatch http ${status} for ${sourceSessionId}: ${stringify(json.error)}` }
      }
      return { ok: true, relaySessionId, detail: `dispatched http ${status}` }
    },
    async updateArchiveReason(sessionId, reason) {
      const { status, json } = await post(
        '/api/session-archive/archive-override',
        { ids: [sessionId], mode: 'force', reason },
        ARCHIVE_TIMEOUT_MS,
      )
      if (status < 200 || status >= 300 || json.ok === false) {
        return { ok: false, detail: `override http ${status}: ${stringify(json.error)}` }
      }
      return { ok: true, detail: `reason updated http ${status}` }
    },
  }
}

/** One-line error text for chain details. */
function shortError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 200)
}

/** Bounded detail text from an unknown response field. */
function stringify(value: unknown): string {
  if (value === undefined) return 'unknown'
  return String(value).slice(0, 200)
}
