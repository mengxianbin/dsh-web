/**
 * The pairing seat's QR glyph. It is the one icon this package draws itself
 * (I4 exception, recorded here): the official icon set in
 * `@deepseek-ai/dsh-client-ui-primitives` ships no QR or scan metaphor, and a
 * text or emoji stand-in is not an icon (I1). Every other glyph this panel
 * needs — close, copy, check, refresh, warning — comes from that set.
 */
import type { SVGProps } from 'react'

/** A QR-symbol glyph: three finder squares plus a payload dot. */
export function QrIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4z" />
      <path d="M9.5 9.5h1.6v1.6H9.5zM12.4 9.5h1.1M9.5 12.4v1.1M12 13.5h1.5v-1.5h-1.5z" />
    </svg>
  )
}
