# Agent Note: Triclass session identity (human | bot-boss | bot-worker)

Status: implemented

## Problem

The 2026-10-29 13:53 misarchive showed the archive decision had no identity dimension: taskbot R16 judged only "board row `[x]` + `running=false`" and archived `session-e631dae6`, a human Session the user was still typing into. The same day's two-value `sessionClass` (`human | bot`) compounded it: bot duty Sessions were labeled `human` ("fake human"), so a literal reading of the new archive decision table would have blocked a successor boss from archiving its predecessor. User ruling (m-note decision-log 2026-10-29T16:03): sessions are three classes — human, bot boss (duty), bot worker (task) — the archive decision table is worker archived by boss, boss by successor boss, human by a human, with no exemptions, and the pin table is "human + boss pin, worker does not".

## Decision

- **`SessionClass` expands to `'human' | 'bot-boss' | 'bot-worker'`** (`routes.ts`). Wire validation accepts the legacy `bot` spelling and normalizes it to `bot-worker`, so in-flight callers still dispatching under the old two-value SKILL text keep working across the restart window; the type itself never exposes `bot`. Absent on the wire still means `human` — a caller that forgets the field fails toward attention, not toward burying the session.
- **Pin default becomes class-based**: `human` and `bot-boss` pin, `bot-worker` unpins (`attention.ts` `applyDefault`). `deserializeAttention` normalizes legacy `bot` rows to `bot-worker` and drops unknown classes row by row (a bad row never quarantines the file).
- **One ledger answers both questions**: `~/.dsh/session-attention.json` remains the pin ledger and doubles as the archive channel's identity table. The dsh-session-archive plugin reads it for the archive decision gate (see that package's companion note for the `actor` field and the per-id gate).
- **Caller convention moves with the type**: taskbot task dispatch declares `bot-worker`, rotation/watchdog duty declares `bot-boss`, human dispatch omits the field (m-note `dsh-session-dispatch`/`taskbot` skills, `scripts/dsh/dispatch-send.mjs` 4th argument, `scripts/taskbot/taskbot-watchdog.mjs` — same batch on the m-note side).

## Alternatives considered

- **Keep two values and add a separate duty flag**: rejected. Two sources of truth for one identity question; the ruling wants one ledger that both the pin pass and the archive gate read.
- **Reject the legacy `bot` wire value outright**: rejected. Live taskbot sessions that read the old SKILL text would get 400s on every task dispatch between this install and their next rotation; the alias keeps the transition window free while new sessions pick up the new literals.
- **Pin duty sessions by re-running a sweep every startup**: rejected before (one-time default ruling) and unchanged here — `bot-boss` only changes which class a pending default retries under.

## Consequences

- The gate's safety depends on ledger coverage: an unrecorded Session counts as `human`, so unrecorded bot duty Sessions would fail open until backfilled/declared (m-note batch includes a one-time backfill of alive boss Sessions).
- Callers that still pass `bot` write `bot-worker` records — correct semantics (bot-dispatched task work) with no caller change required.
- The pre-triclass runtime binary treats `bot-boss` as invalid until the next dsh web restart; duty-dispatch callers switching to the new literal before the restart window would see 400s (accepted: duty dispatches are rare and the restart is a declared human handoff).
- No UI surface shows the class; effect remains pin ordering plus the archive gate.

## Testing

`tests/attention.spec.ts` gains 3 cases (legacy `bot` row normalization, `bot-boss` declare pins, pending `bot-boss` retry pins without class downgrade) on top of the original 16; `tests/routes.spec.ts` reworks the validation case for the three literals plus the legacy alias, and adds a `bot-boss` declare-before-prompt case (56 total). Package `typecheck`, `vitest` (87/87), and `verify-docs.mjs --write` re-record of the README pair all pass (2026-10-29).
