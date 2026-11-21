/**
 * DSH home resolution for this package's Host half.
 *
 * Mirrors shared/host/dsh-home.ts (the family fact source, which every other
 * Host half receives as a generated copy through scripts/sync-shared.mjs). The
 * copy stays local on purpose: adding this package to the sync manifest edits
 * files outside packages/dsh-agents, so M1 keeps the same two-line rule here
 * and the manifest move belongs to a later change.
 *
 * @module @linxin666/dsh-agents/host/home
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The plugin-owned directory name under the DSH home. */
export const AGENTS_HOME_DIRECTORY = 'dsh-agents'

/**
 * Resolve the DSH home directory: the environment override wins, the platform
 * home fallback follows.
 * @param env - process environment to read DSH_HOME from.
 * @param home - platform home directory fallback (test seam).
 * @returns the absolute DSH home path.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = raw.trim().startsWith('~') ? join(home, raw.trim().slice(2)) : raw.trim()
    return expanded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

/**
 * The plugin-owned storage directory, resolved exactly the way the task board
 * resolves its own (`$DSH_HOME/<plugin-directory>`).
 * @param env - process environment to read DSH_HOME from.
 * @param home - platform home directory fallback (test seam).
 * @returns the absolute ledger directory.
 */
export function agentsHomeDirectory(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(resolveDshHome(env, home), AGENTS_HOME_DIRECTORY)
}
