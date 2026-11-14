/**
 * Status glyphs of the agents page.
 *
 * The family draws its own vectors: one 16-unit viewBox, `fill="none"`,
 * `stroke="currentColor"`, `stroke-width="1.3"`, round caps and joins, exactly
 * the convention panel.tsx's sidebar glyph already uses. No icon dependency is
 * added and no emoji, letter or punctuation stands in for a glyph.
 *
 * Every status also renders its own text label beside the glyph, so a reader
 * who cannot see the colour or the shape still gets the state (L5).
 *
 * @module @linxin666/dsh-agents/client
 */
import type { ReactNode } from 'react'
import type { StatusTone } from './runs.ts'

/** The drawing of one tone, in the shared 16-unit box. */
const TONES: Record<StatusTone, ReactNode> = {
  // A clock hand: the session exists and has not started working yet.
  pending: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.9v3.4l2.2 1.5" />
    </>
  ),
  // A play mark: the session is running now.
  active: <path d="M6.3 4.9 11.1 8l-4.8 3.1z" />,
  // A tick: the run settled.
  success: <path d="M4.2 8.3 6.7 10.8 11.8 5.4" />,
  // A cross: the run failed.
  error: <path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" />,
}

/**
 * Render the glyph of one status tone.
 * @param props - the tone to draw.
 * @returns a decorative 12px vector, sized for an 11px status line.
 */
export function StatusGlyph({ tone }: { tone: StatusTone }): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {TONES[tone]}
    </svg>
  )
}
