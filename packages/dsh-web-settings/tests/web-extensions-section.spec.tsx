/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { REPOSITORY_URL, WebExtensionsSection } from '../src/client/WebExtensionsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

function entry(key: string): StoredEntry {
  return { options: { key }, component: () => null } as StoredEntry
}

const ORDER: Record<string, number> = {
  'web-ui-plugins': 100,
  'skin-center': 120,
  'pet': 130,
  'dsh-workshop': 150,
  'dsh-usage': 151,
}
const LABEL: Record<string, string> = {
  'web-ui-plugins': 'Web Plugins',
  'skin-center': 'Skins',
  'pet': 'Pet',
  'dsh-workshop': 'Workshop',
  'dsh-usage': 'Usage',
}

function makeExtensions(keys: string[]) {
  let selected = 'web-ui-plugins'
  const listeners = new Set<() => void>()
  const pages = [...keys]
    .sort((left, right) => ORDER[left] - ORDER[right])
    .map(key => ({
      key,
      order: ORDER[key],
      locale: 'test',
      label: () => LABEL[key],
      inject: () => ({}),
      component: () => null,
    }))
  const entries = pages.map(page => entry(page.key))
  return {
    sectionId: 'web-ui-plugins' as const,
    label: () => 'Web Extensions',
    open: () => true,
    registerPage: () => () => {},
    getSnapshot: () => selected,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    subscribeEntries: () => () => {},
    getEntries: () => entries,
    subscribePages: () => () => {},
    getPages: () => pages,
    select: (id: string) => { selected = id; for (const listener of listeners) listener() },
  }
}

function renderSection(keys: string[] = ['web-ui-plugins', 'skin-center', 'dsh-usage']) {
  const extensions = makeExtensions(keys)
  const renderSlot = vi.fn(() => null)
  const props = {
    t,
    close: vi.fn(),
    renderSlot,
    extensions,
  } as unknown as ComponentProps<typeof WebExtensionsSection>
  const result = render(<WebExtensionsSection {...props} />)
  return { ...result, extensions, renderSlot }
}

describe('WebExtensionsSection', () => {
  it('user sees installed pages in fixed order and only the active keyed entry', () => {
    // Given three keyed pages registered out of display order
    const { renderSlot } = renderSection(['dsh-usage', 'web-ui-plugins', 'skin-center'])
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Web Plugins', 'Skins', 'Usage'])
    expect(screen.getByRole('tab', { name: 'Web Plugins' }).getAttribute('aria-selected')).toBe('true')
    expect(renderSlot).toHaveBeenLastCalledWith('web-ui.extension', { close: expect.any(Function) }, expect.objectContaining({ entryKey: 'web-ui-plugins' }))

    // When the user selects Usage
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    // Then only that keyed page is dispatched
    expect(screen.getByRole('tab', { name: 'Usage' }).getAttribute('aria-selected')).toBe('true')
    expect(renderSlot).toHaveBeenLastCalledWith('web-ui.extension', { close: expect.any(Function) }, expect.objectContaining({ entryKey: 'dsh-usage' }))
  })

  it('user navigates TABs with arrow, Home and End keys', () => {
    // Given the Web Plugins TAB is focused
    renderSection()
    const first = screen.getByRole('tab', { name: 'Web Plugins' })
    first.focus()
    // When the user presses arrow, End and Home keys
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    // Then focus and selection move together to the expected TAB
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Skins' }))
    expect(screen.getByRole('tab', { name: 'Skins' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Skins' }), { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Usage' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Usage' }), { key: 'Home' })
    expect(first.getAttribute('aria-selected')).toBe('true')
  })

  it('user sees the section heading with the repository link at its right end', () => {
    // Given the parent with its default pages
    renderSection()
    // When it renders
    // Then the heading names the section and the link opens the repository in a new tab
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(en['extensions.title'])
    const link = screen.getByRole('link', { name: en['extensions.repository'] })
    expect(link.getAttribute('href')).toBe(REPOSITORY_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('user switching TABs sees the new page arrive from its side while a still copy leaves', () => {
    // Given the Web Plugins TAB is open
    const { container } = renderSection()
    expect(screen.getByRole('tabpanel').hasAttribute('data-enter')).toBe(false)
    // When the user presses the TAB to its right
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }))
    // Then the pressed TAB carries the strip's highlight mark
    expect(screen.getByRole('tab', { name: 'Usage' }).hasAttribute('data-active')).toBe(true)
    expect(screen.getByRole('tab', { name: 'Web Plugins' }).hasAttribute('data-active')).toBe(false)
    // And the open page arrives forward while the replaced page's copy leaves forward
    expect(screen.getByRole('tabpanel').getAttribute('data-enter')).toBe('forward')
    const still = container.querySelector('[data-leave]')
    expect(still?.getAttribute('data-leave')).toBe('forward')
    // And the copy stays out of the accessibility tree, the tab order and the id space
    expect(still?.getAttribute('aria-hidden')).toBe('true')
    expect(still?.hasAttribute('inert')).toBe(true)
    expect(still?.querySelector('[id]')).toBeNull()
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1)

    // When the user goes back to the first TAB
    fireEvent.click(screen.getByRole('tab', { name: 'Web Plugins' }))
    // Then the page arrives from the other side
    expect(screen.getByRole('tabpanel').getAttribute('data-enter')).toBe('back')
  })

  it('user sees an accessible empty state when no keyed page is installed', () => {
    // Given no installed keyed pages
    const { renderSlot } = renderSection([])
    // When the parent renders
    // Then it exposes no TAB and explains the empty panel without dispatching
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.getByText(en['extensions.unavailable']).textContent).toBe(en['extensions.unavailable'])
    expect(renderSlot).not.toHaveBeenCalled()
  })
})
