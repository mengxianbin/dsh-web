/**
 * Split a member's `provider/model` model pin into the route a session
 * selection needs. A bare model id keeps only the model, and the session's own
 * provider stays as it is — the host catalog is not consulted in M1.
 *
 * @module @linxin666/dsh-agents/core/model-pin
 */

/** One session model selection: a model id with an optional explicit provider. */
export interface ModelRoute {
  provider?: string
  model: string
}

/**
 * Read a model pin.
 * @param model - the pinned route text, or undefined/blank for no pin.
 * @returns the route, or undefined when nothing is pinned. A pin whose halves
 *   are unusable (blank provider or model beside the slash) yields undefined:
 *   a half-parsed route must not silently select something else.
 */
export function parseModelPin(model: string | undefined): ModelRoute | undefined {
  const raw = model?.trim()
  if (raw === undefined || raw === '') return undefined
  const slash = raw.indexOf('/')
  if (slash < 0) return { model: raw }
  const provider = raw.slice(0, slash).trim()
  const modelId = raw.slice(slash + 1).trim()
  if (provider === '' || modelId === '') return undefined
  return { provider, model: modelId }
}
