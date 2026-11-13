# Agent Note: Session revive relay line cut

Status: implemented

## Problem

The first cut of `dsh-session-revive` reserved a relay line: `RevivalPolicy.bindRelay` would bind a relay session onto its origin's quota chain so a freshly opened body could not refresh the old session's can (design §4.2, "relay 计入同一预算链"). It shipped unwired — `relayOf` was never written and `bindRelay` was never called — while the README kept promising that the bot relay branch lands with the relay line. The 2026-11-09 relay regime ruling (m-note ask receipt id `q-bot`, "砍判据留兜底") judged the line never to be built: after the 300k compaction gate the relay's money benefit fell to 3-5% of the daily account and keeps decaying, and bot handoff falls to the taskbot fourth signal (nudge first) outside this plugin.

## Decision

Remove the reserved relay line from the package. `RevivalPolicy` loses the `relayOf` map, `bindRelay`, and `chainIdOf`; quota chains collapse onto the session id (`chainId` remains the record and snapshot field name, now always equal to the session id). `forget` deletes the session's can unconditionally because chains are session-scoped. The wave-release test now fills the held session's own can instead of borrowing an origin chain, and the `reserved relay chain field` describe block leaves with the capability. The README known-limitation line states the current contract: this plugin never relays a parked session to a fresh body. The context watermark gate is untouched by this cut (150k at the time; raised to 300k on 2026-11-13 by the [watermark raise](../feature/2026-11-13-session-revive-watermark-300k.md), then to 1M on 2026-11-14 by the [watermark raise](../feature/2026-11-14-session-revive-watermark-1m.md)) — only the 150k routing split and the relay line were cut.

## Alternatives considered

- Keep the placeholder behind a tombstone comment ("cut 2026-11-09"): rejected — `bindRelay` would stay a callable method able to silently merge two sessions' quota chains, and the suite would keep proving a capability that no longer exists.
- Keep `chainIdOf` as an identity function: rejected as vestigial indirection; inlining keeps the quota code honest while the field vocabulary stays on the records.

## Consequences

- No behavior change: production never wrote `relayOf`, so the gates prove equivalence rather than a new path.
- The m-note side carries the ruling: `content/tech/ai/dsh/session-auto-revival-design-1102.md` §2 and §4.2 take the re-judgment note, the ruling archive is `content/tech/ai/dsh/relay-regime-1109.md`, and the board row is `content/tech/ai/dsh/tasks.md#revive-relay-line-cut-1109` (all main tree).
- [session-revive](../feature/2026-11-03-session-revive.md) keeps its decision; only its relay facts were updated in the same change.
- The running dsh web host keeps serving the old bundle until a user-owned restart; no session lifecycle API was touched.

## Testing

`pnpm typecheck`, `pnpm test` (65 tests), and `pnpm build` pass in the package; `pnpm docs:check` and `pnpm i18n:check` pass after the README pair edit. No test touches a real session lifecycle.
