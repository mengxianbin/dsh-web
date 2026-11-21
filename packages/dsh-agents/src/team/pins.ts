/*
 * M2 addition to the forked Agent Teams runtime (not present in
 * deepseek-harness dsh-v0.2.1-rc.2); see packages/dsh-agents/docs/fork-provenance.md.
 */
/** Member-definition pins applied to one teammate before its first prompt is checkpointed. */

import type { SpawnTeammateRequest } from './types.ts'

/**
 * The Host seam a teammate spawn applies M1 member pins through.
 *
 * Both calls happen inside {@link TeamRoster.spawn}: the preset is resolved
 * BEFORE the child activation starts, and permission and model are applied to
 * the freshly created child session BEFORE its initial prompt is checkpointed.
 * A pin the deployment cannot honour rejects here, which fails the spawn with
 * its named error instead of silently running the teammate as something else.
 */
export interface TeammatePins {
  /**
   * Resolve the pinned agent preset against the Host registry.
   * @param preset - the member's pinned preset id, or undefined for none.
   * @returns the preset id the child session must be composed from.
   */
  resolvePreset(preset: string | undefined): Promise<string | undefined>
  /**
   * Apply the pinned permission and model route to the created child session.
   * @param sessionId - the child session id minted before activation.
   * @param request - the spawn request carrying the pins.
   */
  applyToSession(sessionId: string, request: SpawnTeammateRequest): Promise<void>
}
