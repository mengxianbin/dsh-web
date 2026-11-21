# Agent Note: SSH terminal tabs with one host PTY per tab (issue #1950)

Status: implemented

## Problem

The SSH panel showed exactly one remote terminal. `PanelController` carried a single `terminalSessionId`, `TerminalTab` constructed one xterm, and every connect replaced whatever was on screen, so an operator watching several servers had to either reuse one tab for unrelated hosts or leave the panel. The host side already supported more than the view did: `engine/terminal-sessions.ts` keys sessions by id, keeps a bounded scrollback, and serves `detach`/`attach` reconnects with replay, which is exactly the shape a tab strip needs.

A community branch (`AbelKeithsun/dsh-web`, `feat/ssh-terminal-tabs`) demonstrated the feature and also demonstrated what goes wrong when the tab strip is bolted onto the single-session view. It produced a host PTY with no owner when the view left before the connection reported its session id, lost a keyboard-interactive challenge when the user switched tabs, deleted the tab on remote exit and let the empty-state placeholder cover the last screen, left the hosts-page host out of the terminal toolbar's dropdown, failed a background close silently, and shipped no Russian keys for its new labels. This change implements the feature and removes those failure shapes instead of importing them.

## Decision

The panel keeps tab records, not sockets, and shows one xterm at a time. Tab state (alias, host session id, status, pending challenge, close failure) lives in `panel/controller.ts`; the view in `panel/TerminalTab.tsx` owns exactly one xterm instance and one input subscription, and switching a tab rebinds that terminal instead of stacking terminals. The host protocol and `engine/terminal-sessions.ts` are untouched: opening, detaching and reattaching are the frames that already existed.

### The state machine

A tab is `connecting` (socket open, no session id yet), `connected` (host reported a session id), `exited` (remote shell ended) or `error` (the connection failed). One rule per transition:

| Event | Action |
| --- | --- |
| connect, "+", or the hosts-page connect control | a new tab is added and made current; the view opens one socket for it |
| ready frame | the session id is recorded, status becomes `connected`, any challenge is cleared |
| output frame | written to the single xterm and appended to the tab's retained screen |
| auth prompt frame | stored on the tab that carries it, whether or not it is current |
| switching to another tab | a `connected` tab detaches (the host keeps the shell and its scrollback); a `connecting` tab is adopted, not detached |
| switching back | `connected`: one `attach` with the session id replays the scrollback into a reset xterm; `exited`/`error`: the retained screen is redrawn, no socket is opened |
| exit frame | status `exited`, session id cleared, tab and screen kept, stdin disabled |
| closing the current tab | its own socket sends `close` (or the connection is adopted with a `close` intent while still connecting) |
| closing a background tab | one short-lived attach sends `close`; the tab is removed only when the session is known gone (frame delivered, or the host answers that the id expired), and kept with an explicit retry otherwise |

### The ready-before-detach rule

A connection that has not reported its session id cannot be detached: the host is still authenticating, there is no id to reattach with, and closing the socket leaves the session to finish connecting with no owner until the idle sweep (ten minutes) reaps it. That is the orphan the reference branch produced on every early switch. The view therefore hands such a socket to `PanelController.adoptTerminalLink`, which keeps it and applies the pending intent the moment the ready frame arrives: `detach` leaves the shell for a later reattach, `close` ends a session the user already closed. `reclaimTerminalLink` takes the socket back when the tab is shown again, so returning to a connecting tab never opens a second PTY. This covers both a tab switch and a panel switch (the layout unmounts the page whenever another panel is selected).

The intent is read from the live entry when the ready frame arrives, never from the closure that adopted the socket: closing a tab that is still connecting retargets that entry to `close`, so the session is ended instead of being detached into a PTY with no owner. Output produced during the adopted window is appended to the tab's retained screen, and reclaiming the socket draws that screen before the live frames resume, so the window is not a gap.

### One screen, one owner

Every bind either replays the host's scrollback (a `connected` tab) or draws the tab's retained screen, and the single terminal is cleared first whenever it currently shows a different tab. A terminal that was just created or disposed holds nothing and is not cleared. This is what keeps a new tab or a tab switched back into from inheriting the previous tab's output and cursor.

### 2FA answers belong to their tab

The challenge and the answer being typed live on the tab record (`authPrompt`, `authAnswers`). A prompt that arrives for a background tab therefore cannot blank the field the user is editing, and two challenges can never share a draft: submitting a form always sends that tab's own answers, in that challenge's own order. The view holds no answer state of its own.

The submit path also checks that the socket and the form name the same tab (`challengeBelongsToLink`). React commits a tab switch before the effect that rebinds the socket runs, so an event dispatched in that window would otherwise carry the new tab's answers onto the previous tab's connection; the check makes the answer's owner a precondition of the send rather than an assumption about event order. Output frames from a tab that was closed in the meantime are dropped for the same reason the tab is gone — the retained screen must not be recreated for a tab nobody can see.

### Remote exit

An exit frame clears the session id — a dead id must never be used to reattach — and keeps the tab, its position, and its last screen; input is disabled, the strip marks the tab `exited`, and the empty-state placeholder appears only when there is no tab at all. Because the id is cleared, the screen cannot come back from the host: each tab keeps a bounded copy of what was written to it (256 KiB, trimmed chunk-wise), stored outside the reactive snapshot so terminal output never re-renders the panel. A `connected` tab whose shell died while it was in the background learns about it when it is reattached: the host replays the scrollback, sends `ready`, then `exit`.

### Closing a background tab

A background tab no longer has a socket to send `close` on, and adding an HTTP route just to end a session would widen the host's surface for one frame. `SshApi.closeTerminalSession` opens a short-lived `attach` instead, sends `close` once the socket is open, and answers one question: is this session no longer running? Three outcomes are truthful — the frame left on an open socket, or the host replied with an `exit` frame (an unknown id is answered `terminal session expired`, and an ended shell also exits), both of which mean nothing is running — and one is not: a socket that errored, closed before opening, or never settled inside the call's bounded wait, where delivery is unproven and the session may still be alive.

The unproven case keeps the tab, keeps its session id, and reports `terminal.closeFailed`; the strip marks the tab so the failure is visible even while another tab is current, and the stale mark is cleared as soon as the tab connects, exits or fails. Recovery is explicit and truthful: the same control retries one attempt at a time (a second close while one attach is in flight is ignored rather than racing it), and bringing the tab to the front attaches it, so closing it there ends the shell over its own live socket. The failure banner names both paths, in all three languages, because a message that only offers the retry hides the path that cannot fail. The plugin never removes a tab whose session it could not end, and never claims a close it did not deliver.

### Toolbar and copy

The host dropdown reflects the tab that is current rather than a private component field, so a hosts-page connect lands on the terminal page with its host selected and the "+" control opens another tab on the host the user is looking at. Every new label is in `zh` and `en` in `client/locales.ts` and mirrored in `packages/dsh-i18n/src/client/ru/ssh.ts` (`terminal.tabs`, `terminal.newTab`, `terminal.closeTab`, `terminal.authPending`, `terminal.tabExited`, `terminal.tabError`, `terminal.closeFailed`).

## Alternatives considered

- One xterm per tab, hidden with CSS. Rejected: it keeps N renderers, N ResizeObservers and N DOM subtrees alive for tabs nobody is looking at, and the requirement is one terminal view. Rebinding one instance costs a reset plus the host replay that detach/attach already provides.
- Keeping every background socket attached instead of detaching. Rejected: the host appends to its replay buffer only for a view that will attach later; an attached background socket would deliver output that the single xterm cannot show, so it would be discarded, and the tab would come back with a gap instead of the replay that `attach` guarantees.
- A dedicated HTTP route for closing a session by id. Rejected: it widens `/api/dsh-ssh/*` for one frame and duplicates the loopback fence and session lookup the socket route already performs; a short-lived attach is the same operation over the existing transport.
- Importing the reference branch and patching its defects. Rejected: the defects are structural, not local — the branch detaches before the session id exists, which no patch to the tab strip can make safe, and its exit path deletes the tab the user still needs to read.
- Keeping the exited session id as the handle to redraw the last screen. Rejected: the host keeps an exited session for a 60-second grace window only, so the tab would go blank the moment that window closed, and a dead id is the kind of handle that silently attaches to nothing.
- Storing the retained screen in the controller snapshot. Rejected: every output chunk would notify subscribers and re-render the panel — the terminal path is the one place where React re-renders per keystroke-scale event must not happen.
- Detaching a socket whose tab was closed while it connected. Rejected: nothing can reattach to that session afterwards, so the "leave it for later" intent degenerates into an ownerless PTY; the entry's intent is retargeted to `close` instead.
- Treating an undelivered close as a closed tab. Rejected: the session may still be running on the host, and removing the tab would delete the only handle the user has over it. The tab stays until the session is proven gone (the host's exit reply) or ended over a live socket.
- Force-removing the tab on a second failed close. Rejected: it is the same lie with an extra click, unless the host had itself confirmed the session was gone.
- One shared draft for the 2FA answer. Rejected: a challenge on one tab then inherits another tab's characters, and the response submitted for one prompt can carry the answer meant for a different one.

## Consequences

- Connect always opens a tab; the legacy single-tab flow is the one-tab case of it, with the same connect, disconnect, 2FA, font and panel-reattach behavior as before.
- The tab list is browser-session state: a page reload drops every tab and, with it, the socket the host would have kept a session for. A future persistence layer would have to reattach by the ids before the reload, which the host cannot offer once the socket is gone.
- Retained screens cost at most 256 KiB per tab, held only while the tab is open.
- A tab closed while it is still connecting disappears from the strip immediately; the adopted socket sends `close` as soon as the handshake finishes, so the host PTY is ended rather than orphaned.
- A background close waits at most five seconds on its delivery signal, so the control never hangs; a session the host answers as expired is removed, a session whose delivery could not be proven is kept.
- The 2FA answer draft is per tab and lives in the controller, so it also survives a panel switch instead of being lost with the unmounted view.
- The panel's own tab bar keeps `data-dsh-part="tab-bar"` / `"tab"`; the terminal strip reuses those existing contract values instead of introducing a new `data-dsh-part` entry, so no skin contract change was needed.

## Testing

- `tests/panel-terminal-tabs.test.tsx` covers the tab machine end to end: two tabs on one host keep distinct session ids; switching detaches the hidden session and reattaches the shown one by id; a tab closes while its neighbour keeps running; a close that the host never confirmed keeps the tab with its session id and reports `undelivered`; a switch away before ready adopts the socket and detaches it once the id arrives; unmounting during the handshake does the same; a challenge that arrived on a background tab is still answerable after switching back; a remote exit keeps the tab and its retained screen instead of the placeholder; a hosts-page connect follows the host into the toolbar; the "+" control opens another tab on the shown host; and `closeTerminalSession` reports delivery only when the close frame reached an open socket.
- The review regressions have their own cases: closing a still-connecting tab closes (never detaches) its session; opening a tab starts from a blank screen and the two tabs' retained screens never mix; switching back to a connecting tab keeps the output it produced meanwhile and reuses the same socket; two challenges on two tabs keep their own fields, lengths and answers; a failed background close is cleared once the host reports the session gone, and recovery through the front tab works; closing the shown tab hands the terminal to the tab that took its place; closing the last tab returns the empty state; an expired session counts as closed; and an unanswered close settles inside the bounded wait.
- The rendering half is observed on the single real xterm instance instead of on the bookkeeping: `Terminal.prototype.reset` is watched to prove a rebind clears a screen that held another tab, and `Terminal.prototype.write` proves the retained screen of an adopted tab is replayed exactly once when it is reclaimed. Those two are the file's only `vi.spyOn` uses, each carrying a per-line `test-standards-allow` reason: the alternative is a test seam in the product. jsdom logs "Not implemented: HTMLCanvasElement.getContext" while the real renderer initializes; that is stderr noise, not a failure.
- Further cases close the last two review findings: a closed tab's socket stops feeding the retained screen (no record resurrected), and the submit path refuses to answer on a socket bound to another tab (`challengeBelongsToLink` is unit-checked for same-tab, other-tab and unbound, plus the DOM sequence where a switch and a submit share one task). The file holds 26 tests.
- `tests/panel-terminal.test.tsx`, `tests/panel-terminal-font.test.tsx` and `tests/panel-shell.test.tsx` still pass unchanged: the single-tab connect, 2FA modal, font re-apply, panel-tab semantics and the teardown/xterm-dispose contract are the same contracts.
- `tests/terminal-sessions.test.ts` continues to certify the host side, which this change does not touch.
