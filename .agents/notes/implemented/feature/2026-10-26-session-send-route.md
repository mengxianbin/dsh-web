# Agent Note: session-send route (queue-only delivery to an existing Session)

Status: implemented

## Problem

Programmatic dispatch could create a Session and queue its first prompt, but nothing could talk to a Session that was already running. Cross-session delivery — one session's output being exactly what another session needs — existed only as manual typing in the web composer or as single-shot CDP injection, which breaks whenever the layout shifts and cannot batch. Callers needed the composer's send as a plain REST call against an existing sessionId.

## Decision

- **`POST /api/session-send`** (same package, top-level path) takes `{ sessionId, prompt }` and calls the Host session controller's `prompt` with a minted `session-send-<uuid>` requestId and the fixed queue semantic: a busy Session consumes the message as a fresh turn after its current turn, an idle Session starts a turn at once (Host-side `agent.followup` semantics, confirmed against the session-controller source on 2026-10-26).
- **Queue-only is physical, not conventional**: the wire shape has no delivery-mode field, `parseSessionSendBody` drops any caller-supplied `mode`, and no route code names another delivery semantic. Steering an in-flight turn was explicitly ruled out of scope.
- **Scope stops at delivery**: no routing, broadcast, subscription, priority, read receipts, or session discovery (the caller supplies the sessionId); send creates no Session and records no quick-ledger binding — send does not dispatch, so there is no task occupancy to record.
- **Fences and error surface mirror the dispatch route**: loopback-only (`isLoopbackRequest`), POST-only, bounded JSON body (`readBoundedJson`, 1 MiB), prompt capped at 900,000 characters through the shared `PROMPT_MAX_CHARS` constant, and the shared `statusForError` mapping — `session/*` Host rejections (missing, archived, or disposed session) answer 400 with the Host error text.
- **Health probe reused**: the package's existing `GET /api/session-dispatch/health` already probes it; the send route adds no second probe.
- **File organization follows the family convention**: the send factory (`makeSessionSendRoute`) lives in `src/host/routes.ts` beside the dispatch, health, and bindings factories, and `src/index.ts` registers it alongside them; the dispatch aggregate `makeDispatchRoutes` keeps its exact route list.

## Alternatives considered

- Exposing the Host's delivery mode (queue/steer) on the wire: rejected — steering mutates the in-flight turn, a different and more dangerous capability than delivery; the 2026-10-26 ruling limited this route to queue semantics, and a mode field would demote the closure from a physical property to a convention.
- A separate `dsh-session-send` package: rejected — the loopback fence, bounded-JSON helpers, error mapping, and session service surface all already live in this package; a second package would duplicate the generated shared host module copies for two small factories.
- Verifying the target session with a separate lookup before prompting: rejected — the Host's `prompt` already resolves the agent and fails with `session/not-found`; a pre-check would race disposal and add a second code path for the same verdict.

## Consequences

- Callers own addressing: a stale or unknown sessionId answers 400, so session discovery/listing stays the caller's job (the session-archive inventory endpoint serves that need).
- The pointer discipline — long bodies committed to git first, the send carrying a path plus a one-line instruction — lives in the README and in m-note, not in code; the 900,000-character cap is a ceiling, not the intended shape.
- Activation needs a Host restart (or live patch reload): the route answers only after the linked bundle reloads. `GET /api/session-dispatch/health` plus one probe send to a sandbox session is the restart-verification recipe.

## Testing

`tests/routes.spec.ts` grew a session-send suite: happy path (requestId prefix, sessionId pass-through, fixed `mode: 'queue'`, text content), the queue-only closure (a caller-supplied `mode` never reaches the prompt call), body validation (non-object, missing or blank sessionId, missing or blank prompt, oversized prompt), invalid JSON, 405 for non-POST, non-loopback 403, `session/not-found` mapped to 400 with the Host error text, unmapped rejection mapped to 500. 62 tests green, plus `pnpm typecheck`, `pnpm build`, `pnpm docs:check`, and `pnpm i18n:check`.
