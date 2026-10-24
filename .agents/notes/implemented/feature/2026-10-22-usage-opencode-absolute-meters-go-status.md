# Agent Note: OpenCode Go plan probe reads absolute meters from console go/status

Status: implemented

## Problem

The OpenCode Go plan adapter probed `https://opencode.ai/zen/go/v1/usage`, which reports only `percent` and `resetsAt` per window. Absolute water-line readings — how many dollars of a pool are consumed against its limit — are unavailable from that endpoint, so no consumer could render a consumed/limit pair or evaluate a threshold against the true unrounded ratio. The dsh web sidebar glance's usage-glance v3 requirement (red row signal when the week or month window reaches 85 percent of its pool, per the 2026-10-22 OpenCode Go plan reassessment; the `$used / $limit` read-out itself was ruled off-screen on 2026-10-24) therefore has no data to stand on. The absolute meters live behind the console status endpoint instead.

## Decision

The adapter's plan probe now targets `https://opencode.ai/console/api/go/status` with the same resolved bearer key, reading `access.meters.{fiveHour,week,month}` — each `{limitMicroCents, usedMicroCents, resetsAt}`. Micro-cents divide by 1e8 to dollars; `percent` derives from that same `used/limit` pair through the shared `usedPercent` helper, so the percentage and the absolute reading can never disagree. `PlanWindowView` gains optional `used`, `limit`, and `currency` fields carrying the absolute pair (USD); every other adapter leaves them absent, so the wire stays backward compatible. The meter's `resetsAt` passes through unconditionally, preserving the keep-at-0 semantics of [keep resetsAt at percent 0](../bug-fix/2026-10-17-usage-opencode-zero-percent-keeps-resets-at.md) — a used-0 meter still reports its real next reset. Live verification 2026-10-24: the endpoint answered HTTP 200 to the bearer key alone (no session cookie, no `x-org-id` header), and its three meters reconciled with the percent-only readings then on screen (week 26.30/30.00 = 87.7 percent against the reported 87).

## Alternatives considered

- **Keep the percent-only probe and synthesize dollars from the percentage.** Rejected: percent carries no pool size, so the dollar pair would be fabricated (an assumed limit drifts the moment the plan changes) and an 85 percent trigger would read a rounded integer instead of the true ratio.
- **Probe both endpoints in one adapter run.** Rejected: the probe pipeline is one `build`/`parse` pair per fact (`ProviderAdapter`), so a second request means widening the host contract for data the status endpoint already covers alone; two sources also open a disagreement window between percent and dollars.
- **Proxy `go/status` through a host endpoint outside this plugin.** Rejected: it moves opencode-specific credential handling into the generic host, forks a second data path beside this plugin's overview, and leaves this plugin's own plan view without the absolute pair. The 2026-10-24 ruling confirmed the landing in this adapter.

## Consequences

- Overview windows for `opencode-go` now carry `used`/`limit`/`currency` next to `percent`; consumers that ignore unknown fields (including the bundled client card, which renders `percent` only) keep working unchanged.
- `percent` is now a derived float instead of the upstream integer; consumers already round for display and the tone thresholds compare raw values.
- The probe dependency moved from the long-standing public usage endpoint to the console API surface: a console-side change makes the whole plan view degrade silently (windows drop, glance rows vanish) — the same failure mode the old endpoint had on probe errors.
- Installed copies of `@linxin666/dsh-usage` only pick this up on a package update; local patches made ahead of the release must be re-stamped after any `pnpm` update of `@linxin666/*`.

## Testing

- `pnpm --filter @linxin666/dsh-usage test`: the rewritten opencode-go suite asserts the go/status probe URL, the meter-to-window mapping with dollar pairs (1.05692364/12 and 26.29702489/30), percent derived from the same pair, the used-0 keep-at-0 reset, and the missing-meters degradation.
- Live probe 2026-10-24: a bearer-key request returned HTTP 200 and the three-meter document quoted in the Decision.
