/** @vitest-environment jsdom */
/**
 * The LAN status lines on the settings card. The card used to derive "LAN
 * access is on" from a managed block host; issue #1917 deleted that block and
 * put a runtime forwarder on the LAN edge, so these specs hold the card to what
 * the status frame now reports: the address the forwarder listens on, the host
 * process's own listener beside it, why the edge is down (the operator's --host
 * took the port, or no LAN address exists), the bind failure verbatim, and the
 * one-time cleanup of the block an older version wrote. Every assertion reads
 * the rendered text, not the frame.
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLanHost, type LanBindFrame } from '../src/client/pair-api.ts'
import { LanBindStatus } from '../src/client/RemoteSettingsCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** English dictionary translate stub with {param} interpolation. */
const t: Parameters<typeof LanBindStatus>[0]['t'] = (key, params) => {
  let text = (en as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** The copy the assertions name, kept beside the dictionary they come from. */
const COPY = {
  entry: 'LAN entry: 192.168.1.5:3080',
  localBind: 'Host process listening: 127.0.0.1:3080',
  urls: 'LAN URLs: http://192.168.1.5:3080',
  off: 'Currently localhost-only.',
  untouched: 'The toggle has never been used',
  pendingRestart: 'The bind change takes effect after dsh web restarts.',
  noLanAddress: 'the forwarder has nothing to listen on',
  forwardError: 'The LAN entry did not come up (EADDRINUSE: address already in use); the loopback entry is unaffected.',
  yield: 'The LAN forwarder yields',
  legacyRemoved: 'Removed the bind block an older version wrote',
} as const

/**
 * One status frame as the loopback endpoint serves it.
 * @param overrides - the fields this test pins.
 */
function frame(overrides: Partial<LanBindFrame>): LanBindFrame {
  return {
    profile: 'web',
    setting: true,
    blockHost: null,
    bindHost: '192.168.1.5',
    localBindHost: '127.0.0.1',
    port: 3080,
    lanUrls: ['http://192.168.1.5:3080'],
    firewall: { ok: true, managed: true },
    platform: 'win32',
    ...overrides,
  }
}

/**
 * Answer the loopback-only status read with one frame and render the block.
 * @param frameValue - the frame the host reports.
 * @returns the text content of the rendered block, every line in order.
 */
async function renderStatus(frameValue: LanBindFrame): Promise<string> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(frameValue), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))
  const view = render(<LanBindStatus t={t} />)
  await waitFor(() => { expect(view.container.textContent).toContain('LAN entry:') })
  return view.container.textContent ?? ''
}

describe('isLanHost', () => {
  it('operator: an address another device can dial counts as LAN access', () => {
    // Given the literals a listener may take: the legacy wildcard (hosts that
    // still accept it) and a concrete interface address of this machine.
    // When the card asks whether each reaches the network.
    // Then both are LAN access.
    expect(isLanHost('0.0.0.0')).toBe(true)
    expect(isLanHost('192.168.1.5')).toBe(true)
  })

  it('operator: a loopback or empty literal is not LAN access', () => {
    // Given the loopback literals and the shapes an unset frame carries.
    // When the card asks whether each reaches the network.
    // Then none of them counts, so the card keeps the localhost-only line.
    expect(isLanHost('::1')).toBe(false)
    expect(isLanHost('localhost')).toBe(false)
    expect(isLanHost('127.0.0.1')).toBe(false)
    expect(isLanHost('')).toBe(false)
    expect(isLanHost(undefined)).toBe(false)
  })
})

describe('LanBindStatus', () => {
  it('operator: a listening forwarder shows the LAN address and the loopback listener beside it', async () => {
    // Given a forwarder answering on this machine LAN address while the host
    // process itself listens on loopback.
    // When the card renders the live facts.
    // Then the address a phone dials is on screen, the loopback listener is
    // named separately, and no "localhost-only" line is drawn.
    const text = await renderStatus(frame({
      forward: { listening: true, host: '192.168.1.5', port: 3080, reason: null, error: null },
    }))
    expect(text).toContain(COPY.entry)
    expect(text).toContain(COPY.localBind)
    expect(text).toContain(COPY.urls)
    expect(text).not.toContain(COPY.off)
  })

  it('operator: a forwarder bind failure names the cause and spares the loopback entry', async () => {
    // Given a forwarder that could not take its address, so the LAN edge is
    // down while the host process still answers on loopback.
    // When the card renders the live facts.
    // Then the bind error is shown verbatim together with the plain statement
    // that the loopback entry is unaffected, and the card still reports the
    // loopback-only reality instead of implying LAN access works.
    const text = await renderStatus(frame({
      bindHost: '127.0.0.1',
      lanUrls: [],
      forward: { listening: false, host: null, port: null, reason: null, error: 'EADDRINUSE: address already in use' },
    }))
    expect(text).toContain(COPY.forwardError)
    expect(text).toContain('the loopback entry is unaffected')
    expect(text).toContain(COPY.off)
  })

  it('operator: a forwarder that yielded to --host explains why it holds no port', async () => {
    // Given an operator who bound the network address with --host, so the
    // forwarder stands down instead of fighting for the same port.
    // When the card renders the live facts.
    // Then the card says the forwarder yielded, names the address the operator
    // bound, and still shows the reachable LAN URLs.
    const text = await renderStatus(frame({
      bindHost: '192.168.1.5',
      localBindHost: '192.168.1.5',
      forward: { listening: false, host: null, port: null, reason: 'host-bind', error: null },
    }))
    expect(text).toContain(COPY.yield)
    expect(text).toContain('--host')
    expect(text).toContain('192.168.1.5')
    expect(text).toContain(COPY.urls)
  })

  it('operator: a host-less machine explains the LAN entry never came up', async () => {
    // Given the toggle on and a machine whose LAN addresses are all
    // unadvertisable, so the forwarder has nothing to listen on.
    // When the card renders the live facts.
    // Then the card names that reason and keeps the localhost-only line,
    // because the live edge really is loopback.
    const text = await renderStatus(frame({
      bindHost: '127.0.0.1',
      lanUrls: [],
      lanBlocked: true,
      supportedHosts: [],
      forward: { listening: false, host: null, port: null, reason: 'no-address', error: null },
    }))
    expect(text).toContain(COPY.noLanAddress)
    expect(text).toContain(COPY.off)
  })

  it('operator: an untouched toggle names the untouched state, not a blocked one', async () => {
    // Given a profile whose toggle was never flipped, so the forwarder stays
    // off by policy rather than by failure.
    // When the card renders the live facts.
    // Then the localhost-only line and the untouched hint show, and no failure
    // claim is made.
    const text = await renderStatus(frame({
      setting: null,
      bindHost: '127.0.0.1',
      localBindHost: '127.0.0.1',
      lanUrls: [],
      forward: { listening: false, host: null, port: null, reason: 'off', error: null },
    }))
    expect(text).toContain(COPY.off)
    expect(text).toContain(COPY.untouched)
    expect(text).not.toContain(COPY.noLanAddress)
    expect(text).not.toContain(COPY.yield)
  })

  it('operator: the cleaned-up legacy block is reported once and never again', async () => {
    // Given a process that removed the bind block an older version wrote.
    // When the card renders the live facts beside a working forwarder.
    // Then the cleanup is stated in plain words, so the user knows the old
    // block is gone and will not come back.
    const text = await renderStatus(frame({
      legacyBlockRemoved: true,
      forward: { listening: true, host: '192.168.1.5', port: 3080, reason: null, error: null },
    }))
    expect(text).toContain(COPY.legacyRemoved)
    expect(text).toContain('never written again')
    expect(text).toContain(COPY.entry)
  })

  it('operator: an older host half renders without the fields it never sent', async () => {
    // Given a host half that predates the forwarder fields, so the frame
    // carries no forward state and no local bind.
    // When the card renders the live facts.
    // Then it still shows the reachable URLs and claims no failure.
    const text = await renderStatus(frame({ blockHost: '0.0.0.0', bindHost: '0.0.0.0' }))
    expect(text).toContain(COPY.urls)
    expect(text).not.toContain(COPY.off)
    expect(text).not.toContain(COPY.noLanAddress)
    expect(text).not.toContain(COPY.forwardError)
  })

  it('operator: a pending restart is still reported when a legacy frame asks for it', async () => {
    // Given a legacy frame whose running bind has not caught up with the
    // toggle yet.
    // When the card renders the live facts.
    // Then the URLs are shown together with the pending-restart line.
    const text = await renderStatus(frame({ desiredHost: '192.168.1.5', pendingRestart: true }))
    expect(text).toContain(COPY.urls)
    expect(text).toContain(COPY.pendingRestart)
  })
})
