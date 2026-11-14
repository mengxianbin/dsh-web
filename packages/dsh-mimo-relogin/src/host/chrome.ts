/**
 * The "open the login window" action: attach to the chrome-debug instance
 * when it already runs (one new tab via CDP), otherwise launch the dedicated
 * debug Chrome (own profile, port 9224 by convention) straight at the
 * platform. Launching with an existing same-profile instance delegates to
 * that process (one tab), so a double click never spawns a second browser.
 * @module dsh-mimo-relogin/host/chrome
 */
import { spawn } from 'node:child_process'
import { cdpAlive, openTab } from './cdp.ts'

/** How long a cold Chrome launch gets before the page reports it as merely starting. */
const LAUNCH_WAIT_MS = 10_000
const LAUNCH_POLL_MS = 400

/** Options the open action reads from plugin config. */
export interface WindowOptions {
  /** Chrome executable (config `chromePath`). */
  chromePath: string
  /** Dedicated profile directory (config `chromeProfile`) — keeps the debug window separate from the daily browser. */
  profile: string
  /** CDP port (config `cdpPort`). */
  port: number
  /** Platform URL to land on (config `platformUrl`). */
  platformUrl: string
}

/** Outcome of the open action: which mode happened, and whether the port is up yet. */
export interface OpenOutcome {
  /** `tab` = existing debug window got a new tab; `launched` = we started the browser; `failed` = spawn refused. */
  mode: 'tab' | 'launched' | 'failed'
  /** Whether the debug port answered within the wait window (tab mode: always true). */
  ready: boolean
  /** Failure detail for `failed`. */
  error?: string
}

/**
 * Ensure a debug window shows the platform and report how it went.
 * @param options - window/config options.
 * @returns the mode plus readiness (the page polls status until ready).
 */
export async function ensurePlatformWindow(options: WindowOptions): Promise<OpenOutcome> {
  if (await cdpAlive(options.port)) {
    try {
      await openTab(options.port, options.platformUrl)
      return { mode: 'tab', ready: true }
    } catch (error) {
      return { mode: 'failed', ready: false, error: `CDP tab open failed: ${String(error)}` }
    }
  }
  let child
  try {
    child = spawn(options.chromePath, [
      `--remote-debugging-port=${options.port}`,
      `--user-data-dir=${options.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      options.platformUrl,
    ], { detached: true, stdio: 'ignore' })
  } catch (error) {
    return { mode: 'failed', ready: false, error: String(error) }
  }
  // A launch that never opens a window surfaces through the readiness poll.
  child.on('error', () => { /* surfaced by the poll below */ })
  child.unref()
  const deadline = Date.now() + LAUNCH_WAIT_MS
  while (Date.now() < deadline) {
    if (await cdpAlive(options.port)) return { mode: 'launched', ready: true }
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS))
  }
  // The window may still be warming (first run on a cold profile); the page
  // keeps polling status, so report the launch without readiness rather than
  // failing an action that likely worked.
  return { mode: 'launched', ready: false }
}
