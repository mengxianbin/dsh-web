# Agent Note: One delivery per APNs token, and one row per phone

Status: implemented

## Problem

One phone produced two identical notifications. The bridge delivered an event once per row of `$DSH_HOME/remote-bridge/devices.json`, and one iPhone held the same APNs token on two of them: the handset in use sat on 2 rows, and a second token of that same phone had landed on 34 rows after 43 re-pairings.

Four facts made that possible, and they chain. `pair.finish` calls `roster.enroll(devicePubKey)` on every accept, and `enroll` minted a fresh row under a fresh token hash instead of reusing the row the public key's fingerprint already owned, so every re-pairing added a row. `registerPush` then wrote only the row of the device that was connected at that moment, and the older rows kept a registration that is still valid, because an APNs token belongs to the app install rather than to one pairing. `pushTargets()` reports one target per row, and `PushNotifier`'s `#announce` admitted the event once by `(sessionId, event)` and then sent it per target, so 2 rows were 2 deliveries of one event. `src/host/apns.ts` sends no `apns-collapse-id`, so iOS had nothing to merge them with.

The ledger is also the one place an operator cannot repair by hand: the running host holds the table in memory and writes the whole of it back on the next touch, so an edit is resurrected, and deleting the file un-pairs every device at once.

## Decision

- The sender converges its target list by `deviceToken` before fan-out (`src/core/push.ts`), first row winning, and makes one delivery per token. One token is one app install is one lock screen, so the several rows holding it are that one phone rather than several phones. The three limits beside this rule, `PUSH_DEDUPE_MS`, `PUSH_SESSION_INTERVAL_MS` and `PUSH_GLOBAL_PER_MINUTE`, keep their values and their meaning, and no `apns-collapse-id` is added.
- `enroll` reuses the row a fingerprint already has (`src/core/devices.ts`): same `deviceId`, same `createdAt`, its `push` block untouched, `lastSeenAt` refreshed to now. Only the credential moves, because a freshly minted bearer token replaces the map key, so the token from before the pairing stops authenticating. A fingerprint that already owns several rows is settled first, the most recently seen row kept (a tie goes to the later `createdAt`) and the rest dropped.
- A successful load compacts the table in memory and writes the result back: rows collapse to one per fingerprint, then an APNs token is kept on the row that registered it last, where every other row holding it keeps its identity and loses only the `push` block, which is what `removePush` already leaves behind. A survivor that never registered takes the newest registration one of its dropped rows carried, since that is the same install's token. The write goes through the roster's existing serialized queue (see [the roster write-serialization note](2026-10-24-remote-bridge-roster-write-serialization.md)) and happens only when the pass changed something, logging one line: `compacted N duplicate row(s), retired M stale registration(s)`.
- The on-disk format is untouched: still `version: 2`, no new field, no new public method, and a version-1 file reads exactly as it did.
- This note owns the delivery rule; [the push channel note](../architecture/2026-10-21-remote-bridge-push-notifications.md) owns what a notification may carry, and this one owns how many of them one phone gets.

## Alternatives considered

- **Deduplicate in the sender only.** Rejected: the ledger keeps growing exactly as it does today, 254 rows measured on one host with one phone on 43 pairings of its own, so the disease is untouched and only its symptom is kept off the lock screen.
- **Compact the device table only.** Rejected: a running host holds the table it loaded, so until it restarts the very same event still fans out row by row, and the reproduction window stays open for the whole life of a long-running host.
- **Send `apns-collapse-id` and let iOS merge the banners.** Rejected: it hides N deliveries behind one banner while the APNs request count and the throttle budget stay exactly what they are, and it would silently merge two events that are supposed to stay apart.
- **Hand-edit or delete `devices.json`.** Rejected: the running host writes its in-memory table back on the next touch, so the edit is resurrected, and deleting the file un-pairs every device the operator ever paired.
- **Make the fingerprint the roster's primary key.** Rejected: the token hash is the authentication entry and the row did not pick the wrong key; what was missing is the rule that one phone keeps one row, which is now enforced where rows are written and where they are read.

## Consequences

- A re-pairing is a credential change rather than a new device: the phone keeps its id, its creation time and its notifications, and the token it held before the pairing is refused.
- A table written by an earlier host shrinks on the first start after this change, once, on one log line; later re-pairings no longer add rows at all.
- APNs requests now match devices rather than rows, so the rolling-minute budget is spent on distinct phones. A device whose registration is retired keeps its row and simply asks for no notification until the app's next `push.register`, which writes a complete block, and nothing here un-pairs a phone.
- A retired block takes its Live Activity tokens with it, which the same install's next `push.register` rewrites in full.
- `tests/push.spec.ts` pins one delivery per token (two rows, one send, that one payload, and each distinct token still reached) and the compaction of a hand-written table (rows and tokens collapsed, the file rewritten compacted, one log line, a second load a no-op); `tests/pairing.spec.ts` pins the enroll reuse (one row, same id and creation time, registration kept, old token rejected).
