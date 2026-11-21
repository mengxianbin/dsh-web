/**
 * Minimal React test harness.
 *
 * The package's dependency table carries react/react-dom and jsdom but no
 * testing-library, so mounting is createRoot + act from React's own API. Every
 * state change a test triggers must run inside act() or React warns and the
 * assertions read a stale tree.
 */
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

/** Handle returned by {@link render}. */
export interface RenderedTree {
  /** Container the tree is mounted into. */
  readonly container: HTMLElement
  /** Render a new element into the same root. */
  rerender(element: ReactElement): void
  /** Unmount and drop the container. */
  unmount(): void
}

/**
 * Mount one element into a fresh container appended to document.body.
 * @param element - tree to mount.
 * @returns the handle.
 */
export function render(element: ReactElement): RenderedTree {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(element)
  })
  return {
    container,
    rerender(next: ReactElement): void {
      act(() => {
        root.render(next)
      })
    },
    unmount(): void {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/**
 * Run a callback inside act() (state pushes from the socket land here).
 * @param run - callback performing the interaction.
 */
export function actOn(run: () => void): void {
  act(run)
}
