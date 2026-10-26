# Agent Note: Usage Probe Stale-Fact TTL

Status: implemented

## Problem

`UsageService.probeRoute` retained the previous balance/plan fact on a failed probe ("stale but useful") with no bound. When the MiMo platform SSO cookie expired, the balance probe returned HTTP 401 on every cycle while the snapshot kept serving the last success — the sidebar glance showed a frozen `¥36.87` for 27 hours with no staleness signal anywhere in the wire document. The error line recorded the failure, but the fact itself never aged out, so a dead channel presented its frozen figure as current indefinitely. The "no credential" path already resets the row (retained facts would never refresh), but "credential present, probe failing" had no equivalent degradation.

## Decision

Add `STALE_FACT_TTL_MS` (2 hours) and a `pastFactTTL()` helper in `src/host/usage-service.ts`. A failed probe keeps the previous fact only while the fact's own `updatedAt` (the last successful probe instant) is within the TTL; past it, the fact degrades to absent and the error line stays to explain the absence. The TTL is measured from the fact's own probe instant, so it survives restarts via the persisted snapshot, and a fact carried over from an old disk state ages out on the first failing cycle. A fact without a numeric `updatedAt` (legacy persisted shape) counts as past the TTL — it degrades rather than riding forever. Both probe halves (balance and plan) share the rule.

## Alternatives considered

- Consecutive-failure counter: rejected — it resets across restarts unless separately persisted, and the count-to-time mapping shifts with the poll interval. The fact's own age is already persisted and interval-independent.
- Dropping the fact on the FIRST failure: rejected — transient blips (provider restart, network hiccup) would blank the figure on every hiccup, which is what the retention existed to avoid.
- Only marking staleness in the UI without host-side expiry: rejected — the glance would still need a trustworthy age bound to decide when to hide versus mark, and every other consumer (pet announcements, the settings section) would need to reimplement it.

## Consequences

Within the TTL the behavior is unchanged (stale figure + error line). Past the TTL the glance figure degrades to an em dash and the pet bubble falls back to the ledger usage bubble; a successful probe restores the fact immediately. The sibling UI change (deepseek-harness `UsageGlance`, FORK usage-glance-stale-fact-ttl) marks the retained figure stale — asterisk, dimmed color, and the fact's own probe stamp in the tooltip — during the still-fresh window, so the two halves cover the full outage timeline: marked while fresh-carried, gone once aged out.

## Testing

`tests/usage-service.spec.ts` gains two cases under "probes and per-fact errors": a balance fact survives a failing probe inside the TTL and degrades to absent past it (error line retained), and a plan fact obeys the same TTL. The suite's shared `afterEach` now calls `vi.useRealTimers()` so the fake-clock tests cannot leak into the lifecycle and persistence specs.
