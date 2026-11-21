# Agent Note: An interactive reply is one whole page inside one tool call

Status: implemented

## Problem

The bridge could ask a question (§11), push an approval (§3) and light a live-activity card (§29), but no channel let an agent hand a piece of interface into the session. `ask_user_question` carries a question and a set of options, and that vocabulary has no shape for a chart, a form, or a list an operator works in. The phone therefore stays a text transcript with cards: an agent can describe a table and never let anyone touch one.

## Decision

The remote surface gains a third kind of claim — section 35 `ui.v1`: a `ui.request` topic that announces one card, a `ui.event` method through which the card's first action becomes the presenting tool call's result, and a read-only `ui.list` for reconciliation. Two capability names (`ui.v1`, `ui.list.v1`) are appended to the served list, `hello.r.minor` is 21, and no frame, field, method, topic or error code of sections 1 through 34 changes. Sections cited with a section sign are sections of the remote protocol document (`docs/protocol-v1.md` in the iOS repository); that document owns the wire-visible half, this note owns the bridge-side reasoning.

A presentation is a new channel, not a generalized question channel. The question channel is a claim on the host's `user-questions/request` waterfall whose wire vocabulary is one question plus its options ([questions over the bridge](../architecture/2026-10-17-user-questions-over-the-bridge.md)); stretching it to carry a whole page and an arbitrary event would either give every client a field it must ignore or replace a shipped, tested shape with a union. Two channels, each with its own claim table and its own settlement, keep the question path byte-identical and leave an undeclared client untouched.

The payload is one whole self-contained HTML document, inlined in the frame, capped at 256 KiB of UTF-8. It is not a component JSON dialect: an operator asking for charts, buttons, forms and list actions sets a surface no closed component set can pre-decide, and every further need would be a new component on two clients. HTML also keeps the page's rendering with the agent that wrote it. There is deliberately no `url` in the frame: a host that published an address would have the client fetch content whose arrival the host cannot vouch for, so a page arrives inline or not at all.

The first `ui.event` settles the call. That action becomes the tool result, the card is announced `settled`, and every later event for the same call id is refused `ui-settled`. A page that must keep taking actions is presented again; one claim carries one action. One card per call is what keeps the result body a closed set of three shapes (an action, a release, a refusal) and what lets the desktop draw the card out of the tool row it already has.

`ui.list` exists because a client can outlive its memory of the wire. A phone that restarts may hold an `open` card on disk for a presentation the bridge withdrew while the app was suspended, and nothing on the wire says so. The three signals a client could guess from instead — the session's running state, the card's age, the roster row — all lag, which is why section 24.5 refuses heuristics: a wrong guess turns a live card into a read-only one. The list answers the fact itself: the cards this bridge still holds, with no claim opened, no deadline moved and no host state written. Retirement needs all four conditions of section 24.3 (the capability announced, `ok: true`, `complete == true`, every row parseable); a read that fails any one of them retires nothing.

A card nobody can answer is released, and the release is delayed by the same sixty-second window that holds a question ([the claim grace window](../architecture/2026-10-23-user-question-claim-grace-window.md)). Reusing `QUESTION_CLAIM_GRACE_MS` rather than adding a knob is deliberate: both claims block the same thing — an agent's tool call — both are released by the same departure of the last paired device, and a second constant would be a second answer to one question, how long the phone gets to come back. The window is armed once and never extended by a later departure, is cancelled by a paired connection that declares the channel and takes the replay — the same judgement as the question window, made at declaration rather than at claim time — and an unloading bridge releases at once instead of leaving a timer behind.

Both caps are refused on the originating side. A page over 256 KiB is refused `invalid-args` before any frame is written and without a presentation payload; an event whose payload exceeds 8 KiB is refused the same way. A client-side refusal would leave the agent waiting for a card that never comes, so the limit belongs where the wait is created.

Announcing is not negotiating. A `ui_present` call with no paired connection that declared `ui.v1` answers `unavailable` at once and holds nobody, the same judgement as the question channel's claim exclusivity, and a frame that reached no connection is withdrawn rather than kept.

## The desktop is a renderer, not a second answerer

The Web GUI has no socket to this bridge; it renders a transcript. It learns the card from the tool call itself: the arguments while the call runs, and `meta.ui` — `{key, title?, html, height?, state}`, keyed `"<sessionId>/<callId>"` — once the result lands. A blocking presentation only returns after it was settled, so the payload's `state` is `settled` in practice and its `open` arm is the shape a non-blocking presentation would publish; the arguments are the only material a card can be drawn from while it is still waiting.

The row is one keyed registration in the official `tool.call.toolview` slot, its key the wire tool name `ui_present`, so the card's body is drawn inside the official tool row and the rest of that row stays the official one. Shadowing the `tool-call` renderer is rejected: only the lowest-priority entry in a cell renders, nothing hands a half-drawn cell to the next entry, and a shadow entry cannot re-declare the sub-slot the official renderer owns — a shadow therefore reimplements the whole official tool card. A private `ChatNodeKind` is rejected too: it is possible (the node map is an open interface, and the assembler is a client module), and it costs a type merge, an event registration and a renderer where one keyed registration already draws the page.

That row renders and does not answer. There is no path from the GUI to `ui.event`, and the guarantee is the negative one: nothing the page reports is forwarded, persisted or requested — an action arrives as one visible sentence telling the operator to answer on the phone, and the page is sandboxed to `allow-scripts` without `allow-same-origin`, so the document has an opaque origin and the GUI's own storage and cookies stay out of reach. "No answer leaves this row" is a real promise; "the controls are disabled" would not be, since a parent window cannot disable controls inside an opaque-origin document.

## The local slot seam is technical debt

`packages/dsh-remote-bridge/src/client/toolview-slot.ts` narrows `ctx.slots` to the two members the registration uses and states the slot's own shape locally, because `@deepseek-ai/dsh-client-ui-tool` — the package that declares `tool.call.toolview` — is not installed in this workspace. A type-only import would itself be a new dependency, and a local `declare module` extension would duplicate a contract another package owns and collide with the real declaration wherever both load. The seam carries three mirrored facts (the phase names, keyed dispatch, the locale seat), so an upstream change to that shape is a change to this file. When the package next takes a dependency pass, the seam is replaced by `PropsRuntime<'tool.call.toolview'>` and the typed `register` overload.

## Testing

`packages/dsh-remote-bridge/tests/ui.spec.ts` holds fifteen cases over a real socket: the served capability list, a declared phone receiving the page, the action becoming the tool result, `ui-settled` on a repeated tap, `ui-unknown` on a call id this bridge never claimed, `unavailable` with nobody on the wire and with a paired client that never declared, `invalid-args` for a page over the cap, `invalid-args` for a payload over 8 KiB, `ui.list` reading only open cards while changing nothing, `meta.ui` keyed by the host call id, release through the grace window, replay after reconnect, a phone returning inside the window, and a cancelled turn released without an invented action.

`tests/ui-card.spec.ts` and `tests/client-ui-present-row.spec.tsx` cover the transcript reading and the row without a browser tool layer: the arguments-only stage, the presentation payload winning over the arguments, the byte-accurate UTF-8 cap, the frame document, theme tokens, the measured height, the sandbox attributes, a message from another window being ignored, and one keyed registration under the wire tool name.

## Alternatives considered

**A closed set of native components — a JSON chart or form spec each client draws.** Rejected because the surface the agent needs is general: charts, buttons, forms and list actions, with new shapes arriving constantly. A closed set decides on the agent's behalf what it is allowed to draw and turns every new need into a new component implemented twice, on the phone and in the GUI.

**Keep the fenced-block convention and let the client parse the page out of the transcript.** Rejected because the desktop would show the raw fence, or need the same second parser, and a half-streamed document cannot be parsed at all — the card would only exist after the turn ended, which is exactly when nobody is waiting for it.

**Generalize the question channel to carry a page.** Rejected because that channel's whole shape is one question plus options, and its claim is a claim on the host's question waterfall; widening it would add fields every existing client must ignore and make one capability name mean two different things. The page needs its own settlement, its own reconciliation read and its own caps.

**Shadow the official `tool-call` renderer.** Rejected on mechanics rather than taste: one cell renders only its lowest-priority entry, there is no hand-off of a partially drawn cell, and the shadow cannot declare the sub-slot the official renderer already declares. The result would be a reimplementation of the entire official tool card to change one row of it.

**Add a private `ChatNodeKind` for the card.** Rejected as a larger change for a smaller gain: a type merge, a node assembly registration and a renderer, against one keyed registration, and the only benefit is that the card stops living inside the tool row — which is where the call that presented it already is.

**One card, many events — keep the call open until the page says it is done.** Rejected because "when is this presentation finished" has no honest answer on the wire, and a call held open that nobody closes is an agent blocked forever. The card is settled by the first action and a page that must stay interactive is presented again, which puts the lifetime in the presenter's hands instead of a timeout's.

## Consequences

- The desktop shows a card the operator must pick up the phone to use. That is the accepted shape of section 35: answering requires the socket, and a second settlement channel for the GUI is the cross-surface conflict this repository has already reverted once ([questions over the bridge](../architecture/2026-10-17-user-questions-over-the-bridge.md)).
- A page may load `https:` subresources, so a presenting page can send data it holds to an external address. The mitigations are non-persistent site data, no user credentials inside the page and a visible card header — not blocking the network, which would remove the CDN case the same decision buys.
- The grace window costs a Mac user up to sixty seconds of latency on a card whose phone has left, exactly as a held question does. The window is the knob, and it is the question channel's knob, not a second one.
- The caps belong to the presenter: an agent that ignores the tool description is refused `invalid-args` rather than handed a truncated page, and it can tell that apart from `unavailable`.
- The slot seam mirrors an upstream shape, so an SDK cohort that renames a phase or drops the locale seat breaks the registration here. That is the recorded price of not taking the dependency; the file names the three facts it mirrors so the change is a lookup rather than a discovery.
