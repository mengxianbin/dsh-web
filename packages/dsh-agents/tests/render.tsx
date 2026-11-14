/**
 * Small mount helper shared by the agents client suites: it renders a React
 * element into a fresh container, lets pending reads settle inside `act`, and
 * tears every root down so one case cannot leak into the next.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { ReactElement } from 'react'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** One mounted element and the root that owns it. */
export interface Mounted {
  container: HTMLElement
  root: Root
}

const roots: Root[] = []

/**
 * Render one element into a container appended to the document body.
 * @param element - the element to mount.
 */
export function mount(element: ReactElement): Mounted {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(element) })
  return { container, root }
}

/**
 * Let pending microtasks and React work settle inside an act scope. Three
 * ticks cover the page's read chain (transport await, state update, render).
 */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/**
 * Unmount one mounted element and drop its container.
 * @param mounted - the result of {@link mount}.
 */
export function unmount(mounted: Mounted): void {
  const index = roots.indexOf(mounted.root)
  if (index >= 0) roots.splice(index, 1)
  act(() => { mounted.root.unmount() })
  mounted.container.remove()
}

/**
 * Click one element inside an act scope, so the state update it triggers is
 * flushed before the assertion reads the DOM.
 * @param element - the element to click.
 */
export function click(element: Element): void {
  act(() => { (element as HTMLElement).click() })
}

/**
 * The one button whose visible text equals the label.
 * @param container - subtree to search.
 * @param label - exact visible label.
 */
export function buttonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(button => button.textContent === label)
  if (found === undefined) throw new Error('no button labelled ' + label)
  return found
}

/**
 * Type into a controlled input the way a user does: set the value through the
 * prototype setter, then dispatch the input event React listens for.
 * @param input - the field to fill.
 * @param value - the text to type.
 */
export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * Pick one option of a controlled select the way a user does: set the value
 * through the prototype setter, then dispatch the change event React listens
 * for on a select.
 * @param select - the select to drive.
 * @param value - the option value to pick.
 */
export function selectOption(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  act(() => {
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Unmount everything still mounted and empty the body. */
export function unmountAll(): void {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
}
