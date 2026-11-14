# Agent Note: History-head probe memo for wedged execution inspection

Status: implemented

## Problem

`HostExecutionRunner.inspect` pages backward through session history (up to 100 pages of 100 events) to find the execution's `turn/end`. When no matching `turn/end` exists (adapter mismatch, odd host state), the complete scan misses, returns `pending`, and the 5-second poll tick re-pulls and re-parses the entire history for that execution forever — sustained host CPU and bandwidth proportional to session size, multiplying per wedged execution. A read-only audit flagged the loop with concrete file and line evidence.

## Decision

Before paging, `inspect` fetches a one-message probe (`maxMessages: 1`, the newest page) and compares its head seq against a per-session memo of the last head whose complete scan missed. An unchanged head proves no event was appended, so the outcome cannot change and the deep scan is skipped.

The memo is written only after a scan that reached the execution boundary without finding `turn/end`, which makes it two facts at once: "this head was scanned and missed", and "the seq up to this head was proven to hold no matching `turn/end`". A session log is append-only, so records at or below that seq can never acquire one; a later walk therefore examines only what arrived above it, and stops paging as soon as its opening window reaches down to that seq or a page crosses it. The memo is dropped when the session settles or vanishes. `SessionSummary.updatedAt` was ruled out as the change signal: per its contract it tracks the latest human-authored prompt, not event appends, so memoizing on it could permanently miss a late-flushed `turn/end`.

## Alternatives considered

Memoizing on `updatedAt` was rejected for correctness (above). A consecutive-pending counter with a hard give-up was rejected: a wedged execution may still legitimately settle when its turn/end flushes late, and silently settling it would corrupt the ledger. Building a sessionId-keyed Map per tick instead of `items.find` per execution was rejected as unmeasured micro-optimization — session lists are small and the find runs once per open execution per tick. Deduplicating the probe page with the first scan page was rejected for clarity: the probe costs one tiny RPC and only runs when a scan might start. Recording the proven-walk boundary as a second, separate memo was rejected: the completeness guarantee already held for the existing memo's write site, so a parallel field would duplicate a fact the same value already carries.

## Consequences

A wedged execution costs one one-message history RPC per 5-second tick instead of up to 100 page fetches. A live execution whose head keeps moving no longer re-reads the history it already cleared: once the memo forms, a changed head is answered from the opening window alone. That is the Agent Teams path, where a teammate is a durable Team member whose roster entry never stops reporting `running`, so every poll re-inspects it — 12.8 page RPCs and 1223 materialized records per session per poll become 0 and 21, against a 1200-record history. The probe still adds one extra RPC on the success path (probe + scan instead of scan), visible in the call-count assertions, and a settled execution still costs one full walk to find its `turn/end`. No behavior change for settle timing or outcomes.

## Testing

New host-runner cases pin the probe-then-skip contract and the boundary guarantee: a second tick with an unchanged head costs exactly one probe call, a bumped head forces a rescan that stops at the proven boundary, a `turn/end` completed after the memo formed is still found (`succeeded`), and settling or vanishing sessions drop the memo. `pnpm --filter @linxin666/dsh-client-ui-task-board typecheck`, `test` (1101 pass, 1 skip) and `build`.
