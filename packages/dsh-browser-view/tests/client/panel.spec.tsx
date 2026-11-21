// @vitest-environment jsdom
/**
 * Tab body under jsdom: the placeholder states, frame rendering, the error
 * branch, the locale switch, the toolbar (address display, connection marker,
 * refresh), the controlled browser's tab chips, the page title it publishes for
 * its own chip, and the socket lifetime.
 *
 * The body is mounted the way the right sidebar mounts it - directly, with no
 * title bar and no back control of its own, filling the height it is given.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserViewPanel } from '../../src/client/panel.tsx'
import { createLiveTitleStore } from '../../src/client/live-title.ts'
import { en, zh } from '../../src/client/locales.ts'
import { BROWSER_VIEW_API_VERSION } from '../../src/core/protocol.ts'
import type { BrowserPanelState } from '../../src/core/protocol.ts'
import { actOn, render, type RenderedTree } from './render.tsx'
import { translate } from './translate.ts'
import { createFakeSockets, type FakeSocketFixture } from './fake-socket.ts'

/** One tab as the host publishes it. */
const stateWithTab: BrowserPanelState = {
  tabs: [{ id: 'tab-1', url: 'https://example.test/checkout', title: 'Checkout', loading: false }],
  activeTabId: 'tab-1',
  running: true,
}

/** Two tabs, the first one active. */
const stateWithTwoTabs: BrowserPanelState = {
  tabs: [
    { id: 'tab-1', url: 'https://example.test/a', title: 'First', loading: false },
    { id: 'tab-2', url: 'https://example.test/b', title: 'Second', loading: true },
  ],
  activeTabId: 'tab-1',
  running: true,
}

/** Mounted tree shared by one case. */
let tree: RenderedTree | null = null
/** Fake transport fixture shared by one case. */
let sockets: FakeSocketFixture
/** Title channel shared by one case, standing in for the plugin's own. */
let channel: ReturnType<typeof createLiveTitleStore>

/** Mount the body the way the sidebar does: as tab content, with no chrome of its own. */
function mountPanel(dictionary: Record<string, string> = zh): RenderedTree {
  sockets = createFakeSockets()
  channel = createLiveTitleStore()
  const mounted = render(
    <BrowserViewPanel
      t={translate(dictionary)}
      sessionId="session-a"
      liveTitle={channel}
      socketFactory={sockets.factory}
    />,
  )
  tree = mounted
  return mounted
}

/** Query one toolbar control by its accessible name. */
function toolbarButton(mounted: RenderedTree, label: string): HTMLButtonElement | null {
  return mounted.container.querySelector(`[data-dsh-part="toolbar"] button[aria-label="${label}"]`)
}

afterEach(() => {
  tree?.unmount()
  tree = null
  document.body.innerHTML = ''
})

describe('browser view tab body', () => {
  it('user sees the empty placeholder in a tab that carries no page title bar of its own', () => {
    // Given a body mounted with nothing pushed yet
    // When it renders with the Chinese dictionary
    // Then one plugin root carries the panel part, no heading or back control is drawn, the address field is empty and the placeholder explains what will appear
    const mounted = mountPanel()

    expect(mounted.container.querySelectorAll('[data-dsh-plugin="browser-view"]')).toHaveLength(1)
    expect(mounted.container.querySelectorAll('[data-dsh-part="panel"]')).toHaveLength(1)
    expect(mounted.container.querySelector('h1,h2,h3')).toBeNull()
    const emptyField = mounted.container.querySelector('[data-dsh-part="address"] input') as HTMLInputElement
    expect(emptyField.value).toBe('')
    expect(emptyField.getAttribute('placeholder')).toBe(zh['panel.url.empty'])
    expect(mounted.container.querySelector('[data-dsh-part="trace"]')?.textContent).toContain(zh['panel.trace.idle'])
    const empty = mounted.container.querySelector('[data-dsh-part="empty"]')
    expect(empty?.textContent).toContain(zh['panel.empty.title'])
    expect(empty?.textContent).toContain(zh['panel.empty.hint'])
    expect(mounted.container.querySelector('img')).toBeNull()
  })

  it('user sees the pushed JPEG frame replace the empty placeholder', () => {
    // Given a mounted body with a state push and one JPEG frame
    // When the frame arrives over the fake socket
    // Then one image carries the data url, the frame size, the localized alt text and the frame part, and the placeholder is gone
    const mounted = mountPanel()

    actOn(() => {
      sockets.latest().pushState(stateWithTab)
      sockets.latest().pushFrame({ tabId: 'tab-1', seq: 4, width: 1280, height: 800, data: '/9j/4AAQSkZJRg==' })
    })

    const image = mounted.container.querySelector('img')
    expect(image?.getAttribute('alt')).toBe(zh['panel.frame.alt'])
    expect(image?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/4AAQSkZJRg==')
    expect(image?.getAttribute('width')).toBe('1280')
    expect(image?.getAttribute('height')).toBe('800')
    expect(mounted.container.querySelector('[data-dsh-part="empty"]')).toBeNull()
    expect(mounted.container.querySelectorAll('[data-dsh-part="frame"]')).toHaveLength(1)
  })

  it('user sees the host error instead of a stale frame', () => {
    // Given a mounted body that already painted a frame
    // When the host pushes an error code and message
    // Then the alert block carries the message and the code and no image stays on screen
    const mounted = mountPanel()

    actOn(() => {
      sockets.latest().pushState(stateWithTab)
      sockets.latest().pushFrame({ tabId: 'tab-1', seq: 1, width: 1280, height: 800, data: 'AAAA' })
      sockets.latest().pushError('chrome-missing', 'Chrome could not be started')
    })

    const error = mounted.container.querySelector('[data-dsh-part="error"]')
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.textContent).toContain(zh['panel.error.title'])
    expect(error?.textContent).toContain('Chrome could not be started')
    expect(error?.textContent).toContain('chrome-missing')
    expect(mounted.container.querySelector('img')).toBeNull()
  })

  it('user sees the message a state push substitutes for the frame', () => {
    // Given a mounted body with no frame painted
    // When a state push carries a message
    // Then the alert block shows that message and renders no error code span
    const mounted = mountPanel()

    actOn(() => {
      sockets.latest().pushState({ ...stateWithTab, message: 'The browser process exited' })
    })

    const error = mounted.container.querySelector('[data-dsh-part="error"]')
    expect(error?.getAttribute('role')).toBe('alert')
    expect(error?.querySelectorAll('span')).toHaveLength(2)
    expect(error?.textContent).toContain('The browser process exited')
  })

  it('user sees the action trace of the running tool', () => {
    // Given a mounted body with an idle trace
    // When an action trace for a click arrives
    // Then the trace region shows the tool name and its summary
    const mounted = mountPanel()

    actOn(() => {
      sockets.latest().pushAction({ tool: 'click', summary: 'Clicked the submit button', at: 1_700_000_000_000 })
    })

    const trace = mounted.container.querySelector('[data-dsh-part="trace"]')
    expect(trace?.textContent).toContain('click')
    expect(trace?.textContent).toContain('Clicked the submit button')
  })

  it('user reads the current URL of the streaming tab in a read-only address field', () => {
    // Given a mounted body and one page opened by the agent
    // When the state push names that page
    // Then the address field shows the address read-only, keeps the whole string on its title, and the empty-state hint is gone
    const mounted = mountPanel()

    actOn(() => {
      sockets.latest().pushState(stateWithTab)
    })

    const field = mounted.container.querySelector('[data-dsh-part="address"] input') as HTMLInputElement
    expect(field.value).toBe('https://example.test/checkout')
    expect(field.readOnly).toBe(true)
    expect(field.getAttribute('title')).toBe('https://example.test/checkout')
    expect(field.getAttribute('aria-label')).toBe(zh['panel.address.label'])
    expect(mounted.container.textContent).not.toContain(zh['panel.url.empty'])
  })

  it('user clicks the address field and the whole address is selected for copying', () => {
    // Given a mounted body showing one page
    // When the read-only address field is clicked
    // Then its whole value is selected, so the address is one copy gesture away
    const mounted = mountPanel()

    actOn(() => {
      sockets.latest().pushState(stateWithTab)
    })

    const field = mounted.container.querySelector('[data-dsh-part="address"] input') as HTMLInputElement
    actOn(() => { field.click() })

    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe('https://example.test/checkout'.length)
  })

  it('operator refreshes the captured frame and the host is asked for a new one', () => {
    // Given a mounted body streaming a page
    // When the refresh control is clicked
    // Then the host receives one request-frame command
    const mounted = mountPanel()

    actOn(() => {
      sockets.latest().pushState(stateWithTab)
    })

    const refresh = toolbarButton(mounted, zh['panel.toolbar.refresh'])
    expect(refresh?.disabled).toBe(false)

    actOn(() => { refresh?.click() })

    expect(sockets.latest().sent).toContainEqual({ v: BROWSER_VIEW_API_VERSION, kind: 'request-frame' })
  })

  it('operator cannot refresh before the host reported a page', () => {
    // Given a mounted body with no page
    // When the toolbar is drawn
    // Then the refresh control is disabled and clicking it sends no command
    const mounted = mountPanel()
    const refresh = toolbarButton(mounted, zh['panel.toolbar.refresh'])

    expect(refresh?.disabled).toBe(true)
    actOn(() => { refresh?.click() })

    expect(sockets.latest().sent).toEqual([])
  })

  it('user sees only the capabilities this tab has in its toolbar', () => {
    // Given a mounted body streaming a page
    // When the toolbar is drawn
    // Then its only control refreshes the captured frame - no back, forward, page reload or external-open control
    const mounted = mountPanel()

    actOn(() => {
      sockets.latest().pushState(stateWithTab)
    })

    const labels = Array.from(mounted.container.querySelectorAll('[data-dsh-part="toolbar"] button'))
      .map((button) => button.getAttribute('aria-label'))
    expect(labels).toEqual([zh['panel.toolbar.refresh']])
  })

  it('user reads the connection state of the panel in the toolbar marker', () => {
    // Given a mounted body that has not reached the host yet
    // When the socket reports an open connection and then a loading page
    // Then the marker names connecting, live and loading in turn from the existing status copy, and the product state dot follows the same three phases
    const mounted = mountPanel()
    const marker = (): string =>
      mounted.container.querySelector('[data-dsh-part="status"]')?.textContent ?? ''
    const dot = (): string | null =>
      mounted.container.querySelector('[data-dsh-part="status"] [data-state]')?.getAttribute('data-state') ?? null

    expect(marker()).toContain(zh['panel.status.connecting'])
    expect(dot()).toBe('idle')

    actOn(() => { sockets.latest().pushStatus('open') })
    expect(marker()).toContain(zh['panel.status.live'])
    expect(dot()).toBe('done')

    actOn(() => { sockets.latest().pushState(stateWithTwoTabs) })
    expect(marker()).toContain(zh['panel.status.live'])
    expect(dot()).toBe('done')

    actOn(() => {
      sockets.latest().pushState({ ...stateWithTab, tabs: [{ ...stateWithTab.tabs[0], loading: true }] })
    })
    expect(marker()).toContain(zh['panel.status.loading'])
    expect(dot()).toBe('ongoing')
  })

  it('user switches language and every string of the tab follows', () => {
    // Given a body mounted with the Chinese dictionary
    // When it re-renders with the English dictionary
    // Then the English copy is present and the Chinese one is gone
    const mounted = mountPanel(zh)
    expect(mounted.container.textContent).toContain(zh['panel.empty.title'])

    mounted.rerender(
      <BrowserViewPanel t={translate(en)} sessionId="session-a" liveTitle={channel} socketFactory={sockets.factory} />,
    )

    expect(mounted.container.textContent).toContain(en['panel.empty.title'])
    expect(mounted.container.textContent).not.toContain(zh['panel.empty.title'])
  })

  it('user clicks a tab chip and the host is asked to stream that page', () => {
    // Given a mounted body that received two pages
    // When the second chip is clicked
    // Then a select-tab command names the second page and the first chip stays the selected one
    const mounted = mountPanel()

    actOn(() => {
      sockets.latest().pushState(stateWithTwoTabs)
    })

    const tabs = mounted.container.querySelectorAll('[role="tab"]')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')

    actOn(() => { (tabs[1] as HTMLButtonElement).click() })

    expect(sockets.latest().sent).toContainEqual({ v: BROWSER_VIEW_API_VERSION, kind: 'select-tab', tabId: 'tab-2' })
  })

  it('user sees no chip row when the agent drives a single page', () => {
    // Given a mounted body streaming one page
    // When the toolbar and the body are drawn
    // Then no chip row appears, so the tab keeps the shipped browser tab's structure
    const mounted = mountPanel()

    actOn(() => {
      sockets.latest().pushState(stateWithTab)
    })

    expect(mounted.container.querySelector('[role="tablist"]')).toBeNull()
    expect(mounted.container.querySelectorAll('[data-dsh-part="panel"] > *')).toHaveLength(3)
  })

  it('user sees the chip name the page, published by the body that streams it', () => {
    // Given a mounted body whose chip channel holds nothing yet
    // When the page title arrives and the tab is later unmounted
    // Then the channel carries the page title while mounted and nothing after the tab is gone
    const mounted = mountPanel()

    actOn(() => { sockets.latest().pushState(stateWithTab) })
    expect(channel.get('session-a')).toBe('Checkout')

    mounted.unmount()
    tree = null

    expect(channel.get('session-a')).toBeUndefined()
  })

  it('operator closes the tab and the body closes its socket', () => {
    // Given a mounted body with an open connection
    // When the sidebar unmounts the tab because another chip was selected and this one was closed
    // Then that connection is closed and no socket is left behind
    const mounted = mountPanel()
    expect(sockets.sockets).toHaveLength(1)

    mounted.unmount()
    tree = null

    expect(sockets.latest().closed()).toBe(true)
  })
})
