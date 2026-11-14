/**
 * Card mark for the LiangShen settings entry: the mode's machine is a
 * slot-machine lever, so the mark is that lever reduced to one knob, one arm
 * and one pivot foot. Three rounded shapes with no interior detail stay
 * legible at 18px, and every shape is painted with `currentColor` so the mark
 * follows the surrounding theme like the lever itself does.
 */

import type { ReactElement } from 'react'

/**
 * Render the LiangShen card mark.
 * @returns the 18x18 lever mark, in the current text color.
 */
export function LiangShenMark(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="3.6" y="13.2" width="8.8" height="2.8" rx="1.4" fill="currentColor" />
      <g transform="rotate(20 8 14.4)">
        <rect x="6.5" y="4.6" width="3" height="9.8" rx="1.5" fill="currentColor" />
        <circle cx="8" cy="4.4" r="2.9" fill="currentColor" />
      </g>
    </svg>
  )
}
