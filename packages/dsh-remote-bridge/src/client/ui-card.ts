/**
 * The transcript reading of one `ui_present` call (protocol §35.10, §35.11):
 * what the desktop row draws, decided without touching the DOM.
 *
 * A card has two sources and neither may be dropped. While the call is still
 * running the arguments are the only material on the wire, so the page comes out
 * of `args` and the header says the operator has not acted yet. Once the result
 * lands, the presentation payload `meta.ui` is the card's own record — its
 * `state`, its `title` and the very document that crossed — and the arguments
 * are only the fallback for a result that carries no payload.
 *
 * The argument view is read by shape rather than by import: a toolview receives a
 * lazy `PartialArguments` when the call arrived as argument text and a plain
 * payload when the call was dispatched as an object, and §35.10 fixes neither. A
 * field reader therefore answers from all three shapes it can meet (lazy view,
 * JSON text, parsed object) so a page is never lost to a shape this row did not
 * anticipate.
 *
 * Two rules live here rather than in the renderer. A document above 256 KiB is
 * never handed to a frame (§35.2 caps it on this side too), and a frame message is
 * read by shape alone: the sandboxed document has an opaque origin, so identity
 * comes from the frame element the row owns, never from what the message claims.
 * Nothing read here is forwarded anywhere — the desktop renders and does not
 * answer (§35.11).
 * @module dsh-remote-bridge/client/ui-card
 */

import { UI_HTML_MAX_BYTES, type UiState } from '../core/ui.ts'

/**
 * The Tool slot's stage literals, as the composing contract publishes them
 * (`ToolCallPhaseProps`). `result` is the settled arm; every other stage still
 * has the call's arguments only.
 */
export type PresentPhase = 'preparing' | 'start' | 'result'

/** One card as a row draws it, whichever source it came from. */
export interface PresentCard {
  /** The whole self-contained document, `<!doctype html>` first. */
  readonly html: string
  /** Whether the card still holds the call (`open`) or is only a notice. */
  readonly state: UiState
  /** One header line; absent when the presenter named none. */
  readonly title?: string
  /** The presenter's suggested first height in points; the measurement wins. */
  readonly height?: number
  /** `"<sessionId>/<callId>"`, when the payload carries the card identity. */
  readonly key?: string
}

/** What one row read produced. */
export type PresentRead =
  | { readonly kind: 'card'; readonly card: PresentCard }
  /** A page over {@link UI_HTML_MAX_BYTES}: refused visibly, never rendered. */
  | { readonly kind: 'oversize' }
  /** No page in either source: the row keeps a neutral line instead of a card. */
  | { readonly kind: 'empty' }

/** The call material one row can read at its stage. */
interface PresentBlock {
  /** The lazy argument view (`ToolArgs`), or a parsed payload. */
  readonly args?: unknown
  /** Finished argument text, for a stage that publishes it beside the view. */
  readonly argsRaw?: unknown
  /** `ToolResultNode.meta`, carried verbatim by the protocol. */
  readonly meta?: unknown
}

/** One theme token as it is handed to a card's document. */
export type ThemeToken = readonly [name: string, value: string]

/**
 * The theme tokens a card inherits from the GUI's own root element.
 *
 * Four roles and no more: the page needs a text colour it can trust, a quieter
 * one, a surface and a border. A token the running theme does not define is
 * simply not injected — the page then falls back to its own CSS, which is why an
 * unreadable theme is a degraded look rather than a broken card.
 */
export const CARD_THEME_TOKENS = [
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-border-l2',
] as const

/** The one sandbox value a card frame is allowed (§35.7, §35.11). */
export const FRAME_SANDBOX = 'allow-scripts'

/**
 * The permissions a card frame is explicitly denied.
 *
 * §35.7 refuses camera, microphone, location and clipboard reads on both ends.
 * A sandboxed document already has an opaque origin, and this policy states the
 * denial where the browser enforces it rather than leaving it to the default.
 */
export const FRAME_PERMISSIONS = [
  "camera 'none'",
  "microphone 'none'",
  "geolocation 'none'",
  "clipboard-read 'none'",
].join('; ')

/** The message type the injected reporter uses to publish the content height. */
export const FRAME_HEIGHT_CHANNEL = 'dsh-ui-card-height'

/** The first height of a card whose presenter suggested none. */
export const CARD_DEFAULT_HEIGHT = 320

/** The smallest and largest heights a measured card may take, in CSS pixels. */
export const CARD_MIN_HEIGHT = 96
export const CARD_MAX_HEIGHT = 720

/**
 * Read one field as text out of every argument shape a toolview can receive.
 * @param args - the lazy view, finished JSON text, or a parsed payload.
 * @param name - the top-level field name.
 * @returns the field's decoded string, or undefined when absent or not a string.
 */
function fieldText(args: unknown, name: string): string | undefined {
  if (typeof args === 'string') {
    const parsed = parseJson(args)
    return parsed === undefined ? undefined : fieldText(parsed, name)
  }
  if (typeof args !== 'object' || args === null) return undefined
  const view = args as Record<string, unknown> & { text?: unknown }
  if (typeof view.text === 'function') {
    const read: unknown = (view.text as (key: string) => unknown).call(args, name)
    return typeof read === 'string' ? read : undefined
  }
  const direct = view[name]
  return typeof direct === 'string' ? direct : undefined
}

/**
 * Read one field as any completed value out of the same three shapes.
 * @param args - the lazy view, finished JSON text, or a parsed payload.
 * @param name - the top-level field name.
 * @returns the value, or undefined when absent.
 */
function fieldValue(args: unknown, name: string): unknown {
  if (typeof args === 'string') {
    const parsed = parseJson(args)
    return parsed === undefined ? undefined : fieldValue(parsed, name)
  }
  if (typeof args !== 'object' || args === null) return undefined
  const view = args as Record<string, unknown> & { value?: unknown }
  if (typeof view.value === 'function') return (view.value as (key: string) => unknown).call(args, name)
  return view[name]
}

/** @returns the parsed payload, or undefined when the text is not one object. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** @returns one suggested height as a whole number of CSS pixels, when usable. */
function heightOf(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  return Math.ceil(raw)
}

/**
 * Read the presentation payload a settled call carries (§35.10).
 *
 * The payload is the card's own record, so it is read only when it is one: a
 * `html` that is not a string is no card at all, which keeps a malformed payload
 * from becoming an empty frame. `state` outside the frozen pair reads as
 * `settled` — a result-phase payload is a finished card by definition, and the
 * `open` arm exists for a presenter that answers before its first event.
 * @param meta - the result's `meta` value, carried verbatim.
 * @returns the card, or undefined when this result carries no presentation.
 */
export function readPresentation(meta: unknown): PresentCard | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const ui = (meta as { ui?: unknown }).ui
  if (typeof ui !== 'object' || ui === null) return undefined
  const record = ui as Record<string, unknown>
  const html = record.html
  if (typeof html !== 'string') return undefined
  const title = record.title
  const key = record.key
  const height = heightOf(record.height)
  return {
    html,
    state: record.state === 'open' ? 'open' : 'settled',
    ...(typeof title === 'string' ? { title } : {}),
    ...(height === undefined ? {} : { height }),
    ...(typeof key === 'string' ? { key } : {}),
  }
}

/**
 * Build the card a running call shows from its own arguments.
 * @param block - the call material of the current stage.
 * @returns the card, or undefined when the arguments carry no page.
 */
function argumentCard(block: PresentBlock): PresentCard | undefined {
  const html = fieldText(block.args, 'html') ?? fieldText(block.argsRaw, 'html')
  if (html === undefined) return undefined
  const title = fieldText(block.args, 'title') ?? fieldText(block.argsRaw, 'title')
  const height = heightOf(fieldValue(block.args, 'height') ?? fieldValue(block.argsRaw, 'height'))
  return {
    html,
    state: 'open',
    ...(title === undefined ? {} : { title }),
    ...(height === undefined ? {} : { height }),
  }
}

/** @returns whether one document is within {@link UI_HTML_MAX_BYTES}. */
export function cardHtmlFits(html: string): boolean {
  return new TextEncoder().encode(html).length <= UI_HTML_MAX_BYTES
}

/**
 * Decide what the row draws at one stage of the call.
 *
 * The settled stage prefers `meta.ui`, because that payload is the presentation
 * the host published and carries its ending. A result without the payload falls
 * back to the arguments — and then the card is still over, so it reads
 * `settled`: the stage decides that, not a field that is absent.
 * @param phase - the stage the Tool slot published.
 * @param block - the call material of that stage.
 * @returns a card, a refusal, or the neutral line.
 */
export function presentReadOf(phase: unknown, block: unknown): PresentRead {
  if (typeof block !== 'object' || block === null) return { kind: 'empty' }
  const material = block as PresentBlock
  const card = phase === 'result'
    ? readPresentation(material.meta) ?? settledFromArguments(material)
    : argumentCard(material)
  if (card === undefined) return { kind: 'empty' }
  return cardHtmlFits(card.html) ? { kind: 'card', card } : { kind: 'oversize' }
}

/** @returns the argument page of a settled call, as a finished card. */
function settledFromArguments(material: PresentBlock): PresentCard | undefined {
  const card = argumentCard(material)
  return card === undefined ? undefined : { ...card, state: 'settled' }
}

/**
 * Read the theme tokens off a computed style, skipping the ones it does not carry.
 * @param style - the GUI root element's computed style.
 * @returns the tokens, in {@link CARD_THEME_TOKENS} order.
 */
export function cardThemeTokens(style: { getPropertyValue(name: string): string }): readonly ThemeToken[] {
  const tokens: ThemeToken[] = []
  for (const name of CARD_THEME_TOKENS) {
    let value = ''
    try {
      value = style.getPropertyValue(name)
    } catch {
      value = ''
    }
    const trimmed = value.trim()
    if (trimmed !== '') tokens.push([name, trimmed])
  }
  return tokens
}

/** @returns the `<style>` handing the theme tokens to a card's document. */
function themeStyle(tokens: readonly ThemeToken[]): string {
  if (tokens.length === 0) return ''
  const body = tokens.map(([name, value]) => `${name}:${value}`).join(';')
  return `<style data-dsh-card-theme>:root{${body}}</style>`
}

/**
 * The reporter a card's document runs to publish its own content height.
 *
 * The frame cannot be measured from the outside — the document is opaque and
 * cross-origin — so the measurement has to be pushed out. It is deliberately the
 * only code this row adds to a page: it reads a height and posts a number, and a
 * page that removes it only loses the measurement, never the card.
 * @param channel - the message type the parent listens for.
 * @returns one script element as text.
 */
function heightReporter(channel: string): string {
  const parts = [
    '<script data-dsh-card-frame>(function(){',
    'function post(){try{',
    'var d=document.documentElement,b=document.body;',
    'var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);',
    'if(h>0){parent.postMessage({type:' + JSON.stringify(channel) + ',height:h},"*")}',
    '}catch(e){}}',
    'window.addEventListener("load",post);',
    'document.addEventListener("DOMContentLoaded",post);',
    'try{if(typeof ResizeObserver==="function"){var ro=new ResizeObserver(post);',
    'if(document.documentElement)ro.observe(document.documentElement);',
    'if(document.body)ro.observe(document.body)}}catch(e){}',
    'post()})()</script>',
  ]
  return parts.join('')
}

/**
 * Put one snippet inside an existing element rather than before the document.
 * @param html - the card document.
 * @param closingTag - the tag to insert ahead of, lower case.
 * @param snippet - the markup to insert.
 * @returns the document with the snippet inside it.
 */
function injectBefore(html: string, closingTag: string, snippet: string): string {
  if (snippet === '') return html
  const at = html.toLowerCase().lastIndexOf(closingTag)
  return at < 0 ? html + snippet : html.slice(0, at) + snippet + html.slice(at)
}

/**
 * Build the document handed to a card's frame.
 *
 * The agent's page stays byte for byte what crossed; this only adds the theme
 * variables its CSS may use and the height reporter. Insertion happens ahead of
 * the closing tags rather than at the start of the string, because a snippet
 * placed before `<!doctype html>` would put the document into quirks mode.
 * @param html - the card document as the presenter wrote it.
 * @param tokens - the theme tokens to hand the page.
 * @param channel - the message type the reporter publishes on.
 * @returns the frame document; the original page when it takes no injection.
 */
export function frameDocument(html: string, tokens: readonly ThemeToken[], channel: string = FRAME_HEIGHT_CHANNEL): string {
  const style = themeStyle(tokens)
  const withTheme = style === '' ? html : injectBefore(html, '</head>', style)
  return injectBefore(withTheme, '</body>', heightReporter(channel))
}

/** One message a card's frame sent the parent. */
export type FrameEvent =
  | { readonly kind: 'height'; readonly height: number }
  /** Anything else the page posted: an action this desktop never answers. */
  | { readonly kind: 'interaction' }

/**
 * Read one message a card's frame posted.
 *
 * Only the shape is read. The frame's origin is opaque, so the parent identifies
 * the sender by the frame element it owns; what is left to decide here is what
 * the payload means, and a page's own `{type, payload}` action means nothing
 * beyond "the operator tried to act here".
 * @param data - the message payload.
 * @returns the event, or undefined when the message is not one this row reads.
 */
export function frameEventOf(data: unknown): FrameEvent | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  if (record.type === FRAME_HEIGHT_CHANNEL) {
    const height = record.height
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined
    return { kind: 'height', height: Math.ceil(height) }
  }
  return typeof record.type === 'string' && record.type !== '' ? { kind: 'interaction' } : undefined
}

/**
 * Hold a measured height inside the range a card may occupy.
 * @param height - the content height the frame reported, in CSS pixels.
 * @returns the height the card takes.
 */
export function clampCardHeight(height: number): number {
  if (!Number.isFinite(height)) return CARD_DEFAULT_HEIGHT
  return Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, Math.ceil(height)))
}
