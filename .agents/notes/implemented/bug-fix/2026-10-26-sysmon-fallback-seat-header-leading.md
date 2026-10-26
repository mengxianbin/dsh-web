# Agent Note: Sysmon chip fallback seat in the conversation header leading cell

Status: implemented

## Problem

The sysmon chip lived only in `conversation.session.header.actions`, a
session-scoped slot that renders solely while an open, non-blank Session
shows its header chrome. Two states therefore had no read-out at all: no
Session open (the header renders `headerLeading` and an empty title row, the
session header slot never mounts) and a blank Session (`hideChrome` drops the
whole title cluster, actions row included). A user watching machine health
during session triage — precisely when nothing is running — lost the chip
exactly when they wanted it.

## Decision

Seat the same chip body in a second, root-scoped position:
`conversation.header.leading`, the header cell that renders with no Session
and stays visible while a blank Session hides the actions row. The two seats
share one module-level mount signal (`src/client/presence.ts`): the primary
copy reports its mount from a `useLayoutEffect`, the fallback subscribes and
returns null while any primary copy exists, so exactly one copy ever paints
and the actions copy wins when both would be mounted. Layout-phase reporting
keeps the handover inside the same commit — a passive-effect signal would
flash two copies for one frame on Session open.

The signal is a mount count rather than a boolean so React StrictMode's
double-invoked effects cannot strand it. Each seat keeps its own poll loop
and its own 404-hide contract; when the host half is off, both hide
independently, so no settings surface is needed in either state.

## Constraints

- No harness change: the seat is a root-scoped slot the harness already
  declares and renders in every header state; the plugin registers into it
  like any other occupant.
- The pinned SDK cohort (`dsh-client-ui-conversation` ^0.1.2-rc.1) predates
  the slot in its `SlotMap`, so the client entry carries a type-only shim
  mirroring the harness declaration verbatim. The shim is annotated for
  removal when the repo's cohort catches up.
- The fallback copy sits outside `.titleRow`, so the chip's `@container`
  degradation ladder (unit labels drop at 620px, whole chip at 440px) does
  not bind on it; the header's own layout governs that cell instead.

## Alternatives considered

**Move the chip into a harness-added always-visible root seat (one position
for all states).** Rejected on cost: it changes core header layout plus the
snapshot/e2e suites and rebuilds the harness, for a position guarantee the
two-seat arrangement already provides. The accepted cost is that the chip
moves between states (left edge without a Session, beside the preset label
with one), which the README records as a known limitation.

**Register only the fallback seat and drop the actions seat.** Rejected: it
would relocate the chip away from the seat picked in the four-seat ruling
(「会话头部【标准模式】右侧空白」) for the common case to fix a corner case.

**Detect the primary seat's visibility from the DOM instead of a signal.**
Rejected as a polling/observer hack: the mount lifecycle already runs in the
same React tree, so a module-level signal is exact, synchronous, and free of
observer churn.

**Wait for the SDK cohort upgrade to inherit a harness-side exclusion.** No
such harness behavior exists to inherit — the exclusivity is plugin-local by
design — so this would be waiting for a thing that is not planned.

## Consequences

- The chip is now visible in all three header states; the blank-session and
  no-session screens show it at the header's leading edge.
- Session open/close performs a same-commit handover between seats; a Session
  transition momentarily mounts both React subtrees (one fetch overlap at
  worst), then the fallback settles to null.
- `tests/sysmon-seats.spec.tsx` pins the exclusivity in both mount orders,
  the handover on primary unmount, and the presence counter's
  subscribe/unsubscribe contract (45 package tests green).
- README pair, package AGENTS.md, and this note describe the two-seat
  arrangement; the type-only SlotMap shim is the one piece that must be
  revisited at the next SDK cohort bump.
