# Agent Note: The bridge keeps its own follow streams, so a card and a notification need no client

Status: implemented

Sibling surfaces: [push notifications](2026-10-21-remote-bridge-push-notifications.md) owns §28 and [one card, several sessions](../feature/2026-10-22-remote-bridge-live-activity-rows.md) owns §29. This note owns who holds the `session/follow` stream that makes either of them fire while nothing is attached.

## Problem

§28 and §29 both deliver at `turn/end`, and every `turn/end` the bridge saw arrived on a stream a client had opened with `session/follow`. A phone that locks is a phone whose socket iOS closes, so the one moment a notification or a card exists for — the turn that ends while nobody is watching — was the one moment the bridge produced nothing: no stream, no event, no push. A card that must say `ended` on a lock screen and a notification that would arrive at the next unlock are the same failure with two surfaces.

## Decision

- **One host-side component owns streams of the bridge's own.** `StandingWatchers` (`packages/dsh-remote-bridge/src/host/watchers.ts`) keeps them, and it is armable only where a push path exists: with neither a live-activity channel nor an APNs channel configured, `enabled` is false, no stream is opened and nothing is logged, so a bridge that cannot deliver also never reads a session.
- **The device roster is the trigger, and a carded session is the unit.** A session holding at least one live-card token in `$DSH_HOME/remote-bridge/devices.json` gets one `session/follow` stream, opened by the bridge over the same in-process owner peer a client call uses, so the harness is asked for exactly what a phone would have asked for; `maxMessages` defaults to the same `SNAPSHOT_MAX_MESSAGES` window a client's snapshot opens.
- **Add and remove are reconciled from the roster, never from a connection's lifetime.** `BridgeConnection` gained one hook, `onPushRegistered`, called after `push.register` stored a token and guarded at that call site so a standing watcher can never turn registration into a failure; the `410` that retires a dead token calls the same `sync()`, and the roster read that runs at mount reconciles what the file already holds. A session whose last live-card token is gone loses its stream (`watcher close session=… reason=cards-gone`).
- **The count is capped, and the refusal is one line per session.** `WATCHER_LIMIT` is 64; past it no stream is opened for that session and exactly one line says so (`watcher refused session=… reason=limit(64)`), remembered so a later registration for the same session does not repeat it.
- **A stream that ends on its own is re-armed once, one second later.** `WATCHER_REOPEN_MS` is 1000 ms: a closed follow stream is not a verdict about the session, so a session that is still carded keeps being watched.
- **Failure is one line, never the caller's.** A stream the host refuses, a follow that throws mid-flight and a reconcile that cannot read the roster each log one `watcher` line and are dropped; a refused stream is not retried until the roster changes again.
- **One `turn/end` feeds both surfaces, through the quiet gate.** A watcher registers the turn end with `TurnEndQuietGate` and logs `watcher turn-end session=… reason=… held=quiet-gate`; the gate announces it once the host reports the session quiet, notification first and the card end beside it ([`§28`'s quiet gate](2026-10-21-remote-bridge-push-notifications.md) owns that rule). A watcher set assembled without a gate reports at the frame instead, with `pushed=card` or `pushed=notification-only`.
- **No third dedupe layer.** A session watched by the bridge and opened by a client reports the same `turn/end` twice; §28.5's `sessionId+event` window and §29's content key already settle that, and the suite asserts one card, one notice and one line.

## Testing

`tests/watchers.spec.ts` (11 cases) covers this at the connection layer: one stream per carded session and the address it asks for, the card ending when the watched turn ends with the §28 notice going beside it, a bridge with no push path opening nothing and logging nothing, a session losing its last card closing its stream, the count capped with the refusal logged once, a stream that ended on its own catching the next turn, a host-refused stream surviving without a frame being touched, one `turn/end` reported by two streams still producing one card and one notice, every stream closed when the bridge is disposed, `push.register` being what arms the watcher, and a held turn end surviving the notice of a child that settled. `pnpm typecheck` is green and the package runs 45 files and 626 cases green.

## Alternatives considered

- **Let the client keep the stream open across a lock.** Rejected: iOS decides how long a socket lives and the bridge cannot argue with it, so the surface that matters most — the lock screen — is exactly the state the app is not in.
- **Reconcile the roster on a timer.** Rejected: a change of the device roster already announces itself (a `push.register` writes a token, a `410` retires one), and a poll would be a second reading of a truth the roster already holds.
- **Remember each stream's position and resume it.** Rejected: the lifetime a watcher obeys is the token's, not the stream's; re-opening from the roster keeps every piece of state in the file the phone writes, while a remembered cursor would be a second state to invalidate.
- **Add a third dedupe layer for the watcher's own reports.** Rejected: §28.5 and §29 already settle a repeated report, and a third key would be a second opinion about the same event with its own bug surface.
- **Fail `push.register` when the watcher cannot open.** Rejected: registration's whole job is the token and the watcher is background work, so the hook is guarded at its call site rather than given the power to refuse a phone.

## Consequences

- A bridge with no push channel configured opens nothing, so the feature costs nothing where it cannot deliver anything.
- The bridge holds up to 64 follow streams and their windows of its own; that is the memory the cap exists to bound.
- A refused stream stays refused for that roster state — only a roster change re-arms it, which is why the refusal is logged rather than retried.
- The bridge and a client can watch one session at the same time; the two existing dedupe layers are what make that double observation one fact on the card and on the lock screen.
