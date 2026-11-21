/**
 * The browser view's chip text.
 *
 * The shell owns the right-sidebar chip: its box, its close and hidden
 * controls, the active highlight and the switch between tabs. This component
 * draws only what sits inside it - the browser mark and the name - which is why
 * it carries no state of its own.
 *
 * The name prefers the page the body is streaming, read from the published
 * channel (live-title.ts), and falls back to this plugin's own name before the
 * first state push: a chip that says "Checkout" is more useful than one that
 * says "Browser view", but an empty chip is worse than either.
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserViewLiveTitleStore } from './live-title.ts'
import { BROWSER_VIEW_PARTS, BROWSER_VIEW_PLUGIN } from './semantic.ts'
import css from './panel.module.css'

/** Business face injected into the chip. */
export interface BrowserViewTabTitleFace {
  /** Session whose tab this chip names. */
  readonly sessionId?: string
  /** Channel the body publishes the streamed page's title on. */
  readonly liveTitle?: BrowserViewLiveTitleStore
}

/** Chip props: the locale seat plus the injected face. */
export type BrowserViewTabTitleProps = PropsLocale<'browser-view'> & Partial<BrowserViewTabTitleFace>

/**
 * Decorative browser-window mark; inline so the chip carries no icon dependency.
 * @returns the glyph.
 */
function BrowserViewMark() {
  return (
    <svg className={css.tabTitleMark} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M1.75 5.75h12.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.4 8.15l3.85 1.7-1.6.65-.7 1.65z" fill="currentColor" />
    </svg>
  )
}

/**
 * Render the chip contents.
 * @param props - composed slot props.
 * @returns the mark and the tab's name.
 */
export function BrowserViewTabTitle({ t, sessionId, liveTitle }: BrowserViewTabTitleProps) {
  const subscribe = useCallback(
    (listener: () => void) => liveTitle?.subscribe(listener) ?? (() => {}),
    [liveTitle],
  )
  const read = useCallback(() => liveTitle?.get(sessionId), [liveTitle, sessionId])
  const pageTitle = useSyncExternalStore(subscribe, read, () => undefined)
  const label = pageTitle !== undefined && pageTitle.length > 0 ? pageTitle : t('tab.title')
  return (
    <span
      className={css.tabTitle}
      data-dsh-plugin={BROWSER_VIEW_PLUGIN}
      data-dsh-part={BROWSER_VIEW_PARTS.tabTitle}
    >
      <BrowserViewMark />
      <span className={css.tabTitleText}>{label}</span>
    </span>
  )
}
