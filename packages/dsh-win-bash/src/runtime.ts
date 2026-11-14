/**
 * Payload resolution and load-time integrity verification for the vendored
 * bash runtime.
 *
 * The package ships its own Git for Windows MinGit extraction under
 * runtime/win32-x64/: the tool must NEVER fall back to a bash found on PATH
 * (a host Git for Windows install, WSL, or a stray MSYS), because the whole
 * point of vendoring is a shell whose version and bytes are pinned. Two
 * invariants implement that:
 *
 * 1. the binary is addressed by absolute path inside the package, and
 * 2. every vendored byte is checked against the SHA256 manifest generated at
 *    packaging time before the tool is mounted at all.
 *
 * A mismatch refuses the mount with a specific message. The alternative —
 * mounting and hoping — would let a tampered or half-installed payload run
 * model-authored commands, which is the one outcome the manifest exists to
 * prevent.
 * @module @linxin666/dsh-win-bash/runtime
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory holding the shipped payload, relative to the package root. */
export const RUNTIME_DIR = 'runtime/win32-x64'

/** Manifest file name inside {@link RUNTIME_DIR}. */
export const CHECKSUM_FILE = 'checksums.sha256'

/** The one platform this payload supports. */
export const RUNTIME_PLATFORM = 'win32'

/** The one architecture this payload supports. */
export const RUNTIME_ARCH = 'x64'

/** Absolute package root (the directory holding package.json). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Absolute payload root.
 *
 * LOCAL PATCH 2026-11-01 (m-note ruling): the three resolvers below prefer the host Git for
 * Windows usr/bin over the vendored payload — fixed absolute candidates only, never PATH —
 * with the payload as guaranteed fallback when Git for Windows is absent. See the matching
 * comment block in lib/index.js for the behaviour shifts this introduces.
 */
export function runtimeRoot(packageRoot: string = PACKAGE_ROOT): string {
  return join(packageRoot, RUNTIME_DIR)
}

/** Host Git for Windows usr/bin candidates, first hit wins. */
const HOST_GIT_USR_BIN_CANDIDATES = [
  'D:\\Program Files\\Git\\usr\\bin',
  'C:\\Program Files\\Git\\usr\\bin',
]

/** Resolve the userland dir: host Git for Windows when present, vendored payload otherwise. */
function resolveUsrBin(packageRoot: string): string {
  for (const dir of HOST_GIT_USR_BIN_CANDIDATES) {
    try {
      if (statSync(join(dir, 'bash.exe')).isFile()) return dir
    } catch {
      // absent candidate: keep looking
    }
  }
  return join(runtimeRoot(packageRoot), 'usr', 'bin')
}

/** Absolute path of the shell: host Git for Windows usr/bin when present, vendored payload otherwise. */
export function bashPath(packageRoot: string = PACKAGE_ROOT): string {
  return join(resolveUsrBin(packageRoot), 'bash.exe')
}

/** Absolute path of the POSIX-shell alias of the same binary. */
export function shPath(packageRoot: string = PACKAGE_ROOT): string {
  return join(resolveUsrBin(packageRoot), 'sh.exe')
}

/** Absolute path of the userland directory the shell leads PATH with (always the one bashPath picked). */
export function binDir(packageRoot: string = PACKAGE_ROOT): string {
  return resolveUsrBin(packageRoot)
}

/** One manifest row: a payload-relative path and its digest. */
export interface ChecksumEntry {
  /** Payload-relative path, using forward slashes. */
  readonly path: string
  /** Lowercase hex SHA256 of the file's bytes. */
  readonly sha256: string
}

/**
 * Parse a sha256sum-style manifest: '<64 hex>  <path>' per line. Blank lines
 * and '#' comments are skipped, so the file stays a valid 'sha256sum -c'
 * input while carrying a human-readable header.
 * @param text - the manifest's contents.
 * @returns parsed entries in file order.
 * @throws when a non-comment line does not match the two-column shape.
 */
export function parseChecksums(text: string): ChecksumEntry[] {
  const entries: ChecksumEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([0-9a-f]{64})\s+(\S.*)$/.exec(line)
    if (match === null) throw new Error('malformed checksum line: ' + line)
    entries.push({ sha256: match[1], path: match[2] })
  }
  return entries
}

/** One payload file whose bytes did not match the manifest. */
export interface ChecksumMismatch {
  /** Payload-relative path. */
  readonly path: string
  /** What the manifest records. */
  readonly expected: string
  /** What is on disk, or 'missing' when the file is absent. */
  readonly actual: string
}

/** Outcome of a full payload verification pass. */
export interface ChecksumReport {
  /** Registered payload files that hashed correctly. */
  readonly verified: number
  /** Every file whose bytes or presence disagreed with the manifest. */
  readonly mismatches: readonly ChecksumMismatch[]
}

/** SHA256 of a buffer or string, lowercase hex. */
export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Verify every registered payload file against the shipped manifest.
 *
 * Reads and hashes the whole payload (about 16 MiB after the curated
 * extraction), which is why callers do it once at mount time rather than per
 * command.
 * @param packageRoot - package root holding runtime/win32-x64.
 * @returns the count of verified files and every mismatch found.
 * @throws when the manifest itself is unreadable or malformed.
 */
export function verifyPayload(packageRoot: string = PACKAGE_ROOT): ChecksumReport {
  const root = runtimeRoot(packageRoot)
  const manifest = parseChecksums(readFileSync(join(root, CHECKSUM_FILE), 'utf8'))
  const mismatches: ChecksumMismatch[] = []
  let verified = 0
  for (const entry of manifest) {
    const file = join(root, ...entry.path.split('/'))
    let actual: string
    try {
      // A directory named like a manifest row must read as a mismatch, not
      // crash the mount: statSync rejects directories before any read.
      if (!statSync(file).isFile()) throw new Error('not a regular file')
      actual = sha256(readFileSync(file))
    } catch {
      actual = 'missing'
    }
    if (actual === entry.sha256) verified += 1
    else mismatches.push({ path: entry.path, expected: entry.sha256, actual })
  }
  return { verified, mismatches }
}

/** Why this deployment cannot serve the vendored shell. */
export interface RuntimeRejection {
  /** Machine-readable reason. */
  readonly code:
    | 'unsupported-platform'
    | 'unsupported-arch'
    | 'missing-binary'
    | 'checksum-mismatch'
    | 'manifest-unreadable'
  /** One-sentence, operator-facing explanation. */
  readonly message: string
}

/** Successful payload resolution. */
export interface RuntimeReady {
  /** Absolute path of the vendored bash.exe. */
  readonly bash: string
  /** Absolute path of the payload's usr/bin. */
  readonly bin: string
}

/** Whether the running host can serve this payload at all. */
export interface HostPlatform {
  /** process.platform. */
  readonly platform: string
  /** process.arch. */
  readonly arch: string
}

/**
 * Resolve the vendored shell for one host, or refuse the mount.
 *
 * The order is deliberate: platform, then architecture, then presence, then
 * integrity. A checksum failure names the first mismatching path so an
 * operator can act on it, and no path here ever consults PATH.
 * @param host - the running host's platform facts.
 * @param packageRoot - package root holding the payload.
 * @returns the resolved shell paths, or the rejection reason.
 */
export function resolveRuntime(
  host: HostPlatform,
  packageRoot: string = PACKAGE_ROOT,
): RuntimeReady | RuntimeRejection {
  if (host.platform !== RUNTIME_PLATFORM) {
    return {
      code: 'unsupported-platform',
      message:
        'win_bash requires Windows: the vendored payload is a Git for Windows MinGit build for '
        + RUNTIME_PLATFORM
        + ' and there is no PATH fallback.',
    }
  }
  if (host.arch !== RUNTIME_ARCH) {
    return {
      code: 'unsupported-arch',
      message: 'win_bash currently ships only the ' + RUNTIME_ARCH + ' payload; this host is ' + host.arch + '.',
    }
  }
  const bash = bashPath(packageRoot)
  try {
    if (!statSync(bash).isFile()) throw new Error('not a file')
  } catch {
    return {
      code: 'missing-binary',
      message: 'the vendored payload is incomplete: ' + bash + ' is missing.',
    }
  }
  let report: ChecksumReport
  try {
    report = verifyPayload(packageRoot)
  } catch (error) {
    return {
      code: 'manifest-unreadable',
      message:
        'the payload checksum manifest could not be read: '
        + (error instanceof Error ? error.message : String(error)),
    }
  }
  if (report.mismatches.length > 0) {
    const first = report.mismatches[0]
    return {
      code: 'checksum-mismatch',
      message:
        'the vendored payload failed its SHA256 manifest: '
        + report.mismatches.length.toString()
        + ' file(s) differ, first '
        + first.path
        + ' (expected '
        + first.expected.slice(0, 12)
        + ', found '
        + first.actual.slice(0, 12)
        + '). Reinstall the package; win_bash will not run an unverified payload.',
    }
  }
  return { bash, bin: binDir(packageRoot) }
}
