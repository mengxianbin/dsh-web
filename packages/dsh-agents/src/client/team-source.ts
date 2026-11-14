/**
 * Where the squad page reads the live roster of one whole-squad run.
 *
 * Preferred surface: the shared session store the official UI reads. The client
 * session catalog publishes every host-computed projection under
 * `projectionsBySession[leadSessionId].values.agentTeam`, and this plugin's host
 * half registers exactly that `agentTeam` projection (stateVersion 4) for the
 * Lead session of a squad run. Reading it costs no request and no poll.
 *
 * Fallback surface: a bounded poll of the PROPOSED read-only Host route
 * (`GET /dsh-agents/api/squad/team?sessionId=…`, declared in protocol.ts but not
 * served by this build). It is used only when the session store is out of reach
 * from this plugin's context, stops on its own once the route answers "not
 * mounted", and gives up after {@link SQUAD_TEAM_POLL_MAX_FAILURES} consecutive
 * transport failures. Adopting the route Host-side therefore needs no page
 * change: {@link createTeamSource} is the single place that picks a surface.
 *
 * @module @linxin666/dsh-agents/client
 */
import { failureOf } from './host-api.ts'
import type { AgentsTransport } from './host-api.ts'
import type { SquadTeamMemberWire } from '../protocol.ts'

/** What the page knows about the live team of one squad run. */
export type SquadTeamSnapshot =
  /** No surface answers in this deployment: say so instead of polling forever. */
  | { state: 'unavailable' }
  /** The surface is reachable but has published no team yet (the Lead has not spawned one). */
  | { state: 'pending' }
  | { state: 'ready'; rows: readonly SquadTeamMemberWire[]; failure?: string }
  /** The surface answered with a transport failure the page reports. */
  | { state: 'error'; message: string }

/** One place the page can read the live team from. */
export interface SquadTeamSource {
  /** Which surface this source is: the shared projection, or the proposed route. */
  readonly kind: 'projection' | 'poll'
  /**
   * Follow one Lead session.
   * @param sessionId - the Lead session id of the newest squad run.
   * @param onChange - receives the current snapshot now and after every change.
   * @returns the unsubscribe function.
   */
  watch(sessionId: string, onChange: (snapshot: SquadTeamSnapshot) => void): () => void
}

/** The slice of the client session catalog this adapter reads. */
export interface SessionListFace {
  getSnapshot(): { readonly projectionsBySession?: Readonly<Record<string, SessionProjectionFace | undefined>> }
  subscribe(listener: () => void): () => void
}

/** One session's projection row: the whole values map the host published. */
export interface SessionProjectionFace {
  readonly values: Readonly<Record<string, unknown>>
}

/** Refresh cadence of the fallback route while a squad page is open. */
export const SQUAD_TEAM_POLL_INTERVAL_MS = 4000

/** Consecutive transport failures the fallback poll tolerates before it stops. */
export const SQUAD_TEAM_POLL_MAX_FAILURES = 3

/** The projection key this plugin's host half registers. */
export const AGENT_TEAM_PROJECTION_KEY = 'agentTeam'

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read one published team value.
 * @param value - whatever the projection key (or the proposed route) carried.
 * @returns the roster, or undefined when the value is not a shape this build reads.
 */
export function readTeamValue(value: unknown): { rows: SquadTeamMemberWire[]; failure?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { members?: unknown; failure?: unknown }
  if (!Array.isArray(record.members)) return undefined
  const rows: SquadTeamMemberWire[] = []
  for (const candidate of record.members as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const member = candidate as Record<string, unknown>
    const id = text(member.id)
    const name = text(member.name)
    const role = member.role
    const phase = member.phase
    if (id === undefined || name === undefined) return undefined
    if (role !== 'lead' && role !== 'teammate') return undefined
    if (phase !== 'provisioning' && phase !== 'active' && phase !== 'failed') return undefined
    const error = text(member.error)
    rows.push({ id, name, role, phase, ...(error === undefined ? {} : { error }) })
  }
  const failure = text(record.failure)
  return { rows, ...(failure === undefined ? {} : { failure }) }
}

/** Turn one published value into the snapshot the page renders. */
function snapshotOf(value: unknown): SquadTeamSnapshot {
  if (value === undefined) return { state: 'pending' }
  const read = readTeamValue(value)
  // A value this build cannot read is reported as no capability rather than as
  // a broken roster: the page then says live state is unavailable, which is the
  // honest reading of "the deployment and this build disagree about the shape".
  if (read === undefined) return { state: 'unavailable' }
  return { state: 'ready', rows: read.rows, ...(read.failure === undefined ? {} : { failure: read.failure }) }
}

/** The raw `agentTeam` value of one session, or undefined while it carries none. */
function projectionValue(list: SessionListFace, sessionId: string): unknown {
  const rows = list.getSnapshot().projectionsBySession
  if (rows === undefined || rows === null) return undefined
  const row = rows[sessionId]
  if (row === undefined || row === null) return undefined
  const values = row.values
  if (values === undefined || values === null) return undefined
  return values[AGENT_TEAM_PROJECTION_KEY]
}

/**
 * Read the live team from the shared session store.
 * @param list - the client session catalog's list face.
 */
export function projectionTeamSource(list: SessionListFace): SquadTeamSource {
  return {
    kind: 'projection',
    watch(sessionId: string, onChange: (snapshot: SquadTeamSnapshot) => void): () => void {
      /** Read the current value; a catalog that throws is a surface this build cannot read. */
      const read = (): { readable: boolean; value: unknown } => {
        try {
          return { readable: true, value: projectionValue(list, sessionId) }
        } catch {
          return { readable: false, value: undefined }
        }
      }
      const initial = read()
      if (!initial.readable) {
        onChange({ state: 'unavailable' })
        return () => {}
      }
      let raw = initial.value
      onChange(snapshotOf(raw))
      /** The store keeps one reference per published value, so an unchanged value is a no-op. */
      function publish(): void {
        const next = read()
        if (!next.readable || next.value === raw) return
        raw = next.value
        onChange(snapshotOf(raw))
      }
      let stop: () => void
      try {
        stop = list.subscribe(publish)
      } catch {
        return () => {}
      }
      return () => { stop() }
    },
  }
}

/**
 * Read the live team by polling the proposed read-only route.
 * @param transport - the squad transport (only its roster read is used).
 * @param intervalMs - refresh cadence; the default is the shipped one.
 */
export function pollTeamSource(
  transport: Pick<AgentsTransport, 'squadTeam'>,
  intervalMs: number = SQUAD_TEAM_POLL_INTERVAL_MS,
): SquadTeamSource {
  return {
    kind: 'poll',
    watch(sessionId: string, onChange: (snapshot: SquadTeamSnapshot) => void): () => void {
      let stopped = false
      let failures = 0
      let timer: ReturnType<typeof globalThis.setInterval> | undefined
      const stop = (): void => {
        stopped = true
        if (timer !== undefined) globalThis.clearInterval(timer)
        timer = undefined
      }
      const read = (): void => {
        void (async () => {
          try {
            const body = await transport.squadTeam(sessionId)
            if (stopped) return
            failures = 0
            onChange(snapshotOf(body))
          } catch (error) {
            if (stopped) return
            const described = failureOf(error)
            // The route is not served here: say live state is unavailable and
            // stop, instead of polling a missing route for the life of the page.
            if (described.failure === 'not-mounted') {
              onChange({ state: 'unavailable' })
              stop()
              return
            }
            if (described.failure === 'unauthorized' || described.failure === 'forbidden') {
              onChange({ state: 'error', message: described.message })
              stop()
              return
            }
            failures += 1
            if (failures >= SQUAD_TEAM_POLL_MAX_FAILURES) {
              onChange({ state: 'error', message: described.message })
              stop()
            }
          }
        })()
      }
      read()
      timer = globalThis.setInterval(read, intervalMs)
      return stop
    },
  }
}

/**
 * Pick the live-team surface for this deployment.
 * @param list - the shared session catalog face, when this context serves one.
 * @param transport - the squad transport, used by the fallback poll.
 * @returns the projection source when the session store is reachable, else the poll.
 */
export function createTeamSource(list: SessionListFace | undefined, transport: AgentsTransport): SquadTeamSource {
  return list === undefined ? pollTeamSource(transport) : projectionTeamSource(list)
}

/**
 * Read the session catalog face off whatever this deployment exposes.
 * @param sessions - the client `sessions` service, when the context carries one.
 * @returns the list face, or undefined when the service or its shape is absent.
 */
export function sessionListFace(sessions: unknown): SessionListFace | undefined {
  if (typeof sessions !== 'object' || sessions === null) return undefined
  const list = (sessions as { list?: unknown }).list
  if (typeof list !== 'object' || list === null) return undefined
  const candidate = list as { getSnapshot?: unknown; subscribe?: unknown }
  if (typeof candidate.getSnapshot !== 'function' || typeof candidate.subscribe !== 'function') return undefined
  return candidate as SessionListFace
}
