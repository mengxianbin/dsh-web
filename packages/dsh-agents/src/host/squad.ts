/**
 * The squad-run seam: which sessions belong to a whole-squad run this Host
 * started, and what the Lead is told about the squad it leads.
 *
 * Two facts put this file in charge of the M2 tool surface:
 * - The forked Team runtime answers `tryMembership` with `{ role: 'lead' }` for
 *   any root Session, so membership alone would install the Team tools into the
 *   user's everyday chat and hide the native delegation tools behind them. The
 *   ledger's squad-run records are the authority instead: a session sees the
 *   Team surface only when this Host launched it as a squad Lead (or as a
 *   teammate under that Lead).
 * - The Lead's roster must arrive as a system-prompt CONTEXT, not a section: a
 *   preset that registers a `complete` section drops every untagged section
 *   (docs/member-prompt.md), and contexts survive it.
 *
 * @module @linxin666/dsh-agents/host/squad
 */
import type { RunRecord, TeamDefinition } from '../protocol.ts'

/** Longest one-line member brief summary carried into the Lead's context. */
export const SQUAD_BRIEF_SUMMARY_LENGTH = 240

/** A squad run and the definition it launched. */
export interface SquadRunView {
  readonly run: RunRecord
  readonly team: TeamDefinition
}

/** The ledger facts these decisions read. */
export interface SquadLedgerView {
  readonly teams: readonly TeamDefinition[]
  readonly runs: readonly RunRecord[]
}

/**
 * The newest squad run recorded for one session.
 * @param sessionId - the session to look up.
 * @param view - the ledger snapshot.
 * @returns the squad run and its team, or undefined when this session leads none.
 */
export function squadRunFor(sessionId: string | undefined, view: SquadLedgerView): SquadRunView | undefined {
  if (sessionId === undefined) return undefined
  let newest: RunRecord | undefined
  for (const run of view.runs) {
    if (run.kind !== 'squad' || run.sessionId !== sessionId) continue
    if (newest === undefined || run.createdAt > newest.createdAt) newest = run
  }
  if (newest === undefined) return undefined
  const team = view.teams.find(candidate => candidate.id === newest.teamId)
  return team === undefined ? undefined : { run: newest, team }
}

/**
 * Whether one live session belongs to a squad run this Host started.
 * @param sessionId - the session's own id.
 * @param parentSessionId - its direct parent session id, when it has one.
 * @param view - the ledger snapshot.
 * @returns whether the session leads a squad run, or is a teammate under one.
 */
export function isSquadSession(
  sessionId: string | undefined,
  parentSessionId: string | undefined,
  view: SquadLedgerView,
): boolean {
  if (squadRunFor(sessionId, view) !== undefined) return true
  return parentSessionId !== undefined && squadRunFor(parentSessionId, view) !== undefined
}

/**
 * One-line, bounded member brief summary. The Lead needs to know what a member
 * is for; it does not need the whole brief re-pasted into its own prompt.
 * @param brief - the member's brief, when it has one.
 * @returns the collapsed summary, or a placeholder for a member without one.
 */
export function briefSummary(brief: string | undefined): string {
  const single = (brief ?? '').replace(/\s+/gu, ' ').trim()
  if (single === '') return 'no brief'
  return single.length > SQUAD_BRIEF_SUMMARY_LENGTH
    ? single.slice(0, SQUAD_BRIEF_SUMMARY_LENGTH - 3) + '...'
    : single
}

/**
 * The `team:squad` system-prompt context text for one assembly.
 *
 * The Lead must know who exists and what each member runs as BEFORE it spawns
 * anything: a member preset with a `complete` section drops untagged sections,
 * so the roster cannot ride a section and cannot ride the member briefs either
 * (those belong to the teammate sessions themselves).
 * @param sessionId - the assembling session id.
 * @param view - the ledger snapshot.
 * @returns the roster and goal for a squad Lead, or '' for every other session.
 */
export function squadContextText(sessionId: string | undefined, view: SquadLedgerView): string {
  const squad = squadRunFor(sessionId, view)
  if (squad === undefined) return ''
  const { run, team } = squad
  const lines = [
    'You lead the agent squad "' + team.name + '".',
    run.goal === undefined
      ? 'Squad goal: not stated yet; ask the user what the squad must achieve before splitting the work.'
      : 'Squad goal: ' + run.goal,
    '',
    'Members (' + String(team.members.length) + '):',
  ]
  for (const member of team.members) {
    lines.push('- ' + member.name
      + ' | preset ' + (member.preset ?? 'deployment default')
      + ' | permission ' + (member.permission ?? 'deployment default')
      + ' | model ' + (member.model ?? 'deployment default')
      + ' | brief: ' + briefSummary(member.brief))
  }
  lines.push(
    '',
    'Create each member with spawn_teammate and pass its preset, permission, and model so it runs exactly as defined above. A pin this Host cannot honour fails the spawn; never drop one.',
  )
  return lines.join('\n')
}
