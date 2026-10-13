# Agent Note: Usage plan bar tone classes keep the fill geometry

Status: implemented

## Problem

The personal-plan tab renders each quota window as a track (`bar`) with an inner fill span whose width is the used percentage. The fill's class comes from `toneClass(percent)`, which returned exactly one class: `barFill` below 70%, `barWarn` at 70-89%, `barLow` at 90% and above. `barWarn` and `barLow` only declare `background`; the geometry that makes the span visible (`height: 100%`, `border-radius`, `transition`) lives only on `barFill`. Above 70% the empty inline span therefore had no height, collapsed to zero, and the row rendered as a bare track with the percentage label but no fill — the monthly window of a heavily used account (75%+) hit this every time, while the 5-hour and weekly windows below 70% looked correct, which made the defect look intermittent.

## Decision

`toneClass` now always returns `barFill` and appends the tone class (`barFill barWarn`, `barFill barLow`) so the geometry classes stay present in every band. The CSS stays as written: `barWarn`/`barLow` remain background-only overrides, and because they follow `barFill` in `usage.module.css` they win the cascade on `background` at equal specificity. The regression test asserts the exact ordered class list of the fill span at 12.5%, 75%, and 95% against the CSS module object, so a future tone class that loses the geometry, or a reordering that changes which background wins, fails the suite.

## Alternatives considered

- **Give `barWarn`/`barLow` their own `height: 100%` (and radius/transition) in CSS.** Rejected: it triples the geometry declaration, and the next background-only tone added the same way would reintroduce the bug silently. Keeping geometry on one class and tones as pure overrides makes the invariant mechanical to state.
- **Merge the tone color into `barFill` via a modifier custom property.** Rejected: larger rewrite of the stylesheet for a rendering defect, with no test-visible contract change beyond what the class-list assertion already pins.
- **Clamp or normalize `percent` instead.** Rejected: the width was already correct; the defect was purely the missing geometry class, so touching value handling would fix nothing.

## Consequences

Quota windows at or above 70% render their fill again (amber at 70-99%, red at 90%+ over the same geometry). The fill span now always carries two classes in the tone bands; any skin or consumer selector written against "exactly one class on the fill" would need updating, but the surface is `data-dsh-part="plan-window"` and skins anchor on that, not on the fill's class list.

## Testing

- `pnpm --filter @linxin666/dsh-usage test`: 7 files, 85 tests pass, including the three new band assertions.
- The new assertions fail on the pre-fix `toneClass` (verified by stashing the fix: 2 of 3 bands fail) and pass with it.
- `pnpm --filter @linxin666/dsh-web-all build` regenerates the tracked aggregate client bundle carrying the fix; `toneClass` in `packages/dsh-web-all/lib/client.js` shows the two-class returns.
