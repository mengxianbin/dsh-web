# Agent Note: An offline claim for a question the phone was not there to receive

Status: implemented

## Problem

The bridge claimed a question only while at least one paired device was connected: `hub.question()` returned `next()` as soon as `pairedClients === 0`, handing the ask straight to the host's own answer chain. The phone has no background mode at all (the iOS client declares none on purpose) and iOS suspends it a few seconds after it leaves the foreground, so those two facts compose into the ordinary case: a question raised while the user is elsewhere was never claimed, never listed by `question.list`, never pushed, and never replayed on reconnect. The card existed only on the desktop, and the phone could not answer a question it had never heard of.

## Decision

When a question arrives and no paired connection is online, the bridge now claims it on behalf of the most recent paired device **if that device is still registered for notifications**, and sends the alert push immediately (`st: "question"`) even though no frame was delivered. The claim is held for `OFFLINE_QUESTION_CLAIM_TTL_MS` (600000 ms, overridable through `DSH_REMOTE_BRIDGE_OFFLINE_CLAIM_TTL_MS`).

Three ways out, all through one idempotent release path, so the host chain is started at most once and no second notification is sent: the phone connects and declares `questions.v1` (the existing replay hands it the card), the phone answers, or the window expires and the claim is withdrawn and delegated back. A connection that comes online but declares no `questions.v1` withdraws the claim at once — the §11.3 rule is "online but nobody can receive", judged at hello rather than only at claim time, because an old client would otherwise make the agent wait out the whole window.

APNs `410` / `Unregistered` / `BadDeviceToken` is the single exception to "delivery failures are swallowed": that device's push registration is cleared, and the claim is released only when no registered device still holds a token.

Approvals are untouched, no method, topic or capability name is added, and `hello.r.minor` stays 18: every client already reads `question.list` on each new connection and is replayed to on declare, so there is no second code path for an announcement to switch.

## Testing

`tests/offline-claim.spec.ts` holds twelve cases: the claim and its single alert; no claim when no device ever registered; delivery and no second alert when the phone returns inside the window; an answer that never starts the host chain; expiry that delegates exactly once; APNs refusal of the only token, of every token, and of one of two tokens; the host ending the ask; an old client that cannot receive; a blocking ask; and a bridge with no signing key claiming nothing.

## Alternatives considered

**Keep the online-only rule and merely notify.** Sending `st: "question"` with no claim tells the user a question exists that the phone cannot answer, and then sends them to the Mac. It solves "knowing" and leaves "answering" broken.

**Wake the client with a silent push and let it claim again.** The host sends alert-only payloads today, iOS does not guarantee silent delivery, and the wake window is about thirty seconds. As the primary mechanism it would build the feature on the one delivery path the platform refuses to promise.

**Let both surfaces show the question, first answer wins.** This repository tried exactly that on 2026-10-17 and reverted it nine minutes later: the host's `user-questions/request` waterfall has no channel to tell its own UI that the bridge settled the ask, so the desktop kept offering a question that had already been answered. Rejected until the host grows a settlement channel.

**Add a capability name and bump the minor.** Clients do not change behaviour for this; the gain lands entirely on reads they already perform. A capability nobody branches on is a handshake reading that invites being mistreated as a behaviour switch.

## Consequences

A blocking ask now waits up to the window before the host's own UI is offered it, so an agent can wait ten minutes for an answer nobody was going to give. That is the accepted cost of the window, and the window is the knob: deployments that want the desktop sooner lower `DSH_REMOTE_BRIDGE_OFFLINE_CLAIM_TTL_MS`.

A bridge with no APNs signing key claims nothing and behaves as before: holding a question it cannot announce would be pure loss.

The offline claim does not feed the lock-screen card channel (`liveActivity.noteQuestion`); a card that lights up for an awaiting question is section 29 work, not this change.

The protocol side of this decision is written down as section 32 of the client's protocol document (`docs/protocol-v1.md` in the iOS repository), which is where the wire-visible half lives; this note owns the bridge-side reasoning.
