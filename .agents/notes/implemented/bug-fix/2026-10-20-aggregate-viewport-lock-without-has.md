# Agent Note: Root viewport lock without :has() (aggregate compat stylesheet)

Status: implemented

## Problem

The aggregate compat stylesheet locked the scrolling root with two rules that
scoped themselves through `:has()`:

```css
html:has([data-dsh-frame]),
html:has([data-dsh-frame]) > body { height: 100%; width: 100%; overflow: hidden; }
```

`:has()` is evaluated against the whole ancestor chain of every node whose style
invalidates, up to the root. Any large synchronous DOM rebuild therefore paid it
once per inserted node, and the price grew with the page's total node count
rather than with the number of matches. The visible symptom was a terminal
plugin re-creating its row elements on a `fontSize` change: the rebuild itself is
cheap, but the compat stylesheet turned it into a multi-frame stall, and only
when the aggregate package was installed (issue #1913).

The issue report attributed the cost to the shared body-`MutationObserver` hub
(`shared/client/body-mutations.ts`). That attribution does not hold: every
consumer of the hub subscribes through `subscribeBodyInvalidations`, so
`needsRecords` is always false, no `MutationRecord` is ever retained, and the
hub's own callback is a no-op that schedules one animation frame.

## Decision

- **The viewport lock is scoped to a root attribute, not to `:has()`.** The
  stylesheet keys on `html[data-dsh-frame-active]` (and
  `html[data-dsh-frame-active] > body`), a plain attribute selector that costs
  one match per style invalidation.
- **The shim maintains that attribute in the pass it already runs.**
  `applyShims()` calls `syncFrameLock(frame !== null)` after it stamps the frame,
  so the attribute is present exactly while a frame is stamped and cleared again
  when React replaces the shell and the next pass finds no frame. The lock never
  outlives the frame it locks.
- **`applyShimsForTest()` is exported as a test seam** so a spec can assert one
  pass's effect without waiting for the hub's animation frame. Production code
  still reaches the pass only through the hub.

## Evidence

Measured on a shell-shaped page (1500 sidebar `role=treeitem` rows plus code
blocks, 108,009 nodes) driving real `@xterm/xterm` 5.5.0 through a `fontSize`
change in Chromium, alternating the two committed aggregate bundles three times
each so drift cannot favour either side:

| Bundle | Fix | `fontSize` set (sync) | Settled |
| --- | --- | --- | --- |
| `origin/main` | `:has()` root lock | 17.0 / 17.0 / 16.6 ms | 58.3 / 59.9 / 55.7 ms |
| this change | `html[data-dsh-frame-active]` | 13.3 / 13.1 / 13.2 ms | 27.0 / 26.9 / 27.1 ms |

The lock is unchanged in both: `getComputedStyle(document.documentElement)`
and `getComputedStyle(document.body)` both report `overflow: hidden`, and the
frame is stamped.

Removing the `:has()` rules alone, with the rest of the stylesheet untouched,
reproduced the same recovery (48.0 ms to 22.7 ms settled), and removing the
mobile `@media` block instead changed nothing (50.5 ms), which isolates the two
root rules as the whole cost.

Node-count scaling of the two scopes, same harness, one run per size:

| Page nodes | `:has()` settled | attribute settled |
| --- | --- | --- |
| 22.5k | 12.3 ms | 12.5 ms |
| 64.5k | 31.5 ms | 13.1 ms |
| 127.5k | 58.1 ms | 24.2 ms |

The `:has()` variant alone scales with page size; the attribute variant tracks
the terminal's own rebuild cost.

## Alternatives considered

- **Narrow the `MutationObserver` scope or drop the hub.** Declined on evidence:
  the same harness with the observer present and the shim still running showed no
  measurable difference (no observer 2.4 ms / 12.5 ms; hub plus one shim pass
  2.2 ms / 12.5 ms; hub plus eight passes 2.3 ms / 12.6 ms). The report's proposed
  fix would not have moved the number.
- **Keep `:has()` and gate it on a smaller ancestor.** Declined: any `:has()` in
  the invalidation path keeps the ancestor-chain walk, and the rule must be
  anchored on the root to lock document scrolling.
- **Drop the viewport lock.** Declined: the lock is the fix for issue #1135
  (a focused disclosure control scrolling the whole page down). The attribute
  keeps the lock and removes only its cost.
- **Scope the four whole-frame `querySelectorAll` sweeps in `stampSemanticParts`.**
  Measured at 0.7 / 2.6 / 6.0 ms per pass for 13.5k / 45k / 108k nodes, i.e. real
  but an order of magnitude below the `:has()` cost, and narrowing them reworks
  the compat shim every DOM-mounting plugin depends on. Left out of this change;
  a single `TreeWalker` pass with the identical predicate was measured *slower*
  (1.4 / 5.0 / 14.0 ms), so the sweep shape is not the lever here.
- **Observe `attributes` on the body to maintain the attribute reactively.**
  Declined: the shim's existing pass already runs whenever the frame can change,
  and a second attribute observer is exactly the per-plugin body observer the
  shared hub exists to remove.

## Consequences

- A terminal-style DOM rebuild in the presence of the aggregate package no longer
  scales with the page's node count. The remaining cost is the shim's own
  per-frame sweep, which is independent of the report's data.
- The lock now follows a shim-maintained attribute instead of a DOM fact. A page
  that stamps `data-dsh-frame` itself without going through the shim no longer
  gets the lock; nothing in the repository does that (the frame is stamped only
  in `applyShims`).
- The stylesheet keeps a single `:has()` rule for the collapsed-rail settings
  dialog (#1510). It is anchored on the dialog subtree rather than the root, and
  this change does not touch it.

## Testing

- `packages/dsh-web-all/tests/responsive-contract.spec.ts` asserts the lock is
  scoped to `html[data-dsh-frame-active] > body` and that the stylesheet contains
  no `:has([data-dsh-frame])`; a new case mounts a frame, then replaces the shell
  with a body carrying no frame, and asserts the root attribute is cleared.
- Gates: `pnpm typecheck`, `pnpm test`, `pnpm test:standards`, `pnpm docs:check`,
  `pnpm i18n:check`, `pnpm aggregate:check`, `pnpm libs:check`.
