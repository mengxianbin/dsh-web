/**
 * The public origin a phone should dial, discovered rather than asked for.
 *
 * A pairing code is far better when it carries the address too: the phone then
 * needs one scan and no typing. This module is where that address comes from,
 * in the order the family already trusts:
 *
 * 1. `DSH_REMOTE_PUBLIC_BASE_URL` — the same environment contract
 *    `dsh-remote-web-ui` reads for its own public base.
 * 2. The relay registry row `$DSH_HOME/remote-web-ui-registry/<profile>.json`,
 *    whose `id` is the stable `<id>.<relay>` subdomain that plugin registers
 *    for this profile (see its `relay-registry.ts`). Reading that row is a
 *    deliberate, documented data dependency: it is one small JSON file per
 *    profile, it is written by the machine itself, and a missing or unreadable
 *    row simply means "no origin known" rather than an error.
 *
 * Nothing here reaches the network, and nothing here mints or spends anything.
 * @module dsh-remote-bridge/host/pair-origin
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from './dsh-home.ts'

/** The relay's worker domain; a profile's stable origin is `<id>.<this>`. */
export const RELAY_DOMAIN = 'dsh-market.com'

/** The registry directory `dsh-remote-web-ui` keeps its per-profile row in. */
export const RELAY_REGISTRY_DIR = 'remote-web-ui-registry'

/** One discovered origin and the fact that produced it. */
export interface PairOriginFacts {
  /** Origin only, no path: `wss://<id>.dsh-market.com`. */
  readonly origin: string
  /** Where the answer came from, for the panel and the log. */
  readonly source: 'env' | 'registry'
}

export interface DiscoverPairOriginOptions {
  /** Environment to read; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** DSH home to look in; defaults to `resolveDshHome(env)`. */
  readonly home?: string
  /** Profile whose registry row to read; defaults to `$DSH_PROFILE` or `desktop`. */
  readonly profile?: string
}

/** Trim trailing slashes so the caller can append a path unconditionally. */
function originOf(base: string): string {
  return base.replace(/\/+$/, '')
}

/**
 * Discover the public origin of this instance.
 * @param options - environment, home and profile seams for tests.
 * @returns the origin and its source, or `undefined` when nothing is known.
 */
export function discoverPairOrigin(options: DiscoverPairOriginOptions = {}): PairOriginFacts | undefined {
  const env = options.env ?? process.env
  const configured = env.DSH_REMOTE_PUBLIC_BASE_URL?.trim()
  if (configured !== undefined && configured !== '') return { origin: originOf(configured), source: 'env' }

  const home = options.home ?? resolveDshHome(env)
  const profile = options.profile ?? env.DSH_PROFILE?.trim() ?? 'desktop'
  if (profile === '') return undefined

  let row: unknown
  try {
    row = JSON.parse(readFileSync(join(home, RELAY_REGISTRY_DIR, `${profile}.json`), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof row !== 'object' || row === null) return undefined
  const id = (row as { id?: unknown }).id
  if (typeof id !== 'string' || id === '') return undefined
  return { origin: `wss://${id}.${RELAY_DOMAIN}`, source: 'registry' }
}
