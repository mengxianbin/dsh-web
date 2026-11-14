// @vitest-environment jsdom
/**
 * The `ui_present` transcript card (protocol §35.11): the one keyed registration
 * it contributes, the exact frame it renders at each stage, the two sources it
 * reads, and the promise that this desktop renders without answering.
 *
 * The frame is the real element — its attributes are the security boundary, so
 * they are asserted literally rather than through a stub. The theme is read from
 * the document root, which a test can set; the frame's messages are dispatched as
 * real `MessageEvent`s carrying the frame's own window as their source, which is
 * the only identity the row trusts.
 *
 * test-standards-allow: no-ad-hoc-mock - two lines in this file replace a global
 * rather than a collaborator: the fetch spy is how "this row issued no request"
 * is stated at all, and the computed-style spy is the only way to drive the
 * degraded theme path. Every other assertion drives the real component against a
 * real DOM, and no module edge or service method is patched anywhere here.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { UiPresentRow } from '../src/client/UiPresentRow.tsx'
import { PRESENT_TOOL, TOOLVIEW_SLOT, registerPresentToolview } from '../src/client/toolview-slot.ts'
import { CARD_MAX_HEIGHT, CARD_MIN_HEIGHT } from '../src/client/ui-card.ts'
import { zh, type RemoteBridgeKey } from '../src/client/locales.ts'

const PAGE = '<!doctype html><html><head></head><body><p>card body</p></body></html>'

/** Translate stub over the zh dictionary: the copy a zh GUI shows. */
const t: PropsLocale<'remote-bridge'>['t'] = (key) => zh[key as RemoteBridgeKey] ?? key

/** @returns the card frame, or throws when the row drew none. */
function requireFrame(): HTMLIFrameElement {
  const frame = document.querySelector('iframe')
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('the row drew no card frame')
  return frame
}

/** @returns the window this frame's messages come from, made available if needed. */
function frameWindowOf(frame: HTMLIFrameElement): Window {
  const win = frame.contentWindow
  if (win !== null) return win
  const fake = {} as Window
  Object.defineProperty(frame, 'contentWindow', { value: fake, configurable: true })
  return fake
}

/** Deliver one message as if the card's own page had posted it. */
function postFromFrame(frame: HTMLIFrameElement, data: unknown): void {
  const source = frameWindowOf(frame)
  let event: MessageEvent
  try {
    event = new MessageEvent('message', { data, source })
  } catch {
    event = new MessageEvent('message', { data })
    Object.defineProperty(event, 'source', { value: source })
  }
  act(() => { window.dispatchEvent(event) })
}

/** @returns the notice line the card shows, which is its only status seat. */
function noticeText(): string | null {
  return screen.getByRole('status').textContent
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the registration', () => {
  it('operator gets the card from one keyed registration under the wire tool name', () => {
    // Given a slots registry that records what this package asks for
    const injected: { name: string; seats: (() => unknown) | undefined }[] = []
    const registered: { options: Record<string, unknown>; view: unknown }[] = []
    const host = {
      slots: {
        inject: (name: string, seats: () => unknown) => { injected.push({ name, seats }) },
        register: (options: Record<string, unknown>, view: unknown) => {
          registered.push({ options, view })
          return () => {}
        },
      },
    }

    // When the plugin registers its presentation row
    registerPresentToolview(host, 'remote-bridge')

    // Then it waits for the keyed Tool view slot and claims nothing before it is declared
    expect(injected).toHaveLength(1)
    expect(injected[0]?.name).toBe(TOOLVIEW_SLOT)
    expect(TOOLVIEW_SLOT).toBe('tool.call.toolview')
    expect(registered).toHaveLength(0)

    const seats = injected[0]?.seats
    if (seats === undefined) throw new Error('the registration handed the slot no seats')
    act(() => { seats() })

    // Then the one cell it claims is the wire tool name, under this package's dictionary
    expect(registered).toHaveLength(1)
    expect(registered[0]?.options).toEqual({ name: 'tool.call.toolview', key: 'ui_present', locale: 'remote-bridge' })
    expect(PRESENT_TOOL).toBe('ui_present')
    expect(registered[0]?.view).toBe(UiPresentRow)
  })

  it('operator keeps the pairing panel when the registry refuses the card cell', () => {
    // Given a registry whose cell is already occupied
    const host = {
      slots: {
        inject: (_name: string, seats: () => unknown) => {
          const disposer = seats() as () => void
          expect(disposer).toBeInstanceOf(Function)
        },
        register: () => { throw new Error('occupied') },
      },
    }
    // When the plugin registers anyway
    // Then the refusal is swallowed instead of taking the entry down
    expect(() => { registerPresentToolview(host, 'remote-bridge') }).not.toThrow()
  })
})

describe('the running call', () => {
  it('operator sees the page from the arguments under a waiting header', () => {
    // Given a call that is still running with its page in the arguments
    render(<UiPresentRow phase="start" block={{ args: { html: PAGE, title: 'Pick one' } }} t={t} />)

    // When the transcript draws that call
    const card = document.querySelector('section')

    // Then the header still waits for the operator and the body is the page
    expect(card?.getAttribute('data-state')).toBe('open')
    expect(card?.textContent).toContain('Pick one')
    expect(card?.textContent).toContain(zh['card.waiting'])
    expect(noticeText()).toBe(zh['card.answerOnPhone'])

    const frame = requireFrame()
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toContain('<p>card body</p>')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('operator gets navigation, popups, forms and device permissions denied by attribute', () => {
    // Given a running call with a page
    render(<UiPresentRow phase="start" block={{ args: { html: PAGE } }} t={t} />)
    // When the frame is read
    const frame = requireFrame()
    // Then the sandbox names scripts only and the policy denies the device roles
    const sandbox = frame.getAttribute('sandbox') ?? ''
    const granted = ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms'].filter(token => sandbox.includes(token))
    expect(granted).toEqual([])
    expect(frame.getAttribute('allow')).toContain("camera 'none'")
    expect(frame.getAttribute('allow')).toContain("clipboard-read 'none'")
  })

  it('operator gets the presenter height first and the frame measurement afterwards', () => {
    // Given a card whose presenter suggested a first height
    render(<UiPresentRow phase="start" block={{ args: { html: PAGE, height: 260 } }} t={t} />)
    const frame = requireFrame()
    // When the frame reports heights of its own
    const first = frame.style.height
    postFromFrame(frame, { type: 'dsh-ui-card-height', height: 401.6 })
    const measured = frame.style.height
    postFromFrame(frame, { type: 'dsh-ui-card-height', height: 5 })
    const floored = frame.style.height
    postFromFrame(frame, { type: 'dsh-ui-card-height', height: 5_000 })
    const ceiling = frame.style.height
    // Then the suggestion covers the first paint and the measurement wins inside the range
    expect(first).toBe('260px')
    expect(measured).toBe('402px')
    expect(floored).toBe(`${CARD_MIN_HEIGHT}px`)
    expect(ceiling).toBe(`${CARD_MAX_HEIGHT}px`)
  })

  it('operator is told to answer on the phone and this desktop answers nothing', () => {
    // Given a card that is running and a spy on the one global a request would use
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<UiPresentRow phase="start" block={{ args: { html: PAGE } }} t={t} />)
    const frame = requireFrame()
    // When the page posts the very action it would send on the phone
    postFromFrame(frame, { type: 'submit', payload: { choice: 'a' } })
    // Then the card says where answering happens, and no request left this row
    expect(noticeText()).toBe(zh['card.interacted'])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('operator gets a message from any other window ignored', () => {
    // Given a card that is running and a message from this window, not its frame
    render(<UiPresentRow phase="start" block={{ args: { html: PAGE } }} t={t} />)
    const event = new MessageEvent('message', { data: { type: 'submit' } })
    Object.defineProperty(event, 'source', { value: window })
    // When it arrives
    act(() => { window.dispatchEvent(event) })
    // Then the card keeps waiting for an answer it never asked this window for
    expect(noticeText()).toBe(zh['card.answerOnPhone'])
  })
})

describe('the settled call', () => {
  it('operator sees the presentation payload drawn as a settled card', () => {
    // Given a settled call that carries the host's own payload beside its arguments
    render(
      <UiPresentRow
        phase="result"
        block={{ args: { html: '<p>arguments</p>' }, meta: { ui: { key: 's/1', title: 'Settled card', html: PAGE, state: 'settled' } } }}
        t={t}
      />,
    )
    // When the transcript draws it
    const card = document.querySelector('section')
    const srcdoc = requireFrame().getAttribute('srcdoc') ?? ''
    // Then the payload is the page and the card reads settled
    expect(card?.getAttribute('data-state')).toBe('settled')
    expect(card?.textContent).toContain('Settled card')
    expect(srcdoc).toContain('<p>card body</p>')
    expect(srcdoc).not.toContain('arguments')
  })

  it('operator gets the argument page as the settled card when the result carries no payload', () => {
    // Given a settled call whose result carries only the argument page
    render(<UiPresentRow phase="result" block={{ args: { html: PAGE } }} t={t} />)
    // When the transcript draws it
    const card = document.querySelector('section')
    // Then the fallback page is shown and the stage still decides the ending
    expect(card?.getAttribute('data-state')).toBe('settled')
    expect(requireFrame().getAttribute('srcdoc')).toContain('<p>card body</p>')
  })
})

describe('the refusals', () => {
  it('operator gets a sentence instead of a frame for a page over the cap', () => {
    // Given a page one byte past the cap
    // When the transcript draws the call
    render(<UiPresentRow phase="start" block={{ args: { html: 'a'.repeat(262_145) } }} t={t} />)
    // Then no frame exists and the refusal is visible
    expect(document.querySelector('iframe')).toBeNull()
    expect(noticeText()).toBe(zh['card.oversize'])
  })

  it('operator gets a neutral line for a call that carries no page', () => {
    // Given a settled call whose payload is not a card
    // When the transcript draws it
    render(<UiPresentRow phase="result" block={{ meta: {} }} t={t} />)
    // Then nothing is framed and the row keeps one plain sentence
    expect(document.querySelector('iframe')).toBeNull()
    expect(noticeText()).toBe(zh['card.empty'])
  })
})

describe('the theme', () => {
  beforeEach(() => {
    document.documentElement.style.setProperty('--dsw-alias-label-primary', '#123456')
  })
  afterEach(() => {
    document.documentElement.style.removeProperty('--dsw-alias-label-primary')
  })

  it('operator gets the running theme tokens handed to the page', () => {
    // Given a GUI root that defines the primary label colour
    // When the card is drawn
    render(<UiPresentRow phase="start" block={{ args: { html: PAGE } }} t={t} />)
    // Then the page receives that value as the same variable
    expect(requireFrame().getAttribute('srcdoc')).toContain('--dsw-alias-label-primary:#123456')
  })

  it('operator still gets the page when the theme cannot be read', () => {
    // Given a computed style that throws
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation(() => { throw new Error('no style') })
    // When the card is drawn
    render(<UiPresentRow phase="start" block={{ args: { html: PAGE } }} t={t} />)
    // Then the page renders and only the injected variables are missing
    const srcdoc = requireFrame().getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('<p>card body</p>')
    expect(srcdoc).not.toContain('data-dsh-card-theme')
    spy.mockRestore()
  })
})
