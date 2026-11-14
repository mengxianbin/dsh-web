/** Third-party sections make first-level nav positions unstable. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/web-ui-settings.module.css', 'utf8')

describe('Web Extensions nav icon safety', () => {
  it('does not paint positional icons onto unrelated plugin entries', () => {
    expect(css).not.toContain('[class*="_navCell"]:nth-child(')
    expect(css).not.toContain('[class*="_navIcon"]')
    expect(css).not.toContain('background: currentColor')
  })
})
