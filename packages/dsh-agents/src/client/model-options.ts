/**
 * The two pickers of the member form: which model routes this Host published,
 * and which reasoning levels each route declares.
 *
 * Both fields read ONE catalog — the `models`/`efforts` pair of `GET /state` — so
 * the form can never offer a route or a level the Host did not publish. The
 * member's own stored pin is the deliberate exception: a value already stored
 * stays selectable and is labelled as unlisted, because a pin that silently
 * disappears from its own field is a pin the next save drops.
 */
import { t } from './locales.ts'
import type { AgentsModelOption, AgentsStateView } from '../protocol.ts'

/** One row of either picker: the value a pin stores and the text the select shows. */
export interface PickRow {
  /** The exact value stored; the inherit choice is '' and is never a row here. */
  value: string
  label: string
}

/**
 * The model catalog the Host published.
 * @returns the rows, or undefined when the Host published none — an empty list
 *   is treated as none, so a picker never renders as "no model exists here".
 */
export function modelsOf(state: AgentsStateView): readonly AgentsModelOption[] | undefined {
  return Array.isArray(state.models) && state.models.length > 0 ? state.models : undefined
}

/** The deployment-wide level list the Host published, under the same empty-is-none rule. */
export function effortsOf(state: AgentsStateView): readonly string[] | undefined {
  return Array.isArray(state.efforts) && state.efforts.length > 0 ? state.efforts : undefined
}

/** The `provider/model` route one catalog row pins. */
function routeOf(model: AgentsModelOption): string {
  return model.provider + '/' + model.model
}

/** Append one row, skipping the inherit value and any value already listed. */
function pushRow(rows: PickRow[], value: string, label: string): void {
  if (value === '' || rows.some(row => row.value === value)) return
  rows.push({ value, label })
}

/**
 * The rows of the model picker: every route the catalog offers, in catalog
 * order, keyed by the route a pin stores.
 *
 * A stored pin the catalog no longer lists is appended and labelled instead of
 * dropped: the member keeps the pin it has, the user can see what it is, and
 * choosing the inherit row is how it goes away.
 * @param models - the catalog rows.
 * @param pinned - the member's stored route, '' for no pin.
 * @returns the rows, without the inherit choice the caller renders first.
 */
export function modelRows(models: readonly AgentsModelOption[], pinned: string): PickRow[] {
  const rows: PickRow[] = []
  for (const model of models) {
    const route = routeOf(model)
    pushRow(rows, route, model.label ?? route)
  }
  pushRow(rows, pinned, pinned + t('form.modelUnlisted'))
  return rows
}

/**
 * The model's own reasoning declaration, when the catalog describes this route.
 * @returns the declared levels — possibly none — or undefined when the catalog
 *   says nothing about the route (unpinned, or no longer listed).
 */
function declaredLevels(models: readonly AgentsModelOption[] | undefined, pinned: string): readonly string[] | undefined {
  return models?.find(model => routeOf(model) === pinned)?.efforts
}

/**
 * The levels the effort picker may offer for one model.
 *
 * A route the catalog describes speaks for itself: its own declared levels, or
 * none at all. A route it does not describe falls back to the deployment-wide
 * list the Host published — still the Host's own list, never one made up here.
 * @param models - the catalog rows, when the Host published any.
 * @param efforts - the deployment-wide levels, when the Host published any.
 * @param pinned - the model route currently chosen, '' for no pin.
 * @returns the level ids to offer, in catalog order.
 */
export function effortLevels(
  models: readonly AgentsModelOption[] | undefined,
  efforts: readonly string[] | undefined,
  pinned: string,
): readonly string[] {
  return declaredLevels(models, pinned) ?? efforts ?? []
}

/**
 * Whether the catalog described this route and found no level in it — the one
 * state where the picker says "none" instead of offering levels.
 * @param models - the catalog rows, when the Host published any.
 * @param pinned - the model route currently chosen, '' for no pin.
 */
export function modelDeclaresNoLevels(models: readonly AgentsModelOption[] | undefined, pinned: string): boolean {
  const declared = declaredLevels(models, pinned)
  return declared !== undefined && declared.length === 0
}

/**
 * The rows of the effort picker, with a stored level the offered list does not
 * contain kept and labelled instead of dropped.
 * @param levels - the levels to offer.
 * @param pinned - the member's stored level, '' for the model default.
 */
export function effortRows(levels: readonly string[], pinned: string): PickRow[] {
  const rows: PickRow[] = []
  for (const level of levels) pushRow(rows, level, level)
  pushRow(rows, pinned, pinned + t('form.effortUnlisted'))
  return rows
}
