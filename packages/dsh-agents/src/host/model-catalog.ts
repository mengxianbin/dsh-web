/**
 * The Host's model catalog, as the member form's two pickers need it.
 *
 * One read through the same gateway face a run's model pin is applied through
 * (`session/modelCatalog` — the reply the task board's runner already reads),
 * and one normalization: the browser is handed routes it can pin plus the
 * reasoning levels each route declares, never the raw adapter reply.
 *
 * Absence is a first-class answer. A deployment that serves no catalog, or one
 * whose reply holds no usable route, answers undefined here and the state view
 * then omits the fields entirely: an empty array would read as "no model exists
 * on this machine", which is a different and much worse statement than "this
 * Host publishes no catalog".
 *
 * @module @linxin666/dsh-agents/host/model-catalog
 */
import type { AgentsModelOption } from '../protocol.ts'
import type { MemberRunGateway } from './run-gateway.ts'

/** One qualified model route. */
export interface AgentsModelRoute {
  provider: string
  model: string
}

/** What the state view publishes about models: the routes and the levels they declare. */
export interface AgentsModelCatalog {
  /** One row per route, in catalog order, without duplicates. */
  models: readonly AgentsModelOption[]
  /** Every level the offered models declare, first-seen order. */
  efforts: readonly string[]
  /**
   * The route this deployment composes new sessions from, when the catalog
   * states one. Host-internal: the browser never sees it, because the only
   * caller is the Host's own description call.
   */
  defaultRoute?: AgentsModelRoute
}

/**
 * The route a Host-side model call should use: the catalog's own default, or
 * the first route the catalog offers.
 * @param catalog - the catalog, when this deployment publishes one.
 * @returns the route, or undefined when nothing is offered.
 */
export function preferredModelRoute(catalog: AgentsModelCatalog | undefined): AgentsModelRoute | undefined {
  if (catalog === undefined) return undefined
  if (catalog.defaultRoute !== undefined) return catalog.defaultRoute
  const first = catalog.models[0]
  return first === undefined ? undefined : { provider: first.provider, model: first.model }
}

/** A plain JSON object, or undefined for anything else (including arrays). */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The level ids one model's reasoning block declares, in catalog order.
 * @param reasoning - the model's `reasoning` block.
 * @returns the ids, empty when the block publishes no usable one.
 */
function effortIds(reasoning: Record<string, unknown>): string[] {
  const ids: string[] = []
  for (const entry of Array.isArray(reasoning.efforts) ? reasoning.efforts : []) {
    const id = text(record(entry)?.id)
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Normalize a `session/modelCatalog` reply into picker rows.
 *
 * A model published with a `reasoning` block carries the levels it declares —
 * possibly none, which is a statement about that model; a model published
 * without one carries no `efforts` key at all, which is the catalog declining to
 * describe it. The picker must not confuse the two, so neither does this.
 * @param value - the raw catalog reply.
 * @returns the catalog, or undefined when the reply holds no usable route.
 */
export function readModelCatalog(value: unknown): AgentsModelCatalog | undefined {
  const groups = record(value)?.groups
  const models: AgentsModelOption[] = []
  const efforts: string[] = []
  const offered = new Set<string>()
  for (const entry of Array.isArray(groups) ? groups : []) {
    const group = record(entry)
    if (group === undefined) continue
    // The wire names the provider `id`; `provider` is read too so a reply that
    // states the qualified name instead normalizes the same way.
    const provider = text(group.id) ?? text(group.provider)
    if (provider === undefined) continue
    for (const item of Array.isArray(group.models) ? group.models : []) {
      const model = record(item)
      const id = text(model?.id)
      if (model === undefined || id === undefined) continue
      const route = provider + '/' + id
      if (offered.has(route)) continue
      offered.add(route)
      const reasoning = record(model.reasoning)
      const declared = reasoning === undefined ? undefined : effortIds(reasoning)
      for (const level of declared ?? []) {
        if (!efforts.includes(level)) efforts.push(level)
      }
      const label = text(model.name)
      models.push({
        provider,
        model: id,
        ...(label === undefined ? {} : { label }),
        ...(declared === undefined ? {} : { efforts: declared }),
      })
    }
  }
  const fallback = record(record(value)?.default)
  const defaultProvider = text(fallback?.provider)
  const defaultModel = text(fallback?.model)
  if (models.length === 0) return undefined
  return {
    models,
    efforts,
    ...(defaultProvider === undefined || defaultModel === undefined ? {} : { defaultRoute: { provider: defaultProvider, model: defaultModel } }),
  }
}

/**
 * The catalog this deployment serves, read through the gateway face a run's
 * model pin is applied through.
 *
 * A deployment that serves no catalog — no gateway, an unmatched namespace, a
 * reply that fails — answers undefined instead of throwing, exactly like the
 * preset list beside it: the panel has to keep rendering either way.
 * @param gateway - the run gateway, whose `modelCatalog` face is optional.
 * @returns the catalog, or undefined when this deployment publishes none.
 */
export async function listOfferedModelCatalog(gateway: Pick<MemberRunGateway, 'modelCatalog'>): Promise<AgentsModelCatalog | undefined> {
  const read = gateway.modelCatalog
  if (read === undefined) return undefined
  try {
    return readModelCatalog(await read.call(gateway))
  } catch {
    // A catalog read that throws is a catalog this deployment does not serve.
    return undefined
  }
}
