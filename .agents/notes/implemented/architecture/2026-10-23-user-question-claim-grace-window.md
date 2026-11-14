# Agent Note: Hold a claimed user question for a grace window

Status: implemented

## Problem

The bridge released every user question the instant the last paired client left: `BridgeHub.detach` abandoned every approval and called `QuestionClaims.withdrawAll()`, which delegated each open claim to the host's own answerer chain. The Mac then drew the card the phone could no longer draw.

iOS suspends the app shortly after it is backgrounded, which drops the socket, and a push notification carries one fact: `whale://session/<id>`. The phone can draw a question card only while the bridge still holds the claim, and it can read one back only after it reconnects. Releasing on the last departure therefore decided the question on the phone's behalf at the exact moment the phone could not answer. Measured 2026-10-23 at 10:18: the notification was tapped onto a session with no card, and the host held nothing — the claim had been released about twenty seconds earlier, when the suspended app's socket dropped.

The same path carried a second defect. `BridgeHub.replayQuestions` published `questionPayload('open', claim)` for every claim it replayed, so a `continued` claim — one whose foreground wait the host had already ended, and whose answer is steered in through the host's Remote `answer` — was re-handed to the phone as `open`, telling it to wait on an agent that had already moved on.

## Decision

- A claim on `user-questions/request` now outlives the last paired client by `QUESTION_CLAIM_GRACE_MS` (60 000 ms), measured from the departure of that client. `BridgeHub.detach` abandons approvals at once, as before, and arms the window for the user questions instead of withdrawing them.
- There is exactly one window per bridge, because the claim table is global: one `setTimeout`, left alone if a departure arrives while it is already running, so a second departure never extends it.
- The window is cancelled by `BridgeHub.attach` when the attaching connection is paired — the phone that came back is what the window was kept for. `dispose()` clears it and releases immediately: an unloading bridge is not a phone that went away.
- The timer is `unref`'d, like the deadline timer one claim arms, so a held question never keeps the host process alive.
- On expiry the window runs the body the release always had: `approvals.abandonAll()`, `questions.withdrawAll()`, and the same `... approval question(s) withdrew: no paired device is connected` and `... user question(s) released: no paired device is connected` log lines.
- `replayQuestions` now publishes the claim's own state. It reads `QuestionClaims.listed()`, the projection `question.list` answers with, so a replayed card and a listed row are one shape carrying `open` or `continued` as the claim actually is. The `openClaims()` accessor it used to read had no other production caller and is removed rather than left beside the projection it duplicated.
- No wire change: no method, capability, topic or field is added, and `hello.r.minor` does not move.

## The claim, the agent's wait, and the Mac card

While the bridge holds a claim the host's own answerer chain is not started, so the Mac panel shows nothing for it. That is unchanged by this decision and is what the window moves: for up to sixty seconds after the last phone leaves, a question is still the phone's and nobody else's. A phone that comes back inside the window is handed the claim by the replay and can answer it; the Mac then never sees it. A phone that does not come back hands the question to the chain when the window ends, exactly as it did the instant the socket dropped before.

The cost falls on the agent when nobody is coming: for a blocking ask a tool stays blocked for the extra window before the host's own UI can even show the question. The window is a reconnect budget for a case the bridge could not otherwise serve, and it is bounded by `QUESTION_CLAIM_GRACE_MS` rather than by the question's own lifetime.

A socket that attaches unpaired and enrolls during the window cancels nothing: the cancellation is keyed on a connection that is paired when it attaches, and the replay needs a paired declaration. Such a device reads the held claim through `question.list` once it has declared, or finds nothing if the window ran out first.

## Alternatives considered

- **A timer per claim.** The claim table is one global map and every claim shares one fate, so one timer states that; N timers would need a sweep to keep them from diverging and would still have to answer "one release or many".
- **Keep the claim until the question's own deadline.** A blocking ask has no deadline at all — the host invents none and neither may the bridge — so an unanswered claim would be held forever with no phone to answer it, which is the "phone not answering equals refusal" rule inverted.
- **Keep the claim until a client declares again.** That is the release condition with no bound: a phone that never returns (or was uninstalled) leaves the host's ask held indefinitely, and the Mac never gets the question either.
- **Extend the claim's deadline instead of adding a window.** Re-handing a question must never lengthen how long the agent waits for it — the rule the approval replay already holds. The clock that has to move here is the claim's own lifetime, not the host's deadline, and moving the deadline would change what the host is waiting for.
- **Cancel the window on any attach, paired or not.** An unpaired socket is an operator's browser tab without a token: it cannot draw the card and cannot answer, so letting it keep a claim alive would be a claim held for a surface that can never use it.
- **Replay through `openClaims()` plus `stateOf()`.** Two reads of one table to build one frame is exactly the drift `questionPayload` exists to prevent ("the card a phone was handed and the card it reads back out of a list cannot drift apart"). The list projection already carries the state and the payload together.
- **A shorter window (20 s).** It matches the measured suspension gap but not the latency a human has between a notification appearing and tapping it, which is the case the window exists for.

## Consequences

- A question raised for a phone that is momentarily away now survives a reconnect. The claim the phone would otherwise have lost is replayed with its own state and is answerable through `question.answer`.
- A `continued` claim no longer replays as `open`. A phone that reconnects after the host's foreground wait ended sees the state its answer path requires, instead of a card that promises a wait the host is not serving.
- Approvals are unchanged: `abandonAll()` still runs on the last departure, because a tool blocked on a decision has no late-answer path and nothing to come back for.
- The release log line now marks the end of the window rather than the departure. The departure itself logs nothing new, so an operator who needs to know when a departure happened reads the connection-close line above it.
- A bridge that unloads mid-window releases immediately and leaves no timer behind: `dispose()` clears the window before withdrawing, and a released claim cannot be released a second time.
- The claim registry still holds one fact per wire id, and both live states (`open`, `continued`) are what `question.list` reports; nothing about listing, answering or settling changed.

## Testing

`tests/hub.spec.ts` drives the window with vitest fake timers over the timeout pair only, so the connection heartbeat stays a real interval and a minute of claim time never pings a phone that is not there. The cases are: the last phone leaving does not withdraw the claim (it is still listed and still replayed), a paired attach inside the window cancels the release so the claim outlives the window and is still answerable, expiry releases exactly once with one release log line and no timer left, `dispose()` releases at once with nothing scheduled, a `continued` claim replays as `continued`, and an approval is still abandoned the instant the last phone leaves. The release, delegation and re-read cases in `tests/questions.spec.ts` were re-pointed at the two paths that now exist: the window's expiry and the immediate release on unload.

Not verified by this suite: a real iOS reconnect inside the window, i.e. that a suspended app returns and taps the notification within sixty seconds. That needs the device, and it is the reason the window exists.
