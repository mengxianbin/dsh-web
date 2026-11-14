/** @vitest-environment jsdom */

/**
 * The Web Plugins TAB contract: the strip above already names the page, so it
 * opens on two labelled groups — General with the telemetry row, Plugins with
 * every family plugin card rendered through the child slot (no disclosure fold).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { WebUIPluginsSection } from '../src/client/WebUIPluginsCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * English translate stub (same shape the sibling settings-card tests use).
 * Reads from the published dictionary and falls back to the key.
 */
const t = (key: string): string => (en as Record<string, string>)[key] ?? key

describe('WebUIPluginsSection', () => {
  it('user sees the General and Plugins groups with the telemetry row and the family cards', () => {
    // Given the Web Plugins TAB with a slot that renders the family cards
    const renderSlot = vi.fn(() => null)
    const props = { t, renderSlot } as ComponentProps<typeof WebUIPluginsSection>
    // When the page renders
    const { container } = render(<WebUIPluginsSection {...props} />)

    // Then the TAB's name is not printed again: the page opens on its group labels
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([en['group.general'], en['group.plugins']])
    // And the telemetry row's switch is named by the row's own title
    const switchEl = screen.getByRole('switch')
    const titleId = switchEl.getAttribute('aria-labelledby') ?? ''
    const namedBy = Array.from(container.querySelectorAll('[id]')).find(node => node.id === titleId)
    expect(namedBy?.textContent).toBe(en['telemetry.title'])
    // And the family cards are dispatched once into the Plugins group's list
    expect(renderSlot).toHaveBeenCalledTimes(1)
    expect(renderSlot).toHaveBeenCalledWith('web-ui.plugin.item', {})
  })
})
