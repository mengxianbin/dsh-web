# Agent Note: OpenCode Go windows keep resetsAt at percent 0

Status: implemented

## Problem

The OpenCode Go adapter dropped `resetsAt` whenever a quota window reported `percent === 0`, on the theory that a 0% window's reset instant is only a placeholder (now + window length). The upstream endpoint contradicts that: a freshly reset window still carries its genuine next-reset instant (verified against the live `https://opencode.ai/zen/go/v1/usage` endpoint on 2026-10-17 — percent 0 monthly reported `2026-11-17T10:29:32Z`, exactly one month out). With the field dropped, every downstream consumer that derives a cycle position from the reset instant goes blank for the whole fresh cycle. The dsh web sidebar's plan glance hit exactly that: immediately after the monthly reset its day-progress bar rendered `— / —` with an empty track, because the glance derives elapsed/total days from the window's `resetsAt` and there was nothing to derive from.

## Decision

The adapter now passes `resetsAt` through unconditionally (`toIso(row.resetsAt)`), percent 0 included. The reset instant is data the provider reports; whether it is useful is the consumer's call. `toIso` already normalizes absent or unparseable values to `undefined`, so windows that genuinely lack a reset still degrade the same way as before.

## Alternatives considered

- **Keep the drop but let the glance fall back to a synthesized instant.** Rejected: it fabricates data the provider did report, and the fabrication (now + window) would drift from the real reset boundary.
- **Keep the drop and accept the blank day bar at percent 0.** Rejected: the fresh cycle is precisely when the remaining-days reading matters most, and the upstream value is real, not a placeholder.

## Consequences

Fresh (0%) windows now carry their reset instant through the overview document. Consumers that show a reset countdown or a cycle day bar render correctly right after a reset. Any consumer that relied on "resetsAt is absent at percent 0" as a signal would need updating; no such consumer exists in this repository — the overview route is the only exporter.

## Testing

- `pnpm --filter @linxin666/dsh-usage test`: 7 files, 85 tests pass, including the rewritten opencode-go parse case that now asserts the percent-0 window keeps its `resetsAt`.
- The rewritten assertion fails on the pre-fix adapter (it expected `resetsAt: undefined` for the percent-0 window) and passes with the fix.
