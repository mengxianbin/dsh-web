/**
 * The plugin's own configuration surface. The Host validates the profile
 * patch against {@link Config} and generates the settings page of this
 * profile entry from the same schema, so the plugin registers no settings
 * section of its own.
 *
 * Every field is `volatile`: the settings subsystem projects only volatile
 * fields into an entry's form, and a write commits the new value into the
 * running plugin's references instead of remounting the row. The runtime
 * therefore reads those references live — {@link effectiveConfig} resolves
 * them at call time — and re-derives what it registered for the row when the
 * Loader announces a committed change.
 * @module @linxin666/dsh-client-ui-git-graph/host/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * Stable reference to a volatile config field — verbatim cosmokit shape
 * (`Volatile` + `VolatileSnapshot`), redeclared locally because the workspace
 * override pins cordis 4.0.2 (which does not re-export it; 4.0.5 does) and
 * cosmokit is not a direct dependency here. `get()` returns the recursively
 * readonly snapshot, which is exactly what schemastery's `.volatile()` emits,
 * so schema output stays assignable to these fields.
 */
export type VolatileSnapshot<T> = T extends object ? { readonly [K in keyof T]: VolatileSnapshot<T[K]> } : T

export interface Volatile<T> {
  get(): VolatileSnapshot<T>
}

/** Plugin config as the runtime reads it: one live reference per field. */
export interface Config {
  /** Auto-isolate every New Session of a git workspace into a fresh managed worktree. */
  autoIsolate: Volatile<boolean>
  /** Baseline for auto-created worktrees: the checkout's current HEAD or the remote default branch. */
  autoBaseline: Volatile<'current' | 'default'>
  /** Register the model-facing git_worktree tool (opt-in; off keeps git off the model-visible surface). */
  agentTool: Volatile<boolean>
}

/** Profile-patch shape of {@link Config}, before the schema turns it into live references. */
export interface ConfigInput {
  /** Auto-isolate every New Session of a git workspace into a fresh managed worktree. */
  autoIsolate?: boolean
  /** Baseline for auto-created worktrees: the checkout's current HEAD or the remote default branch. */
  autoBaseline?: 'current' | 'default'
  /** Register the model-facing git_worktree tool (opt-in; off keeps git off the model-visible surface). */
  agentTool?: boolean
}

/** Config values with schema defaults applied. */
export type ResolvedConfig = Required<ConfigInput>

/** Schemastery schema backing the profile patch values and the generated settings page. */
export const Config: z<ConfigInput, Config> = z.object({
  autoIsolate: z.boolean().default(false).volatile(),
  autoBaseline: z.union(['current', 'default'] as const).default('current').volatile(),
  agentTool: z.boolean().default(false).volatile(),
})

/**
 * Resolve the effective config with schema defaults applied. Volatile fields
 * arrive as live references, so this reads the value the settings subsystem
 * last committed rather than a snapshot taken at mount.
 * @param config - the config the Host handed to the plugin row.
 * @returns the resolved values.
 */
export function effectiveConfig(config?: Config): ResolvedConfig {
  return {
    autoIsolate: config?.autoIsolate?.get() ?? false,
    autoBaseline: config?.autoBaseline?.get() ?? 'current',
    agentTool: config?.agentTool?.get() ?? false,
  }
}
