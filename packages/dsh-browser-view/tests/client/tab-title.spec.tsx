// @vitest-environment jsdom
/**
 * The right-sidebar chip's contents: the plugin's own name before a page is
 * streamed, the streamed page's title once the body publishes one, and the
 * localized copy following a language switch in both cases.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserViewTabTitle } from '../../src/client/tab-title.tsx'
import { createLiveTitleStore } from '../../src/client/live-title.ts'
import { en, zh } from '../../src/client/locales.ts'
import { actOn, render, type RenderedTree } from './render.tsx'
import { translate } from './translate.ts'

/** Mounted tree shared by one case. */
let tree: RenderedTree | null = null

afterEach(() => {
  tree?.unmount()
  tree = null
  document.body.innerHTML = ''
})

/** Read the chip's visible text. */
function chipText(container: HTMLElement): string {
  return container.querySelector('[data-dsh-part="tab-title"]')?.textContent ?? ''
}

describe('browser view tab chip', () => {
  it('user sees the plugin own name on a chip whose body has published no page title', () => {
    // Given a chip for a session whose body has published nothing
    // When it renders with the Chinese dictionary
    // Then it carries the plugin attribute and the localized name, and draws the browser mark once
    const channel = createLiveTitleStore()
    const mounted = render(<BrowserViewTabTitle t={translate(zh)} sessionId="session-a" liveTitle={channel} />)
    tree = mounted

    const chip = mounted.container.querySelector('[data-dsh-part="tab-title"]')
    expect(chip?.getAttribute('data-dsh-plugin')).toBe('browser-view')
    expect(chipText(mounted.container)).toContain(zh['tab.title'])
    expect(mounted.container.querySelectorAll('svg')).toHaveLength(1)
  })

  it('user sees the page title the body streams once it is published', () => {
    // Given a mounted chip showing the plugin name
    // When the tab body publishes the page title
    // Then the chip swaps the plugin name for that title
    const channel = createLiveTitleStore()
    const mounted = render(<BrowserViewTabTitle t={translate(zh)} sessionId="session-a" liveTitle={channel} />)
    tree = mounted

    actOn(() => { channel.set('session-a', 'Checkout') })

    expect(chipText(mounted.container)).toContain('Checkout')
    expect(chipText(mounted.container)).not.toContain(zh['tab.title'])
  })

  it('user switches language and the chip name follows while no page title is published', () => {
    // Given a chip mounted with the Chinese dictionary and no published title
    // When it re-renders with the English dictionary
    // Then the English name replaces the Chinese one
    const channel = createLiveTitleStore()
    const mounted = render(<BrowserViewTabTitle t={translate(zh)} sessionId="session-a" liveTitle={channel} />)
    tree = mounted

    mounted.rerender(<BrowserViewTabTitle t={translate(en)} sessionId="session-a" liveTitle={channel} />)

    expect(chipText(mounted.container)).toContain(en['tab.title'])
    expect(chipText(mounted.container)).not.toContain(zh['tab.title'])
  })

  it('user switches language while a page title is published and the page title keeps the chip', () => {
    // Given a chip whose session published a page title under one language
    // When the dictionary changes
    // Then the chip still names the page, because a real page title outranks the plugin name
    const channel = createLiveTitleStore()
    const mounted = render(<BrowserViewTabTitle t={translate(zh)} sessionId="session-a" liveTitle={channel} />)
    tree = mounted
    actOn(() => { channel.set('session-a', 'Checkout') })

    mounted.rerender(<BrowserViewTabTitle t={translate(en)} sessionId="session-a" liveTitle={channel} />)

    expect(chipText(mounted.container)).toContain('Checkout')
    expect(chipText(mounted.container)).not.toContain(en['tab.title'])
  })
})
