# Agent Note: One lock-screen card lays out several sessions

Status: implemented

## Problem

A lock-screen card carried one session (§29). Three sessions running therefore meant three cards, three APNs tokens, three lock-screen slots and three slices of the bridge's minute, and the phone's next round replaces that cap with one card holding several rows. Nothing the bridge could already send made that possible: `content-state` had one `phase` and one `statusLine`, and a card with no room to say "and two others are waiting" makes the user open the app to find out.

The obvious-looking fix — a key that lists session ids and lets the phone read the roster for each — moves the decision to the client, which then owns a second answer to "which sessions is this card about". What shipped is the smaller half: the bridge chooses the rows, and their three readable facts cross the wire in the order it chose.

## Decision

- Protocol §30 (`docs/protocol-v1.md` in the iphone_remote_use_dsh repository) appends one optional key to `content-state`: `rows`, at most three items of `{name, status, phase}`. `phase` reuses the four values of `content-state.phase` verbatim, and no method, capability name, topic, header or existing key changes, so `hello.r.minor` rises from 17 to 18 and nothing else in `hello` moves.
- The bridge always sends the key once it speaks this protocol. An empty array and an absent key mean the same thing to the phone (§30.2), but a key that appears and disappears would make the client choose between two pictures of one moment.
- `LiveActivityNotifier` chooses the rows: sessions waiting on the user first, in the order their questions and approvals arrived; then the sessions running now, by the host's `updatedAt` descending; at most three, and the tail is dropped rather than wrapped or paged. The order is the bridge-side priority §30.6 deliberately leaves open, and a waiting session outranks a working one because that is the row worth the top of the glass.
- A row carries only the two live phases, `waitingForAnswer` and `running`. An ended or failed turn is the card's own `phase` and its own line, said there once; repeating it as a row would state one thing twice and make a card that is already leaving taller on its way out.
- The selection reads the facts the single-session state already reads: `#waiting` for the sessions owing an answer, and `#running`, built from the roster's `agentRunning`, for the ones working. A card and its own rows therefore cannot disagree about which sessions run. `ActivityRosterRow` gained `title` and `updatedAt`, both of which the roster row §9 publishes already carried.
- `status` and `statusLine` are the App's own English phrases, one per phase — `Running`, `Waiting for your answer`, `Stopped`, `Turn finished` — read through one accessor (`statusLineOf`) so a phase cannot be named two ways on one card. §29.7 makes the words on the glass the client's fixed table; the Chinese lines this channel shipped with would have put a second language beside the App's own `Running`, and one waiting phrase serves a question and an approval because the App's table has one. `core/push.ts` keeps its localized notification bodies: a notification is read in the user's language, a card is the App's surface.
- `name` is the host's own title after `normalizeActivityRowName`, the one place this rule exists, and it applies the same test the App's `SessionActivityDisplayName` applies: a trailing bracket group whose body is a path or nothing comes off, brackets included, until the tail is no longer one; `Ship (main)` is part of the name and stays. A tail group the host never closed is cut when its body holds a path (`Deck (/Users/zcl/code/x` would otherwise put half a path on the glass) and left alone when it does not (`Fix it (beta`). What is left is whitespace-collapsed, trimmed of the separators and dangling brackets its tail may hang on, and cut to the row name budget.
- A session the host never titled produces no row. §30.2 makes all three keys non-empty and §30.4 drops a nameless row on the phone, so the bridge leaves it out and the card falls back to the single row the phone synthesizes from the single-session keys. The key itself still goes out, empty.
- The §29.4 dedupe key now includes the rows, so a renamed, reordered or dropped row is something new to say, while appending a path to a title is not: the normalized name did not change.
- The stream that produces the `turn/end` this card ends on while no client is attached is [the standing watchers note](../architecture/2026-10-22-remote-bridge-standing-watchers.md)'s decision.

## Testing

The unit suite asserts the order (waiting by arrival, then running by recency, capped at three with the tail dropped), that a finished turn never becomes a row — its card says `failed` or `ended` once, in its own phase — the exact phrase for each of the four phases, an ASCII-only assertion on both phrase fields of a real delivery, the normalization cases a real roster produced (an absolute path, full-width brackets, an empty group, a dangling separator, a name that keeps `(main)`, a group the host never closed, an over-long title), and the dedupe: the same listing sends nothing, a path-only rename sends nothing, a real rename sends once with the new row. The row shape is asserted against the frozen key order with `rows` last, so the six §29 keys cannot move, and a card built without rows carries no such key. `pnpm typecheck`, `pnpm lint` and `pnpm test` are the gates.

## Alternatives considered

- **Let the phone derive the rows from the roster.** Rejected: it puts a second answer to "which sessions is this card about" on the client, and that answer diverges from the bridge the moment either side changes.
- **One row per card, its own session only.** Rejected: it keeps the one-card-one-session model and pays bytes for it, while §30 makes one card the place several sessions are laid out.
- **Omit `rows` while a card has one row**, since the phone can synthesize that row. Rejected: the synthesized row uses the card's own `statusLine`, which is right only when the one row is the card's own session; naming it explicitly is the same bytes and no inference.
- **Strip every trailing bracket group**, so `Ship (main)` would read `Ship`. Rejected: the App strips only a path or an empty group from the card's own name, and a second rule in the bridge would show two versions of one name on one card.
- **Keep the Chinese phrase table this channel shipped with.** Rejected: §29.7 makes the glass carry the client's fixed English table, so a Chinese card line would be a second language beside the App's own `Running`; the notification channel keeps its localized bodies for the surface that is read in the user's language.
- **Let a card's own failed or ended row ride in `rows`.** Rejected: the card already states that phase, so the row would repeat it and grow a card that is leaving.
- **Scrub the path where the phone renders it.** Rejected: §29.5 forbids the path on the wire at all, so the fix has to sit before delivery.
- **Add a `waitingCount` or an active-session count.** Rejected by §30.6: a number derivable from the keys already sent does not get a slot in the compatibility budget.
- **Order the rows by the relevance score of each phase** (waiting 100, failed 90, running 60). Rejected: relevance ranks a whole card on the lock screen, and a failed session would then sit above a question the user still owes an answer to.

## Consequences

- Addressing is unchanged: a card still names one session, a card without one is still never pushed to (§29.9), and `runningCount` still counts the whole bridge. Rows are content, not addressing.
- At most three short strings ride on every card delivery, and the cap drops the fourth session rather than wrapping or paging it.
- The rows are identical on every card of one moment, and they name only who is waiting and who is working: no card ever lists a session that has left or finished.
- A title whose path is not at the tail, for example `你是本仓 (/a) 请修`, keeps it: the rule removes trailing groups only. Scrubbing interior paths needs its own decision, because it starts rewriting the host's own name.
- The name budget is a bridge-side number (48 characters); the phone may clamp the row again when it renders.
- Not proven: a real APNs delivery and a real device. The suite drives the notifier and the builder offline, so what is verified is the shape and the choice of rows, not that the App's `Codable` type decodes them — that half is the §30 change in the phone repository.
