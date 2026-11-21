# Agent Note: Daily token cap for board-dispatched work

Status: implemented

## Problem

The board opens real DSH sessions for whole subtask trees, and the remote controller can now create member cards and start them with nobody in the loop. Nothing bounded what a day of that costs: a runaway tree, or a controller that keeps creating cards, spends until a human notices the bill. The operator wants the gate and the switch kept apart — ship the code, leave the ceiling at 0 so the board behaves exactly as before, and set a number when they actually want one.

Money cannot be the unit. The family usage ledger stamps `cost` for DeepSeek's own routes only and leaves it at 0 for every other provider ([usage statistics](./2026-08-29-usage-statistics-plugin.md) owns that ledger), so a currency ceiling would read "free" on exactly the deployments that route elsewhere. Tokens are the only complete measure of what a day consumed.

## Decision

One global settings key, `spendBudgetTokens`: volatile, default `0`, whole tokens per local day. `0` means no gate. It is read at each gate rather than frozen, so closing or raising the cap binds the next run without a restart.

Two gates read it, because there are two doors into a run.

The action path — `run` and `rerun` in `HostTaskBoardService.applyBoardAction`, next to the Agent Teams gate — refuses with a thrown message: `spend cap reached: N tokens of M today; raise the cap in the task board settings`. That text is what the caller receives as board-refused, so the cap introduces no error code; the same reader that reports every other refusal reports this one.

The scheduled path — the ledger's `openScheduled`, which the cron timer reaches without passing through any action — records the same text on `scheduler.error` and skips the occurrence onto its next target without consuming the rule's run budget. A scheduled occurrence has no client to throw at, and the board's contract for an occurrence it may not open is already this one: state why, roll forward, spend nothing.

## Where the number comes from

The gate reads `$DSH_HOME/dsh-usage/usage-ledger.json` at decision time and totals today's local-date bucket over `inputTokens`, `outputTokens`, `cacheReadTokens` and `cacheWriteTokens`. Reasoning tokens are not added on top: they are already inside the output count, which is how that ledger's own total is defined, so the cap and the usage panel can never disagree about what a day cost. The day key is the ledger's own local date, so both roll over at the same midnight.

An unreadable ledger is reported once per process and refuses nothing. "Cannot see" is not "spent nothing", but the alternative — refusing every run because a sibling plugin is absent — would wedge a board over a diagnostic, which is worse than a cap that says out loud it cannot measure.

## Default 0 is the board that existed before it

Both gates answer on the cap value before anything else happens: no file is opened, no event is subscribed, no counter is kept, no ledger field is added, no schema version is bumped. A deployment that never configures a cap runs the same code paths as the board that shipped without this setting.

## Alternatives considered

A board-side counter folded from `session/event`, which is how the usage plugin fills its own ledger, would give instantaneous readings with no cross-plugin file dependency. It lost on durability: the value would live in memory in a Host the Loader remounts on any config change and that restarts with the process, so the day's spend would reset and the cap could be defeated by restarting the Host. Making it durable means either a new state file with its own atomic-write and corruption handling, or a bump of the board ledger schema plus its migration contract — more surface than the measurement is worth, and a second writer of spend state in one process.

A money cap was rejected because the ledger prices only DeepSeek's own routes; see Problem.

Refusing only at launch, after the card moved to the running column, was rejected: the caller asked for a run and needs the answer about that run, and a refusal after a session exists is a settlement problem rather than a gate.

A new `ScheduleStopReason` value was rejected. It is persisted vocabulary: the union, the wire allowlist and three locale dictionaries would change so a detail line could say "token cap" instead of one existing reason, while `scheduler.error` already carries the exact numbers. The scheduled skip therefore reuses the existing `limit` reason and relies on the scheduler error for the precision.

Failing closed when the ledger is unreadable was rejected for the reason given above: the gate would break every deployment that does not mount the usage plugin.

## Consequences

The cap measures the whole Host's usage, not only sessions this board opened. That is deliberate — one ceiling on the account the operator pays for, read from the same number the usage panel shows — but it means a heavy day of the user's own chatting consumes the board's budget too, and a board-only accounting would have needed its own correlation between sessions and executions.

The usage plugin flushes its ledger on a 3 s debounce, so the reading trails the busiest moments by at most that window, and spend inside the window can cross the cap before the next gate sees it.

The skip is recorded as `limit` while the true cause is the scheduler error text, so a reader who looks only at the rule's stored reason will read "the run limit was reached" and must read the scheduler line for the numbers.

The gate depends on a sibling package's on-disk format. That format is owned by `dsh-usage`; a change to it must reach this reader in the same change, and a deployment without that plugin keeps a cap that never fires (reported once at the first refusal check).
