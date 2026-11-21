/**
 * Integrated Web Extensions settings parent with keyed secondary TABs.
 *
 * The page reads as one settings page in the family's layout: a heading row
 * naming the section with the repository link at its right end, a TAB strip
 * that is the shared segmented control stretched across the page, and the open
 * TAB's page under it. A TAB change slides the pages the way the strip reads:
 * a TAB to the right arrives from the right while a still copy of the page it
 * replaces leaves to the left, and back again.
 */

import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WebUiExtensions } from './web-ui-extensions.ts'
import { SegmentGroup } from './SegmentGroup.tsx'
import cardCss from './settings-card.module.css'
import css from './web-ui-settings.module.css'

export type WebExtensionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'web-ui-plugins'>
  & PropsRenderSlots<'web-ui.extension'>
  & { extensions: WebUiExtensions }

/** The repository the heading's link opens. */
export const REPOSITORY_URL = 'https://github.com/zhu1090093659/dsh-web'

/** Length of the page slide; it matches `.extensionPage` in web-ui-settings.module.css. */
const PAGE_MOTION_MS = 250

/** Which way a TAB change reads along the strip. */
type PageDirection = 'forward' | 'back'

/** GitHub's mark (Octicons `mark-github`, MIT), drawn in the link's own colour. */
function RepositoryMark(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
      />
    </svg>
  )
}

/** Whether the reader asked the system for less motion. */
function motionReduced(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Render only the selected keyed child; unavailable pages simply have no TAB. */
export function WebExtensionsSection(props: WebExtensionsSectionProps): ReactNode {
  const { t, close, renderSlot, extensions } = props
  const entries = useSyncExternalStore(extensions.subscribeEntries, extensions.getEntries, extensions.getEntries)
  const pages = useSyncExternalStore(extensions.subscribePages, extensions.getPages, extensions.getPages)
  const selected = useSyncExternalStore(extensions.subscribe, extensions.getSnapshot, extensions.getSnapshot)
  const mounted = new Set(entries.map(entry => entry.options.key))
  const tabs = pages.filter(page => mounted.has(page.key))
  const active = tabs.find(page => page.key === selected) ?? tabs[0]
  /** The page a press opened and the way it arrived; a page opened from elsewhere arrives without motion. */
  const [entering, setEntering] = useState<{ key: string; direction: PageDirection } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const leavingRef = useRef<HTMLDivElement | null>(null)

  /**
   * Open another TAB. The page that leaves is a still copy of the open one,
   * laid over the new page out of the tab order and the accessibility tree,
   * and gone once it has played; React never reconciles it.
   */
  const pick = (key: string): void => {
    if (active === undefined || key === active.key) {
      extensions.select(key)
      return
    }
    const direction: PageDirection = tabs.findIndex(page => page.key === key) > tabs.findIndex(page => page.key === active.key) ? 'forward' : 'back'
    const panel = panelRef.current
    const holder = leavingRef.current
    if (panel !== null && holder !== null && !motionReduced()) {
      const still = panel.cloneNode(true) as HTMLElement
      for (const node of [still, ...Array.from(still.querySelectorAll('[id]'))]) node.removeAttribute('id')
      still.removeAttribute('role')
      still.removeAttribute('aria-labelledby')
      still.removeAttribute('data-enter')
      still.setAttribute('aria-hidden', 'true')
      still.setAttribute('inert', '')
      still.setAttribute('data-leave', direction)
      holder.replaceChildren(still)
      window.setTimeout(() => { still.remove() }, PAGE_MOTION_MS)
    }
    setEntering({ key, direction })
    extensions.select(key)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const current = buttons.indexOf((event.target as HTMLElement).closest('[role="tab"]') as HTMLButtonElement)
    if (current < 0 || buttons.length === 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length
    const page = tabs[next]
    if (page !== undefined) pick(page.key)
    buttons[next]?.focus()
  }

  const repository = t('extensions.repository')
  return (
    <div className={css.extensions} data-dsh-plugin="web-ui-settings" data-dsh-part="extensions">
      <div className={css.extensionsHeading}>
        <h2 className={css.extensionsTitle}>{t('extensions.title')}</h2>
        <a
          className={css.extensionsRepository}
          href={REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={repository}
          aria-label={repository}
        >
          <RepositoryMark />
        </a>
      </div>
      {tabs.length === 0
        ? null
        : (
          <SegmentGroup className={css.extensionTabs} role="tablist" aria-label={t('extensions.navigation')} onKeyDown={onKeyDown} data-dsh-part="tabs">
            {tabs.map(page => (
              <button
                key={page.key}
                type="button"
                role="tab"
                id={`web-extension-tab-${page.key}`}
                aria-controls="web-extension-panel"
                aria-selected={active?.key === page.key}
                tabIndex={active?.key === page.key ? 0 : -1}
                className={`${cardCss.segment} ${css.extensionTab}`}
                data-active={active?.key === page.key ? '' : undefined}
                onClick={() => { pick(page.key) }}
                data-dsh-part="tab"
                data-extension-id={page.key}
              >
                {page.label()}
              </button>
            ))}
          </SegmentGroup>
        )}
      <div className={css.extensionPages}>
        {/* Holds the leaving page's still copy; it renders no children of its own. */}
        <div className={css.extensionLeaving} ref={leavingRef} />
        <div
          key={active?.key ?? ''}
          ref={panelRef}
          className={css.extensionPage}
          role="tabpanel"
          id="web-extension-panel"
          aria-labelledby={active === undefined ? undefined : `web-extension-tab-${active.key}`}
          data-dsh-part="panel"
          data-enter={entering !== null && active !== undefined && entering.key === active.key ? entering.direction : undefined}
        >
          {active === undefined
            ? <p className={css.extensionUnavailable}>{t('extensions.unavailable')}</p>
            : renderSlot('web-ui.extension', { close }, { entryKey: active.key, fallback: <p className={css.extensionUnavailable}>{t('extensions.unavailable')}</p> })}
        </div>
      </div>
    </div>
  )
}
