# Agent Note: session-send delivery mode (optional queue/steer field with ACK)

Status: implemented

## Problem

The session-send route ([2026-10-26-session-send-route](2026-10-26-session-send-route.md)) hard-codes the queue semantic: a message sent to a busy Session waits for the current turn to finish, even when the caller knows the message should influence the step the Session is taking right now. For long turns (turn p50 ≈ 13 min, >30 min = 28.1%) the queue delay is the whole point of the send, so cross-session steering had no REST path at all — only manual composer typing, which the route exists to replace. The Host session controller already ships both delivery verbs (`agent.followup` / `agent.steer`, mode dispatch at `commands.prompt`), so the missing piece was the wire, not the mechanism. Callers also had no way to tell whether a steer ever reached the model.

## Decision

- **Optional `mode` field on `POST /api/session-send`**: `"queue"` (default) or `"steer"`, validated in `parseSessionSendBody`; any other value answers 400 naming the field. An absent field parses to `queue`, so the pre-field wire keeps its exact behavior — the queue default is a regression-tested zero-change (routes.spec pins `mode === 'queue'` for a body without the field).
- **Queue remains the default because it is the historical contract**: existing callers (dispatch chain, m-note scripts) never sent `mode`, and they must not change behavior by this deploy.
- **Steer rides the Host's existing pre-step injection**: `mode: 'steer'` reaches `commands.prompt`, which calls `agent.steer` — the message enters the `next-step` inbox and is claimed at the next step boundary of the running turn (busy Session reads it inside its current turn; idle or stopped Sessions keep the wake-turn path, since `steer` on an idle agent is a woken prompt turn). No new loop code.
- **ACK instrumentation, event-driven**: the route records `deliveredAt` on every accepted steer into a `SteerAckTracker` (new `src/host/steer-ack.ts`); the package's existing `session/event` subscription pairs the delivery with the steered message's `user/message` (matched by `rpcId` = the prompt requestId, same Session) and the next `assistant/message`, then emits one structured `[steer-ack] sessionId=… requestId=… deliveredAt=… injectedAt=… firstResponseAt=… latencyMs=…` line — the `deliveredAt → 模型首响` latency the shadow-period calibration needs. No timers, no polling, fail-open (a malformed event or a throwing sink never disturbs delivery), pending entries capped at 256 with oldest-first eviction.
- **Scope stops at delivery + measurement**: no timeout-window policy here (3min resend / 10min unlistened stays owned by the disposal ladder), no UI changes, no queue-semantic changes.

## Alternatives considered

- Making steer the default for busy Sessions: rejected — it silently changes what every existing caller gets (queue semantics were the pinned contract), and a steering message is not what the dispatch chain means by "queue one prompt".
- A separate `/api/session-steer` endpoint: rejected — it duplicates the fence/validation/error-mapping body for one field's difference, and the Host already models both verbs as one `prompt` request's `mode`.
- Measuring ACK latency with a probe loop or scheduled check: rejected — a poller adds a timer per Session for a value the event stream already yields exactly once; availability gate question 1 (no new host polling) rules it out.
- Emitting the ACK from the route alone (delivery timestamp only): rejected — delivery proves the inbox accepted the message, not that the model read it; the calibration window (3min/10min) is about the model's first response, so the pair must include `injectedAt` and `firstResponseAt`.

## Consequences

- Callers opt in: nothing steers unless the body says `mode: "steer"`. The queue path is byte-for-byte the old one.
- The `[steer-ack]` line is the single source for first-period ACK data; the disposal-ladder doc's §三 L1 window (3min/10min) is calibrated against it, not against delivery receipts.
- A steer delivered to a Session that never reaches the transcript (stopped mid-flight, disposed) ages out silently at the cap — no line, which is correct: there was no model response to measure.
- Activation, like every route change in this package, needs a Host restart; `GET /api/session-dispatch/health` plus one probe send to a sandbox Session verifies it.

## Testing

`tests/routes.spec.ts` pins the wire: default-to-queue for a field-less body, `steer` pass-through, unknown `mode` → 400 before the session service is touched, plus the unchanged fence/validation suite. New `tests/steer-ack.spec.ts` pins the tracker: the delivery→injection→response pairing and its exact line, no line before injection, no pairing across Session or requestId boundaries, no line for queue deliveries, cap eviction, and fail-open on malformed events. 119 tests green in the package, plus `tsc --noEmit` and `tsc -p tsconfig.test.json`. End-to-end busy-injection semantics (steer enters the captured LLM request body at the step boundary, queue does not) are pinned harness-side by the steer-insert semantic spec.
