# Agent Note: Task-board schedules carry a plan kind and a persisted run budget

Status: implemented

## Problem

A board schedule was a recurring 5-field cron rule and nothing else. The rule
could be armed, disarmed or re-zoned, but it had no way to say "run once at this
future instant" or "run at most N times":

- A one-shot had to be expressed as a date-restricted cron expression (a yearly
  rule pinned to one date), and the card only stopped recurring because the
  execution agent was asked to disable it afterwards. That is not a schedule: it
  is a recurrence plus an agent's cooperation, and an agent that fails, is
  interrupted, or simply does not comply leaves the card armed for next year.
- A finite request ("run this twice") had no native stop at all. The schedule
  kept firing until a human remembered to disarm it.
- The rule carried no counter, so "how many times has this run?" could only be
  guessed from the execution history — which is trimmed, counts manual runs,
  and loses the distinction between "the scheduler fired" and "a person ran it".

The board's own Host ledger is the authoritative scheduler for board
executions: the owning notes already rejected delegating this to the Host-wide
schedule service, which runs sessions rather than board cascades and knows
nothing of the ledger, the permission gate, or run groups
([native panel and timer](../architecture/2026-09-25-task-board-native-panel-and-timer.md),
[schedule time zone](2026-09-29-task-board-schedule-time-zone.md)). Extending
that scheduler is therefore the only place a native one-shot can live.

## Decision

A rule describes one of two plan kinds and carries its own run budget.

### The rule

`ScheduleRule` gains a stored discriminant and a counter:

- `mode: 'cron' | 'once'`. A rule loaded from a ledger written before the field
  existed normalizes to `cron`, which is what keeps every historical card on its
  existing recurrence.
- `cron?: string` is now optional and present only on a `cron` rule; `at?: number`
  holds the single planned instant of a `once` rule and is kept after the run so
  the detail view can still show the planned wall clock.
- `runCount: number` is the budget's counter. `maxRuns?: number` caps a recurring
  rule (absent means unlimited, the historical behavior); a one-shot has an
  implicit budget of one and stores no cap.
- `endedAt`/`endedReason` record that a rule stopped itself, and
  `skippedAt`/`skippedReason` record the last occurrence that produced no run.
  Both reasons are stable codes (`fired`, `limit`, `no-target`, `missed`,
  `busy`, `permission`, `launch-failed`), never display text: the board renders
  them through its locale dictionary.

The planned instant of a one-shot is `at`; the scheduler's target
`nextRunAt` equals it while the rule is armed and is cleared when it is spent.
Nothing about a one-shot is expressed as a cron expression.

### Counting semantics

**The counter moves once per execution the scheduler successfully opened, and
nothing else.** Concretely:

- A manual `run`/`rerun` never touches `runCount`; only the due-occurrence path
  does.
- A rule whose permission binding is unconfirmed, whose card already has an open
  execution, whose plan has no reachable occurrence, or whose occurrence came
  due while the board was not running consumes nothing. The occurrence is
  skipped, the budget is untouched, and the reason is recorded on the rule.
- A launch that fails BEFORE any session exists created no execution: its run is
  refunded (the counter steps back down) and the rule keeps — or, when that fire
  spent the last run, regains — its next target. The occurrence is recorded as
  `skippedReason: launch-failed` on a recurring rule and `endedReason:
  launch-failed` on a one-shot, which has no later occurrence to serve. A launch
  that DID reach a session is a real run and is never refunded. Either way a
  failure never triggers an immediate re-run, so it can never push a rule past
  its cap. A target the refund restores is served like any other: the service
  re-arms the native timer for it, so a rule that regains its occurrence does not
  wait for an unrelated write ([native panel and
  timer](../architecture/2026-09-25-task-board-native-panel-and-timer.md)).
- A settled outcome never moves the counter, so "ran twice, both failed" is two
  runs of a two-run budget, not zero.

### Boundary policies

Each edge the design must answer for has exactly one policy and one visible
state, and none of them reports a success that did not happen.

| Edge | Run budget | Rule state afterwards | Visible as |
| --- | --- | --- | --- |
| Above-default permission still unconfirmed | untouched | recurring rolls one occurrence forward; one-shot stops | `skippedReason` / `endedReason: permission` plus `scheduler.error` |
| Card already has an open execution | untouched | recurring rolls one occurrence forward; one-shot stops | `skippedReason` / `endedReason: busy` |
| Instant passed while the board was not running | untouched | recurring rolls forward; one-shot stops | `skippedReason` / `endedReason: missed` |
| Plan has no reachable occurrence | untouched | stops | `endedReason: no-target` |
| Launch failed before any session existed | refunded | recurring keeps (or regains) its next target; one-shot stops | `skippedReason` / `endedReason: launch-failed` plus the failed `ExecutionRecord` |
| Launch reached a session, then the run failed | one run spent | schedule keeps its next target | the failed `ExecutionRecord`; the counter shows the spent run |

A refund is not a replay: the failed occurrence itself is never re-run. A
recurring rule simply serves its next occurrence, and a one-shot has none, so it
ends. A rule the user disabled in the meantime is never resurrected by a refund.

### Where the budget is enforced

The gate lives inside the single ledger writer: `HostTaskLedger.openScheduled`
refuses to open anything for a rule that is already exhausted, and the run it
does open is counted in the same atomic commit. A stale timer, a repeated fire,
a hand-edited ledger and a restart therefore cannot overrun the cap. The next
target is computed by the ledger rather than being handed in by the service, so
there is one source for "what is due next".

Recovery reuses the existing "missed triggers are skipped, never replayed"
contract, with one one-shot-specific consequence: a one-shot whose instant
passed while the board was down is stopped as `missed` (it has no later
occurrence to roll to), while a recurring rule rolls forward and records the
skip.

### Authoritative scheduler and SDK boundary

The authority over board executions is this package's own Host ledger, verified
by reading the mounted SDK surface and the owning notes rather than assumed.
`HostExecutionRunner` launches sessions against the ledger's records, so the
ledger is the only writer that can decide what a card runs and what it has
already run; the host-wide schedule service (`@deepseek-ai/dsh-schedule`, and
the optional experimental bundle that carries it) delivers session follow-ups
from its own store and knows neither this ledger, its permission confirmation
gate, nor its cascade run groups — the delegation rejection recorded in
[native panel and timer](../architecture/2026-09-25-task-board-native-panel-and-timer.md)
and [schedule time zone](2026-09-29-task-board-schedule-time-zone.md) therefore
still holds. Implementing the one-shot and the budget in this package is what
uses the authoritative writer instead of adding a second one: no DSH source
checkout is modified, no SDK cohort is moved, no new service is injected, and
nothing relies on an execution agent disarming its own rule.

Re-read that rejection if a future SDK grows a surface for running a board task,
or if the board's authority boundary itself changes.

### Persistence, wire and surfaces

- The ledger schema moves to v6. v2/v3/v4/v5 documents migrate losslessly; the
  mode/counter/stop fields are added by the normalizing parse, and the Host zone
  is still stamped only on the generations that predate the stored zone.
- `set-schedule` and creation-time `schedule` accept `mode`, `at` and
  `maxRuns`; the strict wire gate rejects a fractional instant, a past one-shot
  (refused by the use case, which owns `now`), a non-positive or fractional cap,
  and an unknown mode. The import path validates the same shape and drops an
  unusable rule rather than the task row.
- `task_board_schedule` grows `mode`, `at` and `maxRuns` (`0` clears a cap back
  to unlimited, mirroring the empty-string zone convention), and its view reports
  the plan kind, counter, cap and stop/skip record.
- The task detail and the new-task dialog offer the plan kind, a zoned
  `datetime-local` instant for a one-shot, a run-cap choice (unlimited / 1 / 2 /
  custom), and the rule's own state: next run, `runCount`/cap, remaining runs,
  how it ended, and what it last skipped. The detail also offers an explicit
  cancel, and the card badge reads "once" for a one-shot.
- Re-arming a stopped rule or switching its kind starts a fresh budget and clears
  the stop record; editing a live rule's expression, zone or cap keeps the
  consumed count, so an already-spent budget can never silently reset.

## Alternatives considered

- **Keep expressing a one-shot as a date-restricted yearly cron plus an agent
  instruction to disarm.** Rejected — it is not a one-shot: the recurrence
  remains armed if the agent fails or is interrupted, and it makes the schedule's
  correctness depend on the executed work. The requirement is exactly that the
  system stop it, not the agent.
- **Derive the counter from the execution history instead of storing it.**
  Rejected — history is trimmed to the last 20 executions, contains manual runs
  and reruns, and cannot distinguish a scheduler-opened run from a person's, so
  a budget derived from it would drift and could be reset by a trim.
- **Retry a busy one-shot instead of skipping it.** Rejected for this change —
  the board's existing contract is that a due occurrence is skipped when the card
  is already running, and a retry would launch the work at an arbitrary later
  moment with an ACL resolved for the original instant. The consequence is
  recorded below; changing it is a deliberate follow-up decision, not a silent
  side effect.
- **Make a bounded rule loop in-process (fire N times, then stop) without
  persisting the counter.** Rejected — a restart would forget the count and could
  exceed the cap, which is the failure the requirement names.
- **Route board schedules through the Host-wide schedule service.** Rejected for
  the same reasons as the two owning notes above: that service delivers session
  follow-ups and owns neither the board's ledger, its permission gate, nor its
  cascade run groups.

## Consequences

- "Run once at this instant" is a stored fact: the rule opens exactly one
  execution and disarms itself in the same commit, and no later fire, reload or
  restart can produce a second one.
- A capped rule stops itself at its counter. Nothing an execution agent does —
  succeeding, failing, or ignoring the prompt — can extend or shorten it.
- The counter is visible and durable: a refresh or restart shows and preserves
  `runCount`/cap, and the board reports how the rule ended or what it last
  skipped.
- A missed one-shot is terminal, never replayed. A card that happened to be
  running at the planned instant, or a board that was down through it, loses that
  single occurrence; the rule shows `missed` or `busy`. This is the existing
  skip contract extended to a plan with no next occurrence, and it is the one
  place where a user may reasonably expect a retry instead.
- A launch that fails before any session exists is refunded, so a host-side launch
  failure cannot silently eat a limited budget. The failed attempt still appears in
  the execution history; only the counter is returned, and the rule serves its next
  occurrence (a one-shot, having none, ends). The occurrence a refund restores is
  armed at once, so the returned budget is served at that occurrence's own instant
  rather than at whatever target happened to be armed.
- Re-enabling a stopped rule resets its budget. The user's act of arming it again
  is what buys a new round, and the exhausted display makes the previous round's
  count visible before that happens.

## Testing

- `tests/schedule-once.spec.ts` drives the ledger with a fixed clock: one-shot
  plan validation (past / equal / fractional instants, cap values), a one-shot
  opening exactly one execution and ending itself, a spent one-shot not re-firing
  after a reload, a missed one-shot skipped without spending, a two-run cap
  stopping at two (settled outcomes do not move the counter, a later occurrence
  opens nothing), a partly spent budget surviving a reload, a busy skip not
  spending, and a manual run not spending.
- `tests/host-service.spec.ts` fires the controllable `HostTimerFace`: a one-shot
  arms at its exact delay, fires once, and leaves no timer armed; a two-run cap
  fires across two timer fires and then arms nothing; a one-shot due while the
  service was down is skipped on start; and a scheduled launch that fails before
  any session exists is refunded, stays armed, and is not retried early.
  `tests/schedule-once.spec.ts` additionally covers the refund transition: a
  recurring rule keeps its target, a rule that had stopped at its cap is
  restored, a one-shot ends unspent without replaying its instant, and a task
  with no rule is untouched.
- `tests/tasks.spec.ts` and `tests/store.spec.ts` cover the rule transition and
  the v6 repair (a one-shot with no instant is dropped, the counter and stop
  record round-trip). `tests/host-ledger.spec.ts` covers the migration and the
  due-reference projection. `tests/protocol.spec.ts` covers the wire gate for
  set-schedule, create-time and import. `tests/agent-tools.spec.ts` covers the
  tool arguments. `tests/schedule-zone.spec.ts` covers the zoned datetime
  helpers (including a spring-forward gap) and the budget/stop labels, and
  `tests/task-detail-edit.spec.tsx` renders the detail editor: switching to a
  one-shot persists the parsed instant, picking a cap writes it, and a spent
  rule renders its planned instant and end state. `tests/new-task-run.spec.tsx`
  renders the create dialog and pins both create payloads: a one-shot plan with
  its parsed instant, and a recurring plan with a custom run cap.
