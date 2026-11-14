/**
 * The coarse-adjustment bubble a bounded field hangs beside its precise
 * control: it opens on a hover rest or on focus, drains away once pointer and
 * focus have both left, holds while a drag is in progress, and reports the
 * value live through onInput and once through onCommit.
 */

import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RangeBubble } from '../client/settings/RangeBubble.tsx'

// React only flushes an act() scope synchronously in an environment it
// recognizes as a test renderer, and the family vitest setup does not set the
// flag; without it every act() call warns and its scope is advisory.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Rest on the control before the bubble opens. */
const OPEN_DELAY_MS = 220
/** Grace after pointer and focus have left before the bubble closes. */
const CLOSE_DELAY_MS = 200

/** The bubble's anchor, its slider, the precise control, and what it reported. */
interface BubbleHandles {
  container: HTMLElement
  anchor: HTMLElement
  precise: HTMLInputElement
  inputs: number[]
  commits: number[]
}

/** The single element a selector must match, or a failure naming it. */
function requiredElement(container: HTMLElement, selector: string): HTMLElement {
  const node = container.querySelector(selector)
  if (!(node instanceof HTMLElement)) throw new Error(`the bubble rendered no ${selector}`)
  return node
}

/** The single input a selector must match, or a failure naming it. */
function requiredInput(container: HTMLElement, selector: string): HTMLInputElement {
  const node = container.querySelector(selector)
  if (!(node instanceof HTMLInputElement)) throw new Error(`the bubble rendered no ${selector}`)
  return node
}

/** Render the bubble around one precise control and record what it reports. */
function renderBubble(options: { value?: number, label?: string, disabled?: boolean } = {}): BubbleHandles {
  const inputs: number[] = []
  const commits: number[] = []
  const view = render(
    <RangeBubble
      min={0}
      max={100}
      step={1}
      value={options.value ?? 10}
      label={options.label ?? 'Size'}
      disabled={options.disabled}
      onInput={(value: number) => { inputs.push(value) }}
      onCommit={(value: number) => { commits.push(value) }}
    >
      <input type="text" aria-label="Precise size" defaultValue="10" />
    </RangeBubble>,
  )
  const anchor = view.container.firstElementChild
  if (!(anchor instanceof HTMLElement)) throw new Error('the bubble rendered no anchor')
  return {
    container: view.container,
    anchor,
    precise: requiredInput(view.container, 'input[type="text"]'),
    inputs,
    commits,
  }
}

/** The coarse slider the bubble carries. */
function sliderOf(container: HTMLElement): HTMLInputElement {
  return requiredInput(container, 'input[type="range"]')
}

/** Whether the bubble is up, read from the attribute the stylesheet animates. */
function isOpen(container: HTMLElement): boolean {
  return requiredElement(container, '[data-side]').hasAttribute('data-open')
}

/** Run a timer interval deterministically, flushing what it updates. */
function advance(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms) })
}

/** Move the pointer onto the control. */
function restPointerOn(anchor: HTMLElement): void {
  fireEvent.pointerOver(anchor)
}

/** Move the pointer off the control. */
function movePointerOff(anchor: HTMLElement): void {
  fireEvent.pointerOut(anchor)
}

/** Move focus into the precise control. */
function focusControl(precise: HTMLInputElement): void {
  act(() => { precise.focus() })
}

/** Move focus off the precise control. */
function blurControl(precise: HTMLInputElement): void {
  act(() => { precise.blur() })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('coarse range bubble', () => {
  it('user resting the pointer on the control sees the bubble only after the rest delay', () => {
    // Given a control whose coarse bubble is closed on arrival
    const view = renderBubble()
    expect(isOpen(view.container)).toBe(false)

    // When the user rests the pointer on the control
    restPointerOn(view.anchor)

    // Then nothing opens while the rest is shorter than the delay
    advance(OPEN_DELAY_MS - 1)
    expect(isOpen(view.container)).toBe(false)

    // ...and the bubble arrives when the rest reaches it, spanning the field's
    // whole range under the field's own name, with no room above the control
    advance(1)
    expect(isOpen(view.container)).toBe(true)
    expect(sliderOf(view.container).tabIndex).toBe(0)
    expect([sliderOf(view.container).min, sliderOf(view.container).max, sliderOf(view.container).step])
      .toEqual(['0', '100', '1'])
    expect(sliderOf(view.container).getAttribute('aria-label')).toBe('Size')
    expect(requiredElement(view.container, '[data-side]').getAttribute('data-side')).toBe('below')
  })

  it('user focusing the control raises the bubble without waiting for a rest', () => {
    // Given a control whose coarse bubble is closed on arrival
    const view = renderBubble()
    expect(isOpen(view.container)).toBe(false)

    // When the user moves focus into the precise control
    focusControl(view.precise)

    // Then the bubble is up on the next tick, with the pointer never on it
    advance(1)
    expect(isOpen(view.container)).toBe(true)
  })

  it('user leaving a control that holds no focus sees the bubble close after the grace period', () => {
    // Given an open bubble the pointer alone raised
    const view = renderBubble()
    restPointerOn(view.anchor)
    advance(OPEN_DELAY_MS)
    expect(isOpen(view.container)).toBe(true)

    // When the pointer leaves the control
    movePointerOff(view.anchor)

    // Then the bubble survives the grace and disappears at its end, so crossing
    // the control on the way elsewhere does not flash it
    advance(CLOSE_DELAY_MS - 1)
    expect(isOpen(view.container)).toBe(true)
    advance(1)
    expect(isOpen(view.container)).toBe(false)
  })

  it('user who leaves the control while it holds focus keeps the bubble until focus moves on', () => {
    // Given an open bubble whose control still holds focus
    const view = renderBubble()
    focusControl(view.precise)
    advance(1)
    expect(isOpen(view.container)).toBe(true)

    // When the pointer leaves the control but focus stays inside it
    movePointerOff(view.anchor)
    advance(CLOSE_DELAY_MS * 2)

    // Then the bubble stays up
    expect(isOpen(view.container)).toBe(true)

    // When focus leaves as well
    blurControl(view.precise)
    advance(CLOSE_DELAY_MS)

    // Then nothing holds the bubble any more and it goes away
    expect(isOpen(view.container)).toBe(false)
  })

  it('user dragging the thumb keeps the bubble up after the pointer strays, reporting the live value', () => {
    // Given an open bubble the user has started dragging
    const view = renderBubble()
    restPointerOn(view.anchor)
    advance(OPEN_DELAY_MS)
    fireEvent.pointerDown(sliderOf(view.container))

    // When the pointer strays off the control mid-drag and the thumb then moves
    movePointerOff(view.anchor)
    advance(CLOSE_DELAY_MS * 2)
    fireEvent.change(sliderOf(view.container), { target: { value: '40' } })

    // Then the bubble stays put, the field already shows the dragged value, and
    // nothing has been committed while the drag is still in progress
    expect(isOpen(view.container)).toBe(true)
    expect(view.inputs).toEqual([40])
    expect(view.commits).toEqual([])
    expect(sliderOf(view.container).value).toBe('40')
  })

  it('user releasing the thumb has the value committed once and the bubble then drains', () => {
    // Given a drag in progress whose pointer has already left the control
    const view = renderBubble()
    restPointerOn(view.anchor)
    advance(OPEN_DELAY_MS)
    fireEvent.pointerDown(sliderOf(view.container))
    movePointerOff(view.anchor)
    fireEvent.change(sliderOf(view.container), { target: { value: '40' } })

    // When the user releases the thumb
    fireEvent.pointerUp(sliderOf(view.container))

    // Then exactly one commit carries the released value, behind the live report
    expect(view.inputs).toEqual([40])
    expect(view.commits).toEqual([40])

    // ...and with neither pointer nor focus left the bubble closes at the end
    // of the grace period
    advance(CLOSE_DELAY_MS)
    expect(isOpen(view.container)).toBe(false)
  })

  it('user pressing an arrow key on the slider has the value committed once', () => {
    // Given an open bubble whose slider the user works by keyboard
    const view = renderBubble()
    restPointerOn(view.anchor)
    advance(OPEN_DELAY_MS)

    // When the user presses an arrow key and releases it
    fireEvent.keyDown(sliderOf(view.container), { key: 'ArrowRight' })
    fireEvent.change(sliderOf(view.container), { target: { value: '15' } })
    fireEvent.keyUp(sliderOf(view.container), { key: 'ArrowRight' })

    // Then the moved value was reported live once and committed once
    expect(view.inputs).toEqual([15])
    expect(view.commits).toEqual([15])
  })

  it('user on a disabled control never gets a bubble', () => {
    // Given a control the card disabled along with its field
    const view = renderBubble({ disabled: true })

    // When the user rests the pointer on it and moves focus into it
    restPointerOn(view.anchor)
    focusControl(view.precise)
    advance(OPEN_DELAY_MS * 2)

    // Then no bubble appears, and the slider it would carry is disabled too
    expect(isOpen(view.container)).toBe(false)
    expect(sliderOf(view.container).disabled).toBe(true)
  })

  it('user with a stored value beyond the range sees the thumb parked at the nearer end', () => {
    // Given a stored value above the field's ceiling
    const view = renderBubble({ value: 500 })

    // When the user raises the bubble
    restPointerOn(view.anchor)
    advance(OPEN_DELAY_MS)

    // Then the thumb parks at the ceiling instead of past it
    expect(isOpen(view.container)).toBe(true)
    expect(sliderOf(view.container).value).toBe('100')
  })
})
