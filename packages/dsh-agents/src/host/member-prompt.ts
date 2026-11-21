/**
 * Member-brief injection seam (M1 spike deliverable).
 *
 * The brief of a member must become part of THAT member session's system
 * prompt, never the first user message. This module owns the whole decision and
 * is split in two so the decision is testable without a host:
 *
 * - {@link memberBriefFor} is pure: it reads the identity the assemble context
 *   exposes and answers with the brief text, or '' for every other session.
 * - {@link registerMemberPromptSeam} is the one call into the host's
 *   system-prompt registry. See docs/member-prompt.md for the evidence that the
 *   registry hands a section's text provider the assembled agent identity.
 *
 * Why the section is empty for every non-member assembly: an empty section is
 * dropped from the rendered prompt, so a deployment that never runs a member
 * keeps a system prompt byte-identical to one without this plugin.
 *
 * @module @linxin666/dsh-agents/host/member-prompt
 */
import type { RunRecord, TeamDefinition } from '../protocol.ts'

/** Section name this plugin registers. Its own namespace, never a reserved one. */
export const MEMBER_PROMPT_SECTION_NAME = 'dsh-agents:member-brief'

/** Placement used when the host cannot report the persona-prefix order. */
const DEFAULT_MEMBER_PROMPT_ORDER = 1

/** The identity a member-brief decision is made from. */
export interface AssembleIdentity {
  /** DSH session id the assembly belongs to, when the host identified one. */
  sessionId?: string
}

/** The two ledger facts a brief lookup needs. */
export interface MemberPromptView {
  teams: readonly TeamDefinition[]
  runs: readonly RunRecord[]
}

/**
 * Read the session identity out of an assemble context.
 *
 * The host passes the assembling agent on the context (`AssembleContext.agent`,
 * declared by @deepseek-ai/dsh-agent), and the live Agent's identity is its
 * `id` — the same session id the run record stores. Both spellings are read so
 * a cohort that renames the field does not silently stop injecting; an absent or
 * non-string identity yields no identity, never a guess.
 * @param context - the assemble context handed to a section text provider.
 * @returns the identity, with `sessionId` present only when the host named one.
 */
export function assembleIdentity(context: unknown): AssembleIdentity {
  if (typeof context !== 'object' || context === null) return {}
  const agent = (context as { agent?: unknown }).agent
  if (typeof agent !== 'object' || agent === null) return {}
  const fields = agent as { id?: unknown; sessionId?: unknown }
  const sessionId = typeof fields.id === 'string' && fields.id !== ''
    ? fields.id
    : typeof fields.sessionId === 'string' && fields.sessionId !== ''
      ? fields.sessionId
      : undefined
  return sessionId === undefined ? {} : { sessionId }
}

/**
 * The newest run recorded for a session.
 * @param runs - the ledger's runs, in any order.
 * @param sessionId - the session to find.
 * @returns the most recently created run for that session, when one exists.
 */
function latestRunFor(runs: readonly RunRecord[], sessionId: string): RunRecord | undefined {
  let newest: RunRecord | undefined
  for (const run of runs) {
    if (run.sessionId !== sessionId) continue
    if (newest === undefined || run.createdAt > newest.createdAt) newest = run
  }
  return newest
}

/**
 * Resolve the system-prompt text a session's assembly should carry.
 *
 * The lookup is by assemble identity only: the session must appear as a run
 * of a member that still exists and still carries a brief. Anything else —
 * an ordinary user session, a member whose brief was cleared, a run whose
 * definition was deleted — is '' and contributes nothing to the prompt.
 * @param context - the assemble context handed to a section text provider.
 * @param view - the ledger snapshot to look definitions up in.
 * @returns the member brief, or '' when this assembly is not a member run.
 */
export function memberBriefFor(context: unknown, view: MemberPromptView): string {
  const identity = assembleIdentity(context)
  if (identity.sessionId === undefined) return ''
  const run = latestRunFor(view.runs, identity.sessionId)
  if (run === undefined) return ''
  const team = view.teams.find(candidate => candidate.id === run.teamId)
  if (team === undefined) return ''
  const member = team.members.find(candidate => candidate.id === run.memberId)
  if (member === undefined) return ''
  return member.brief?.trim() ?? ''
}

/** The one host face this seam needs from `ctx.systemPrompt`. */
export interface MemberPromptRegistry {
  /**
   * Register one ordered section; the returned function disposes it.
   * @param section - name, order and the per-assembly text provider.
   */
  section(section: {
    name: string
    order: number
    text: (context: never) => string
  }): () => void
  /** The host's own placement for a named section, when it publishes one. */
  getSectionOrder?(name: 'DEPLOYMENT_PERSONA_PREFIX'): number
}

/**
 * Register the member-brief section with the host system-prompt registry.
 *
 * The section sits immediately after the deployment/preset persona so the
 * member's own brief reads as the next voice, not as a stray paragraph at the
 * end of the prompt. It is registered once per plugin mount and disposed with
 * the plugin fiber.
 * @param registry - `ctx.systemPrompt`.
 * @param readView - reads the ledger snapshot AT ASSEMBLE TIME, so a definition
 *   edited between turns is the one the next turn sees.
 * @returns the exact disposer the registry returned.
 */
export function registerMemberPromptSeam(registry: MemberPromptRegistry, readView: () => MemberPromptView): () => void {
  const personaOrder = typeof registry.getSectionOrder === 'function'
    ? registry.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
    : 0
  return registry.section({
    name: MEMBER_PROMPT_SECTION_NAME,
    order: (Number.isFinite(personaOrder) ? personaOrder : 0) + DEFAULT_MEMBER_PROMPT_ORDER,
    text: (context: never) => memberBriefFor(context, readView()),
  })
}
