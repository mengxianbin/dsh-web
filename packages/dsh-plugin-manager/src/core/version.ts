/**
 * Version parsing plus the requirement reader for the update compatibility
 * check. The declared minimum lives in the published package manifest under
 * `dsh.engines.dsh`, falling back to the top-level `engines.dsh` and then to
 * the `@deepseek-ai/dsh` peer; the range forms a manifest may use are the
 * full node-semver range grammar.
 *
 * This module is shared by both halves and therefore stays free of `semver`,
 * which is a node package: it parses and compares a single `X.Y.Z[-pre]`
 * version, which is all the browser half needs to render a declared range
 * (`displayMinimumVersion`) and all the host half needs to accept a probed
 * host version (`parseDshVersion`). The range verdict itself lives in the
 * host-only `../host/dsh-compat.ts`, which evaluates the declaration with
 * `semver.satisfies(host, range, { includePrerelease: true })` — the exact
 * call the official boot gate makes, so `||`, `^`, `~`, multi-comparator
 * and x-ranges all decide the same way here as they do at boot.
 *
 * Everything here is pure and tolerant of untrusted input: a malformed value
 * means "cannot verify", which the callers treat as a fail-closed verdict
 * when a requirement was declared (issue #754).
 * @module @linxin666/dsh-client-ui-plugin-manager/core
 */

/** One parsed DSH host or package version. */
export interface DshVersion {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers, numeric identifiers kept as numbers (semver order). */
  prerelease: readonly (number | string)[]
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/**
 * Parse a DSH host or package version string.
 * @param value - e.g. `0.1.0-rc.8`, `v1.2.3`.
 * @returns the parsed version, or undefined when malformed.
 */
export function parseDshVersion(value: string): DshVersion | undefined {
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) return undefined
  const prereleaseParts = match[4] === undefined ? [] : match[4].split('.')
  if (prereleaseParts.some(part => part === '')) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prereleaseParts.map(part => /^\d+$/.test(part) ? Number(part) : part),
  }
}

/**
 * Compare two version strings by semver order (a release is newer than any
 * prerelease of the same tuple).
 * @returns -1 / 0 / 1, or undefined when either side is malformed.
 */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseDshVersion(left)
  const b = parseDshVersion(right)
  if (a === undefined || b === undefined) return undefined
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * Semver prerelease ordering: numeric identifiers compare numerically,
 * numeric identifiers rank below alphanumeric ones, alphanumeric identifiers
 * compare lexically, and a longer list wins when the shared prefix is equal.
 */
function comparePrerelease(left: readonly (number | string)[], right: readonly (number | string)[]): number {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (typeof a === 'number' && typeof b === 'number') {
      if (a !== b) return a < b ? -1 : 1
    } else if (typeof a === 'number') {
      return -1
    } else if (typeof b === 'number') {
      return 1
    } else if (a !== b) {
      return a < b ? -1 : 1
    }
  }
  return 0
}

const MINIMUM_RANGE_PATTERN = /^>=\s*(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

/**
 * The bare minimum version for display: strips the `>=` operator (and an
 * optional leading `v`) from a declared requirement so UI copy that already
 * contains the comparison operator renders `0.1.1-rc.1` instead of
 * `>= >=0.1.1-rc.1`. Every other range form renders unchanged — the browser
 * half does not evaluate a range (the host does, in `../host/dsh-compat.ts`),
 * so it must not pull a range parser into the client bundle to shorten copy.
 * @param minimum - the declared minimum range.
 * @returns the version portion for display.
 */
export function displayMinimumVersion(minimum: string): string {
  const match = MINIMUM_RANGE_PATTERN.exec(minimum.trim())
  return match === null ? minimum.trim() : match[1].replace(/^v/, '')
}

/**
 * Read the declared DSH minimum from a published registry manifest:
 * `dsh.engines.dsh` first, top-level `engines.dsh` next, and
 * `peerDependencies["@deepseek-ai/dsh"]` last, which is where a package that
 * only declares the host as a peer still gets gated at boot.
 * Defensive against malformed or untrusted metadata: anything that is not a
 * non-empty string reads as absent.
 * @param manifest - the decoded registry version manifest.
 * @returns the declared minimum, or undefined when not declared.
 */
export function dshRequirementOf(manifest: { dsh?: unknown; engines?: unknown; peerDependencies?: unknown }): string | undefined {
  const dshEngines = (manifest.dsh as { engines?: unknown } | undefined)?.engines as { dsh?: unknown } | undefined
  const engines = (manifest.engines as { dsh?: unknown } | undefined)?.dsh
  const peers = (manifest.peerDependencies as Record<string, unknown> | undefined)?.['@deepseek-ai/dsh']
  // The host's own peer gate is the LAST word: a package that declares the
  // host only under peerDependencies still gets that row skipped at boot when
  // the floor is not met, so a requirement we display must come from the same
  // place the gate reads, or the user is told nothing and then loses the row.
  const value = dshEngines?.dsh ?? engines ?? peers
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
