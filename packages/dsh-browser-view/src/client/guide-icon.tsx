/**
 * The guide capsule's glyph: this plugin's own mark, not a product artwork.
 *
 * The right sidebar's guide lists one capsule per registered tab type and draws
 * the type's `icon` (a `ComponentType<IconProps>`) at 22px, or 26px beside a
 * description. Drawing locally keeps the plugin free of icon-set coupling: the
 * only thing borrowed is the IconProps shape, as a type, and the glyph itself
 * inherits its colour from the capsule through currentColor.
 *
 * It restates the mark the chip already uses - a browser
 * window with the agent's cursor inside - so a user who has seen one recognises
 * the other. It is deliberately not the shipped browser tab's artwork: this tab
 * is a different implementation and does not pass itself off as that one.
 */
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the guide glyph.
 * @param props - square edge in px (the guide passes 22 or 26) and a layout class.
 * @returns the window-and-cursor mark.
 */
export function BrowserViewGuideGlyph({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.75 5.75h12.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3.9" cy="4" r="0.7" fill="currentColor" />
      <path d="M7.4 8.15l3.85 1.7-1.6.65-.7 1.65z" fill="currentColor" />
    </svg>
  )
}
