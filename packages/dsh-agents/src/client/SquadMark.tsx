/**
 * Card mark for the agents settings entry.
 *
 * The family's settings cards each lead their header with a small plugin mark
 * inside the shared 34px tile, so a plugin's card is told apart from its
 * siblings before the title is read. This one is the plugin's own identity
 * glyph from `icon.svg` — three linked member nodes — reduced from that
 * 512-unit grid onto the 18px tile: the leader sits above the two members it
 * links, and the three edges meet the node faces instead of stopping short of
 * them, so the parts read as one connected object at 18px rather than as
 * three loose dots. Every shape is painted with `currentColor`, so the mark
 * follows the header's ink color on hover and while the card is open, exactly
 * like the sibling cards' marks, and it stays out of the accessibility tree.
 */

import type { ReactElement } from 'react'

/**
 * Render the agents card mark.
 * @returns the 18x18 linked-node mark, in the current text color.
 */
export function SquadMark(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M 7.55 5.85 L 5.05 12.15 M 10.45 5.85 L 12.95 12.15 M 6.1 13.8 L 11.9 13.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="9" cy="4.3" r="2.15" fill="currentColor" />
      <circle cx="4" cy="13.8" r="2.15" fill="currentColor" />
      <circle cx="14" cy="13.8" r="2.15" fill="currentColor" />
    </svg>
  )
}
