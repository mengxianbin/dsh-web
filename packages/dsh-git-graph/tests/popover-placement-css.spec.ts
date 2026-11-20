/**
 * Popover placement guard: the measured side (BranchPopover writes
 * `popoverUp` / `popoverDown` from the room around the chip) must win over the
 * seat's own anchor rules, and the card's 360px cap must leave the branch list
 * as the part that scrolls.
 *
 * The file is a CSS module, so every class in it carries the same specificity:
 * only source order decides between `.popover`, `.popoverHero`, `.popoverUp`
 * and `.popoverDown`. A rule that sets `top` or `bottom` and lands above the
 * measured pair silently pins the card to one side again — exactly the bug the
 * hero seat shipped with (the card always opened downward from a row at the
 * bottom of the window, and the composer's scroll container clipped it).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/client/chips/context.module.css', import.meta.url), 'utf8')

/** Extract one top-level rule block's body by its class name. */
function ruleBody(name: string): string {
  const match = new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(source)
  if (match === null) throw new Error(`.${name} rule not found in context.module.css`)
  return match[1] ?? ''
}

/** The offset of one class's rule in the source. */
function ruleOffset(name: string): number {
  const offset = source.indexOf(`.${name} {`)
  if (offset < 0) throw new Error(`.${name} rule not found in context.module.css`)
  return offset
}

describe('popover placement css', () => {
  it('user sees the measured upward side win over the hero seat rule', () => {
    // Given the hero seat anchors the card below its chip in source.
    expect(ruleBody('popoverHero')).toMatch(/top:\s*calc\(100% \+ \d+px\)/)

    // When the measured upward rule is read.
    const body = ruleBody('popoverUp')

    // Then it is declared later and re-anchors the card above the chip.
    expect(ruleOffset('popoverUp')).toBeGreaterThan(ruleOffset('popoverHero'))
    expect(body).toMatch(/top:\s*auto/)
    expect(body).toMatch(/bottom:\s*calc\(100% \+ \d+px\)/)
  })

  it('user sees the measured downward side win over the dock seat rule', () => {
    // Given the base rule anchors every card above its chip in source.
    expect(ruleBody('popover')).toMatch(/bottom:\s*calc\(100% \+ \d+px\)/)

    // When the measured downward rule is read.
    const body = ruleBody('popoverDown')

    // Then it is declared later and re-anchors the card below the chip.
    expect(ruleOffset('popoverDown')).toBeGreaterThan(ruleOffset('popover'))
    expect(body).toMatch(/bottom:\s*auto/)
    expect(body).toMatch(/top:\s*calc\(100% \+ \d+px\)/)
  })

  it('user sees the hero seat keep opening downward by default', () => {
    // Given a hero card before its first measurement.
    const body = ruleBody('popoverHero')

    // When its anchor rule applies.
    // Then it sits under the chip, as the official workspace picker does.
    expect(body).toMatch(/top:\s*calc\(100% \+ \d+px\)/)
    expect(body).toMatch(/bottom:\s*auto/)
  })

  it('user gets a scrollable branch list inside the card 360px budget', () => {
    // Given the card caps its own height.
    expect(ruleBody('popover')).toMatch(/max-height:\s*360px/)

    // When the list is read.
    const body = ruleBody('list')

    // Then the list caps itself and scrolls, so the card never grows past it.
    expect(body).toMatch(/max-height:\s*\d+px/)
    expect(body).toMatch(/overflow-y:\s*auto/)
  })
})
