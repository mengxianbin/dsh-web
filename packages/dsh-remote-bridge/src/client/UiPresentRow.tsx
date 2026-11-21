/**
 * The transcript row of one `ui_present` call: the whole page an agent handed
 * into the session, drawn in a controlled frame (protocol §35.11).
 *
 * The row renders and does not answer. The frame carries `srcdoc` and the one
 * sandbox value §35.7 allows — never `allow-same-origin`, which is what turns a
 * sandboxed document back into a same-origin one and would hand an agent page the
 * GUI's own storage and cookies. There is no host request on any path here: an
 * action the page posts arrives as one visible sentence telling the operator to
 * answer on the phone, and nothing is forwarded, stored or sent.
 *
 * Height is measured from the inside because the frame is opaque from the
 * outside: the injected reporter posts the document's own content height, the
 * presenter's suggested `height` carries the first frame, and the measurement
 * replaces it as soon as one arrives. The theme is handed in as variables read
 * off the GUI root, so a card follows the running theme without importing one;
 * a theme that cannot be read costs the injected variables, never the card.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CARD_DEFAULT_HEIGHT,
  FRAME_HEIGHT_CHANNEL,
  FRAME_PERMISSIONS,
  FRAME_SANDBOX,
  cardThemeTokens,
  clampCardHeight,
  frameDocument,
  frameEventOf,
  presentReadOf,
  type ThemeToken,
} from './ui-card.ts'
import { PLUGIN_ATTR } from './semantic.ts'
import css from './ui-present.module.css'

export type UiPresentRowProps = PropsLocale<'remote-bridge'> & {
  /** The stage the Tool slot published (`preparing`, `start` or `result`). */
  readonly phase?: unknown
  /** The call material of that stage: the argument view, argument text, meta. */
  readonly block?: unknown
}

/** @returns the GUI root's theme tokens, or none when the theme cannot be read. */
function readThemeTokens(): readonly ThemeToken[] {
  try {
    return cardThemeTokens(getComputedStyle(document.documentElement))
  } catch {
    return []
  }
}

/**
 * Render one card, or the neutral line of a call that carries no page.
 * @param props - the stage, the call material and the locale seat.
 * @returns the card body placed inside the official tool row.
 */
export function UiPresentRow({ phase, block, t }: UiPresentRowProps) {
  const read = useMemo(() => presentReadOf(phase, block), [phase, block])
  const card = read.kind === 'card' ? read.card : undefined
  const frame = useRef<HTMLIFrameElement | null>(null)
  // Read once, before the first paint: a token list that arrived after mount
  // would be a second document load for a card that already showed one.
  const [tokens, setTokens] = useState<readonly ThemeToken[]>(readThemeTokens)
  const [measured, setMeasured] = useState<number | undefined>(undefined)
  const [interacted, setInteracted] = useState(false)

  // The GUI switches between light and dark while a card is on screen; the
  // document is rebuilt from the tokens of whichever theme is now in force.
  useEffect(() => {
    let media: MediaQueryList | undefined
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return
    }
    const sync = (): void => { setTokens(readThemeTokens()) }
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', sync)
      return () => { media.removeEventListener('change', sync) }
    }
    media.addListener(sync)
    return () => { media.removeListener(sync) }
  }, [])

  // A new page is a new measurement and a new notice: carrying either across
  // would size the next card to the previous one's content.
  const html = card?.html
  useEffect(() => {
    setMeasured(undefined)
    setInteracted(false)
  }, [html])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const element = frame.current
      // Identity is the frame element, not the origin: a sandboxed document has
      // an opaque origin and can assert nothing about itself.
      if (element === null || element.contentWindow === null || event.source !== element.contentWindow) return
      const frameEvent = frameEventOf(event.data)
      if (frameEvent === undefined) return
      if (frameEvent.kind === 'height') {
        setMeasured(clampCardHeight(frameEvent.height))
        return
      }
      // The page asked the desktop for an answer. Nothing leaves this row; the
      // operator is told where answering actually happens.
      setInteracted(true)
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [])

  const srcdoc = useMemo(
    () => (card === undefined ? '' : frameDocument(card.html, tokens, FRAME_HEIGHT_CHANNEL)),
    [card, tokens],
  )

  if (card === undefined) {
    return (
      <div className={css.row} data-dsh-plugin={PLUGIN_ATTR} data-tone={read.kind}>
        <p className={css.notice} role="status">{read.kind === 'oversize' ? t('card.oversize') : t('card.empty')}</p>
      </div>
    )
  }

  const height = measured ?? clampCardHeight(card.height ?? CARD_DEFAULT_HEIGHT)

  return (
    <section className={css.card} data-dsh-plugin={PLUGIN_ATTR} data-state={card.state}>
      <header className={css.head}>
        {card.title !== undefined && <span className={css.title}>{card.title}</span>}
        <span className={css.badge}>{card.state === 'open' ? t('card.waiting') : t('card.settled')}</span>
      </header>
      <iframe
        ref={frame}
        className={css.frame}
        style={{ height: `${height}px` }}
        title={card.title ?? t('card.frameLabel')}
        srcDoc={srcdoc}
        sandbox={FRAME_SANDBOX}
        allow={FRAME_PERMISSIONS}
        referrerPolicy="no-referrer"
      />
      <p className={css.notice} role="status">
        {interacted ? t('card.interacted') : t('card.answerOnPhone')}
      </p>
    </section>
  )
}
