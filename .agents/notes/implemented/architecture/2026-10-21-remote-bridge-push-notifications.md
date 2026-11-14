# Agent Note: Push notifications beside the wire, and why they are not state

Status: implemented

## Problem

The remote bridge is a live socket and nothing else. Every fact a phone needs already has a read on `/ios/v1`, but all of them need that socket to be open: a turn that ends while the phone is asleep, a turn that fails, a newly claimed question or approval — none of it exists anywhere the phone can see until it reconnects. iOS decides how long that socket lives, and the bridge cannot argue with it.

The obvious-looking fix is to let the notification carry the fact, so a phone needs no read at all. That trade is wrong on two counts this repository has to live with: the payload crosses Apple's servers, appears on a lock screen and stays in notification history, and a payload carrying session content turns the bridge into a second source of truth for state it does not own. What shipped is the narrow half — a notification says an event happened, and the client still reads the fact over the existing protocol.

## Decision

- Protocol §28 adds one capability, `push.v1`, and one write method, `push.register`; `hello.r.minor` rises from 15 to 16. No topic, no frame and no existing method changes shape, so a client that never declares the capability is served byte for byte what it was served before.
- `push.register` takes `{deviceToken, environment, bundle, liveActivityTokens?, locale?}` and answers `{ok:true}` — no echo, no "ready" flag. The registration lands in the device's own row of `devices.json`, whose on-disk schema moves from 1 to 2 as an additive optional `push` block. Revoking a device still means deleting its row, and the registration goes with it.
- The reader accepts any roster version whose row table validates, and drops only an unreadable `push` block while keeping the row: a schema bump must never quarantine a table of paired phones, and one bad token must never un-pair a device.
- `PushNotifier` (`src/core/push.ts`) sends for exactly two events: a `turn-end` delta, where an abnormal `reason` becomes `turn-error`, and a question or approval claim that actually reached a connected client. A claim withdrawn for reaching nobody sends nothing, because there is nothing left to act on.
- Delivery is deduplicated and capped rather than queued: the same `(sessionId, event)` inside 30 s is one notification, two notifications about one session are at least 10 s apart, and the bridge sends at most 30 in any rolling minute. What exceeds a limit is dropped.
- Notification work never touches the frame path. `notify` returns before anything is sent, starts delivery on its own microtask, swallows and logs every failure, and the APNs client resolves `{ok:false, status, reason}` instead of rejecting. A broken APNs connection cannot delay, reorder or suppress a frame that a connected phone is waiting for.
- `src/host/apns.ts` is `node:http2` plus `node:crypto`: an ES256 provider token (`{alg,kid}` over `{iss,iat}`, raw r||s), `apns-topic` from the registration's bundle, `apns-push-type: alert`, cached for 45 minutes and abandoned after a 10 s timeout. No dependency was added.
- The capability gates the write only. Whether a key is configured decides whether anything is ever sent, and the wire cannot express that difference; the protocol says so explicitly rather than leaving a client to infer it from silence.
- The stream that makes a `turn/end` reach this channel while no client is attached is [the standing watchers note](2026-10-22-remote-bridge-standing-watchers.md)'s decision; this channel owns what may be delivered once it does.

## The payload is a lock-screen budget

- The body carries `aps.alert.title` (the session's own name, the same source §26 reads), `aps.alert.body` (one fixed status line), `aps.sound`, `w` (the workspace short name, omitted when the bridge cannot resolve one), `s` (the session id), `st` (the event) and `url` (`whale://session/<id>`). Nothing else exists in the type.
- No message text, no reasoning, no tool arguments, no tool output, no file name, no path, no command, no question body, no option label, no approval reason, and no "summary" field that could smuggle any of them back in. The two human-readable strings are the user's own session title and a constant.
- The unit suite asserts that rather than describing it: the approval case feeds a real `displayReason`, the question case feeds a real question body, and both assert the leak strings are absent from the serialized payload while the key set is exactly the documented one.

## A turn end is announced when the session is quiet

- A `turn/end` increment is a fact about one turn, not about the work the session still holds: the child sessions it delegated to and the jobs the host keeps under them outlive it. `PushNotifier` therefore no longer sends at the frame. `TurnEndQuietGate` (`src/core/turn-end-quiet.ts`) registers the event and announces it once the host reports the session quiet, and both turn-end surfaces wait on that one answer — §28's notification and §29's card end.
- Quiet is the question the client already answers in `SessionRun`, from the three of its four kinds of evidence a host can see: `agentRunning` for the session itself, any descendant session on the parent chain still running, and no live job the host attributes to either. The chain is walked to any depth and stops at an id already walked, so a looping one terminates instead of holding a notification for ever.
- Both facts come from the host, read per question and injectable per suite: one `session/list` call for the running flag and the parent chain, and the host's own job registry for a job's owner and status. A job is live exactly while the host's projection carries no `finishedAt`, which makes `stopping` count as work in progress and keeps a status this bridge has never heard of from being read as a finished one. An unowned job is nobody's evidence.
- The wait is bounded by `TURN_END_QUIET_MAX_MS` (600 s), which `DSH_REMOTE_BRIDGE_TURN_END_QUIET_MAX_MS` moves the way `DSH_REMOTE_BRIDGE_OFFLINE_CLAIM_TTL_MS` moves the offline claim window. The gate asks the host every five seconds with one question in flight at a time, both of its timers are `unref()`d, and dispose clears them. At the deadline the announcement goes out anyway and the line names what was still going (`still-busy(job-live(job-1))`), because a notification that never arrives is the failure this channel exists to prevent.
- A turn the bridge can see starting drops the held end and logs `turn-end dropped session=<id> reason=new-turn`: another increment for that session on a follow stream means the user has moved past the turn that ended, and the new turn ends with its own report. A roster answering `running` is deliberately not read as that evidence — the flag can still be set microseconds after the frame, and dropping on it would lose a notification the gate would otherwise send.
- Question and approval notifications are untouched: they still go out when the claim is made. The rate windows keep their numbers but are booked inside the send, at the instant something is really delivered, so a turn end held for a minute neither spends a slot it did not use nor escapes the window it does use.

## Configuration and the default-off rule

- Three environment variables name the credential: `DSH_REMOTE_BRIDGE_APNS_KEY_FILE`, `DSH_REMOTE_BRIDGE_APNS_KEY_ID` and `DSH_REMOTE_BRIDGE_APNS_TEAM_ID`. If any one is missing there is no `ApnsSender` at all, `PushNotifier.enabled` is false, and every notification path is a no-op; the mount log states which side of that line the process is on.
- `push.register` still answers `{ok:true}` on such a bridge. Whether a key is configured is a deployment fact, not a protocol error: a `push-unavailable` code would force every client to keep two code paths for a difference it cannot act on, and the write is worth keeping either way.
- The signing key is never copied, logged or written into the roster; only the JWT derived from it leaves the process.

## What stays open

- Approval and question claiming still requires at least one paired client, exactly as §3 and §11.3 say. A phone that is entirely offline therefore cannot be asked: the host normalizes the approval to `unavailable` and keeps its own deadline for a question. A notification cannot rescue a decision nobody was allowed to make, so offline coverage of that layer is a separate decision about silence, timeouts and who may answer late.
- Live Activity tokens are stored and given no semantics yet; that needs its own payload contract and state model.
- There is no read receipt, no dedupe table on disk and no retry queue: the windows live in process memory and reset on restart.
- Nothing was verified end to end, because no Apple signing key exists on this machine. A locally generated P-256 key proves the signing chain offline, and one real request to `api.push.apple.com` answered `403 {"reason":"InvalidProviderToken"}`, which is the TLS, HTTP/2 and JWT pipeline reaching Apple's authorization gate and stopping there. The sandbox authority, a real device token and the `BadDeviceToken` / `Unregistered` paths are unverified, and token cleanup is deliberately not implemented.

## Alternatives considered

- **Announce at the `turn/end` frame, which is what this channel did first.** Rejected: a frame ends one turn, not the work the session holds, so a phone was told "turn finished" while the roster still badged that session running and the card said ended while its subagent and its job went on — the exact disagreement between badge and lock screen that `SessionRun` exists to remove.
- **Let the notification carry the state**, so a phone could render from `userInfo` alone. Rejected: the payload crosses Apple's servers and lands on a lock screen, and it would make the bridge a second source of truth for state it does not own.
- **Carry a preview of the content** — a question header, a tool name, a failure reason. Rejected with no exception: what a question or a failure is about is exactly the private part, and "it is only a summary" is how content leaks by increments.
- **Keep push registrations in a separate `push.json`.** Rejected: a second table keyed by device splits revocation in two, and a deleted device would keep receiving notifications until somebody remembered the other file.
- **Refuse registration when no key is configured.** Rejected: it turns a deployment fact into a protocol error and hands the client a distinction it cannot act on.
- **Await delivery on the broadcast path** so a failure is visible to the caller. Rejected: one slow or broken APNs connection would then delay `session.delta` frames to a connected phone, which is the opposite of what this channel is for.
- **Queue and retry failed deliveries.** Rejected: a notification arriving ten minutes late is worse than one that never arrives, and a retry burst is a duplicate storm on a lock screen. The facts are read on reconnect.
- **Claim approvals while no client is connected, then notify.** Rejected this round and recorded deliberately: it does reach an offline phone, but it rewrites silence-is-refusal, invents who may answer late, and changes what a timeout means. That is a separate decision, not a side effect of adding a delivery channel.
- **Mint a provider token per request.** Rejected: Apple throttles token minting and rejects tokens older than an hour, so one 45-minute cache is the only shape both constraints allow.

## Consequences

- A phone is now told that a turn ended, that it failed, and that a question or approval is waiting, without holding a socket. Acting on any of it still means calling `session.snapshot`, `session.list` or `question.list`.
- A turn end can arrive up to 600 s after the turn it reports, and that lateness is the budget rather than an accident: a session that falls quiet is announced at the next five-second question, and one that never does is announced at the deadline with the reason it was still busy.
- The held turn ends live in process memory only. A bridge that restarts announces nothing it was holding and writes no window to disk, deliberately: the fact behind any of them is read on reconnect, which is what this channel was built to make possible.
- The device table is schema 2 with an optional per-row block. Every pre-existing row loads unchanged — the live table on this machine is 179 rows — and is rewritten as version 2 on the next write.
- The protocol minor rises to 16, which is what a client reads to know the capability may be declared. The served-capability list grows by one name and the known-method set by one entry; nothing else on the wire moved. The handshake fields and the capability list are owned by [the protocol note](2026-10-16-remote-bridge-protocol-v1.md), and the claim path these notifications hang off is owned by [the questions note](2026-10-17-user-questions-over-the-bridge.md); this note records only the outbound side.
- Verification: the package suite runs 622 tests across 45 files, `pnpm typecheck` is clean and `pnpm build` emits `lib/index.js`. The push suite is 21 cases covering the token header, claims and signature against a locally generated P-256 key, the APNs request shape, the 179-row migration, an unreadable `push` block, token rotation, a disabled bridge, deduplication, both rate limits, `turn-end` versus `turn-error`, and the two payload leak assertions. The turn-end quiet group adds 12 cases covering the wait, the budget and its environment override, the turn a new increment drops, a rate window booked at the real send, the disabled bridge, dispose, and the three sources of the host's own answer.
- Unverified, and recorded so nobody reads the probe above as a delivered notification: a real `.p8` from the Apple developer portal, a key with the Apple Push Notifications service enabled, the sandbox authority and a real device round trip are all still needed before this channel can be called working.
