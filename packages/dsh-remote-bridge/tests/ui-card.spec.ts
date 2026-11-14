/**
 * The transcript reading of one `ui_present` call (§35.10, §35.11), driven as
 * pure functions: which source a stage reads, what a card refuses, and the exact
 * document handed to the frame.
 *
 * The argument view is stubbed as the documented `PartialArguments` face — a lazy
 * `text`/`value` reader — because the three shapes a row can meet (lazy view,
 * finished JSON text, parsed payload) are the contract, not one SDK class.
 */
import { describe, expect, it } from 'vitest'
import {
  CARD_DEFAULT_HEIGHT,
  CARD_MAX_HEIGHT,
  CARD_MIN_HEIGHT,
  CARD_THEME_TOKENS,
  FRAME_HEIGHT_CHANNEL,
  FRAME_SANDBOX,
  cardHtmlFits,
  cardThemeTokens,
  clampCardHeight,
  frameDocument,
  frameEventOf,
  presentReadOf,
  readPresentation,
} from '../src/client/ui-card.ts'

const PAGE = '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>'
/** The cap in §35.2, restated here so the boundary is asserted from the wire's side. */
const HTML_MAX_BYTES = 262_144

/** The lazy argument view a toolview receives: read by field, totals never throw. */
function lazyView(fields: Record<string, unknown>): unknown {
  return {
    text: (key: string): string | undefined => (typeof fields[key] === 'string' ? fields[key] as string : undefined),
    value: (key: string): unknown => fields[key],
  }
}

describe('the running call', () => {
  it('operator sees the page taken from the arguments while the call is still running', () => {
    // Given a running call whose only material on the wire is its own arguments
    const args = lazyView({ html: PAGE, title: 'Pick one', height: 300 })
    // When the row reads that stage
    const read = presentReadOf('start', args === undefined ? undefined : { args })
    // Then the page is the argument document and the card is still open
    expect(read).toEqual({
      kind: 'card',
      card: { html: PAGE, state: 'open', title: 'Pick one', height: 300 },
    })
  })

  it('operator gets the same card from a parsed argument payload as from a lazy view', () => {
    // Given a call whose arguments arrived as an already parsed object
    // When the row reads the running stage
    const read = presentReadOf('start', { args: { html: PAGE } })
    // Then the document is read out of the object itself
    expect(read).toEqual({ kind: 'card', card: { html: PAGE, state: 'open' } })
  })

  it('operator whose stage publishes finished argument text still gets the page', () => {
    // Given a stage that carries the argument text rather than a lazy view
    const argsRaw = JSON.stringify({ html: PAGE, title: 'From text' })
    // When the row reads it
    const read = presentReadOf('preparing', { argsRaw })
    // Then the text is parsed and the title survives
    expect(read).toEqual({ kind: 'card', card: { html: PAGE, state: 'open', title: 'From text' } })
  })

  it('operator sees no card for a call that carries no page at all', () => {
    // Given three calls with nothing to render: no arguments, no html, no stage material
    // When each is read
    const reads = [
      presentReadOf('start', undefined),
      presentReadOf('start', { args: { title: 'no html' } }),
      presentReadOf('result', { meta: {}, args: {} }),
    ]
    // Then every one of them asks for the neutral line instead of a frame
    expect(reads).toEqual([{ kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }])
  })

  it('operator gets a refusal for a page over the cap and a card at exactly the cap', () => {
    // Given two documents that differ by a single byte at the 256 KiB boundary
    const atCap = 'a'.repeat(HTML_MAX_BYTES)
    const overCap = 'a'.repeat(HTML_MAX_BYTES + 1)
    // When both are read as cards
    const fits = cardHtmlFits(atCap)
    const atCapRead = presentReadOf('start', { args: { html: atCap } })
    const overCapRead = presentReadOf('start', { args: { html: overCap } })
    // Then the boundary is inclusive and the oversized page draws no frame
    expect(fits).toBe(true)
    expect(atCapRead.kind).toBe('card')
    expect(overCapRead).toEqual({ kind: 'oversize' })
  })

  it('operator is refused a page whose bytes are over the cap even when its code units are under', () => {
    // Given 87 382 three-byte characters: 262 146 bytes, 87 382 UTF-16 units
    const wide = '\u4e2d'.repeat(87_382)
    // When the row measures it
    const read = presentReadOf('start', { args: { html: wide } })
    // Then the cap is counted in UTF-8 bytes, so it is refused
    expect(wide.length).toBeLessThan(HTML_MAX_BYTES)
    expect(read).toEqual({ kind: 'oversize' })
  })
})

describe('the settled call', () => {
  it('operator sees the presentation payload win over the arguments once the call is settled', () => {
    // Given a settled call that carries both the argument page and its own payload
    const block = {
      args: { html: '<p>arguments</p>' },
      meta: { ui: { key: 's/1', title: 'Card', html: PAGE, height: 240, state: 'settled' } },
    }
    // When the row reads the settled stage
    const read = presentReadOf('result', block)
    // Then every field comes from the payload, and the card reads settled
    expect(read).toEqual({
      kind: 'card',
      card: { html: PAGE, state: 'settled', title: 'Card', height: 240, key: 's/1' },
    })
  })

  it('operator sees the open state the payload may still declare', () => {
    // Given a payload that declares the open arm of the frozen pair
    // When the row reads it
    const read = presentReadOf('result', { meta: { ui: { html: PAGE, state: 'open' } } })
    // Then the card keeps the state the payload published
    expect(read.kind === 'card' ? read.card.state : 'no card').toBe('open')
  })

  it('operator gets the argument page as a settled card when the result carries no payload', () => {
    // Given a settled call whose result carries no presentation payload
    const block = { args: { html: PAGE, title: 'No payload' } }
    // When the row reads the result stage
    const read = presentReadOf('result', block)
    // Then the arguments are the fallback and the stage, not the field, decides the ending
    expect(read).toEqual({ kind: 'card', card: { html: PAGE, state: 'settled', title: 'No payload' } })
  })

  it('operator gets the neutral line for a result whose payload is not a card', () => {
    // Given payloads a malformed presenter could write
    // When each is read
    const reads = [readPresentation({ ui: { html: 42 } }), readPresentation({}), readPresentation(undefined), readPresentation('a string')]
    // Then none of them becomes a card
    expect(reads).toEqual([undefined, undefined, undefined, undefined])
  })

  it('operator reading an unknown state is shown the card as settled', () => {
    // Given a payload whose state is outside the frozen pair and a height that is not usable
    // When it is read
    const card = readPresentation({ ui: { html: PAGE, state: 'elsewhere', height: -4 } })
    // Then the card reads settled and carries no height it cannot trust
    expect(card).toEqual({ html: PAGE, state: 'settled' })
  })
})

describe('the frame document', () => {
  it('operator sees the agent document byte for byte inside the frame document', () => {
    // Given a page the presenter wrote
    // When it is built into a frame document with no theme tokens
    const built = frameDocument(PAGE, [])
    // Then the page body survives and the reporter rides along
    expect(built.startsWith('<!doctype html>')).toBe(true)
    expect(built).toContain('<p>hi</p>')
    expect(built).toContain(FRAME_HEIGHT_CHANNEL)
  })

  it('operator sees the theme tokens handed to the page ahead of its own head content', () => {
    // Given one token read off the running theme
    // When the frame document is built
    const built = frameDocument(PAGE, [['--dsw-alias-label-primary', '#111111']])
    // Then the variables are declared inside the head, before it closes
    expect(built).toContain(':root{--dsw-alias-label-primary:#111111}')
    expect(built.indexOf(':root{')).toBeLessThan(built.indexOf('</head>'))
  })

  it('operator whose theme could not be read still gets a frame document', () => {
    // Given no tokens at all
    const built = frameDocument(PAGE, [])
    // When the document is built
    // Then nothing about a theme is injected and the page is untouched
    expect(built).not.toContain('data-dsh-card-theme')
    expect(built).toContain('<p>hi</p>')
  })

  it('operator gets the injection inside a document that carries no head or body close tag', () => {
    // Given a bare document with neither closing tag
    const bare = '<!doctype html><p>bare</p>'
    // When it is built with tokens
    const built = frameDocument(bare, [['--dsw-alias-label-primary', '#111111']])
    // Then nothing landed before the doctype, and both snippets are present
    expect(built.startsWith('<!doctype html>')).toBe(true)
    expect(built).toContain('data-dsh-card-theme')
    expect(built).toContain(FRAME_HEIGHT_CHANNEL)
  })
})

describe('the theme reader', () => {
  it('operator gets only the tokens the running theme actually defines', () => {
    // Given a root element that defines two of the four roles
    const defined: Record<string, string> = {
      '--dsw-alias-label-primary': '#111111',
      '--dsw-alias-bg-layer-1': ' #ffffff ',
    }
    // When the row reads the tokens
    const tokens = cardThemeTokens({ getPropertyValue: (name: string) => defined[name] ?? '' })
    // Then only those two cross, trimmed
    expect(tokens).toEqual([
      ['--dsw-alias-label-primary', '#111111'],
      ['--dsw-alias-bg-layer-1', '#ffffff'],
    ])
  })

  it('operator gets no tokens when the style object refuses to answer', () => {
    // Given a style object that throws for the first role and answers nothing else
    const style = {
      getPropertyValue: (name: string): string => {
        if (name === CARD_THEME_TOKENS[0]) throw new Error('unreadable theme')
        return ''
      },
    }
    // When the row reads the tokens
    const tokens = cardThemeTokens(style)
    // Then the reading costs the variables and nothing else
    expect(tokens).toEqual([])
  })
})

describe('the frame messages', () => {
  it('operator gets the measured height the reporter posts, rounded up', () => {
    // Given a reporter message from the card's own page
    // When it is read
    const event = frameEventOf({ type: FRAME_HEIGHT_CHANNEL, height: 311.2 })
    // Then the height crosses as a whole number of pixels
    expect(event).toEqual({ kind: 'height', height: 312 })
  })

  it('operator who acts inside the page produces an interaction this desktop never answers', () => {
    // Given a page's own action message
    // When it is read
    const event = frameEventOf({ type: 'submit', payload: { id: 1 } })
    // Then it is read as an interaction and nothing more
    expect(event).toEqual({ kind: 'interaction' })
  })

  it('operator gets nothing out of a frame message that is not one', () => {
    // Given five payloads this row must not read
    const payloads = [
      { type: FRAME_HEIGHT_CHANNEL, height: 'tall' },
      { type: FRAME_HEIGHT_CHANNEL, height: -1 },
      { type: 42 },
      null,
      ['submit'],
    ]
    // When each is read
    const reads = payloads.map(payload => frameEventOf(payload))
    // Then every one of them is ignored
    expect(reads).toEqual([undefined, undefined, undefined, undefined, undefined])
  })
})

describe('the card height', () => {
  it('operator gets a measurement held inside the range a card may occupy', () => {
    // Given four measurements, two of them outside the allowed range
    // When each is clamped
    const clamped = [CARD_MIN_HEIGHT - 40, CARD_MAX_HEIGHT + 400, 200.4, Number.NaN].map(clampCardHeight)
    // Then the range holds and an unusable number falls back to the default
    expect(clamped).toEqual([CARD_MIN_HEIGHT, CARD_MAX_HEIGHT, 201, CARD_DEFAULT_HEIGHT])
  })
})

describe('the sandbox', () => {
  it('operator gets a page granted scripts and nothing that reaches this origin', () => {
    // Given the one sandbox value a card frame is allowed
    const refused = ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms', 'allow-modals']
    // When it is handed to the frame
    // Then it is exactly scripts, and every refused capability is absent
    expect(FRAME_SANDBOX).toBe('allow-scripts')
    const leaked = refused.filter(token => FRAME_SANDBOX.includes(token))
    expect(leaked).toEqual([])
  })
})
