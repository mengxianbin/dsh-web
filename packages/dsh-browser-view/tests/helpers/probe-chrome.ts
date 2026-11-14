/**
 * Real-chain probe: proves the host half against an actual Chrome, once.
 *
 * The unit tests fake the transport on purpose, which leaves one question
 * unanswered: does this code speak real CDP? This script answers it end to end
 * — launch, navigate, snapshot, screenshot, console, dispose — and prints the
 * evidence. It is a script, not a test file, so `vitest run` never picks it up
 * (a Chrome launch does not belong in the default suite).
 *
 * Run it with Node's own type stripping:
 *
 *   node tests/helpers/probe-chrome.ts
 *
 * It always disposes the browser, including on failure, so no process is left
 * behind.
 *
 * @module tests/helpers/probe-chrome
 */

import { stat } from 'node:fs/promises'
import { ChromeProcess } from '../../src/core/chrome.ts'
import { CdpClient } from '../../src/core/cdp.ts'
import { TabManager } from '../../src/core/tabs.ts'
import { buildSnapshot } from '../../src/core/snapshot.ts'
import { clickElement, pressKey, typeText } from '../../src/core/actions.ts'
import { waitUntil } from './wait.ts'

/**
 * Poll until the temp profile directory is gone.
 *
 * Removal is asynchronous on Windows: the killed child releases its handles
 * after the kill returns, so probing the directory once would race it.
 * @param dir - the temp profile the launch created.
 * @throws Error naming the path once the bound elapses.
 */
async function waitForProfileRemoval(dir: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (await stat(dir).then(() => true).catch(() => false)) {
    if (Date.now() >= deadline) {
      throw new Error('timed out after 5000 ms waiting for the temp profile to be removed: ' + dir)
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
  }
}

/** The page the probe drives; the console line is what the ring must capture. */
const PAGE = 'data:text/html,<h1>ok</h1><button onclick="console.log(\'clicked\')">go</button><script>console.log("probe-log")</script>'

/** A second document that logs nothing, used to prove the buffers reset. */
const SECOND_PAGE = 'data:text/html,<h1>second</h1>'

/** Print one labelled fact as a single JSON line. */
function report(label: string, value: unknown): void {
  console.log(`${label}: ${JSON.stringify(value)}`)
}

/** Fail loudly, so the exit code carries the verdict. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`probe assertion failed: ${message}`)
}

/** Whether a pid is still alive. */
function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const started = Date.now()
  let chrome: ChromeProcess | undefined
  let cdp: CdpClient | undefined
  let tabs: TabManager | undefined

  try {
    chrome = await ChromeProcess.launch()
    report('chrome.path', chrome.info.chromePath)
    report('chrome.port', chrome.info.port)
    report('chrome.pid', chrome.info.pid)
    report('chrome.launchMs', Date.now() - started)

    cdp = await CdpClient.connect(chrome.info.webSocketDebuggerUrl)
    const frames: string[] = []
    tabs = new TabManager({
      transport: cdp,
      onFrame: frame => frames.push(`${frame.tabId}#${frame.seq}:${frame.data.length}b`),
    })
    const live = tabs

    const tab = await live.createTab()
    report('tab.created', tab.id)

    const navigated = await live.navigate(tab.id, PAGE)
    report('tab.url', navigated.url)
    report('tab.loading', navigated.loading)

    const snapshot = await buildSnapshot(cdp, tab.id, live.sessionOf(tab.id), { url: navigated.url, title: navigated.title })
    live.setSnapshotRefs(tab.id, snapshot.refs)
    const heading = snapshot.snapshot.nodes.find(node => node.tag === 'h1')
    report('snapshot.nodes', snapshot.snapshot.nodes.length)
    report('snapshot.h1', heading?.text ?? null)
    report('snapshot.truncated', snapshot.snapshot.truncated)
    assert(heading !== undefined, 'the snapshot must contain the h1 element')
    assert(heading.text === 'ok', 'the h1 element must carry the page text')
    assert(snapshot.refs.size === snapshot.snapshot.nodes.length, 'every node needs a reusable ref')

    const shot = await live.captureScreenshot(tab.id)
    const bytes = Buffer.from(shot, 'base64')
    report('screenshot.base64Length', shot.length)
    report('screenshot.bytes', bytes.byteLength)
    report('screenshot.jpegMagic', bytes.subarray(0, 3).toString('hex'))
    assert(bytes.byteLength > 1_000, 'the screenshot must be real bytes, not an empty frame')
    assert(bytes[0] === 0xff && bytes[1] === 0xd8, 'the screenshot must start with the JPEG signature')

    await live.refreshFrame(tab.id)
    report('frame.emitted', frames.at(-1) ?? null)
    assert(frames.length > 0, 'the panel must receive a frame after an action')

    const consoleEntries = live.consoleEntries(tab.id)
    report('console.entries', consoleEntries.map(entry => `${entry.level}:${entry.text}`))
    assert(consoleEntries.some(entry => entry.text.includes('probe-log')), 'the console ring must capture the page log')

    // Exercise the input path against the real browser: the button's own
    // onclick handler is what proves a trusted click actually landed.
    const buttonRef = snapshot.snapshot.nodes.find(node => node.tag === 'button')?.ref
    assert(buttonRef !== undefined, 'the snapshot must contain the button')
    await clickElement({ transport: cdp, tabs: live }, tab.id, { ref: buttonRef })
    const afterClick = live.consoleEntries(tab.id)
    report('click.console', afterClick.map(entry => entry.text).slice(-2))
    assert(afterClick.some(entry => entry.text.includes('clicked')), 'the trusted click must fire the page handler')

    await typeText({ transport: cdp, tabs: live }, tab.id, 'hello', { selector: 'h1' })
    await pressKey({ transport: cdp, tabs: live }, tab.id, 'Enter')
    report('input.dispatched', 'type + Enter')

    // A second document must not inherit the first page's observations: the
    // console read after navigating away is evidence about the new page only.
    const beforeNavigation = live.consoleEntries(tab.id)
    assert(beforeNavigation.length > 0, 'the first page must log before the probe navigates away')
    await live.navigate(tab.id, SECOND_PAGE)
    const afterNavigation = live.consoleEntries(tab.id)
    report('navigation.consoleBefore', beforeNavigation.map(entry => entry.text))
    report('navigation.consoleAfter', afterNavigation.map(entry => entry.text))
    assert(afterNavigation.length === 0, 'the console ring must be empty for the new document')

    // A second tab really opens over CDP, not just in the tab manager's map.
    const secondTab = await live.createTab()
    report('tabs.afterCreate', live.list().map(candidate => candidate.id))
    assert(live.list().length === 2, 'a second tab must open')
    await live.closeTab(secondTab.id)
    assert(live.list().length === 1, 'closing the second tab must leave the first one open')

    report('network.entries', live.networkEntries(tab.id).length)
  } finally {
    // Cleanup runs even when an assertion above failed: a probe that leaks a
    // headless Chrome would be worse than a red result.
    if (tabs !== undefined) await tabs.dispose().catch(() => undefined)
    if (cdp !== undefined) cdp.close()
    if (chrome !== undefined) {
      const pid = chrome.info.pid
      const userDataDir = chrome.info.userDataDir
      await chrome.dispose()
      // Wait for the two facts instead of sleeping on them: a fixed grace is
      // either short under load (flaky) or paid on every run.
      await waitUntil('the Chrome process to exit', () => !isAlive(pid), 5_000)
      await waitForProfileRemoval(userDataDir)
      report('dispose.pidAlive', isAlive(pid))
      report('dispose.profileExists', await stat(userDataDir).then(() => true).catch(() => false))
      assert(!isAlive(pid), 'the Chrome process must be gone after dispose')
      assert(!(await stat(userDataDir).then(() => true).catch(() => false)), 'the temp profile must be removed after dispose')
    }
  }

  report('probe.durationMs', Date.now() - started)
  console.log('PROBE OK')
}

await main()
