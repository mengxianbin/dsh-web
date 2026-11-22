# Agent Note: Seal worker rejections record their infra cause, not decode-fail

Status: implemented

## Problem

`createSealStateSync`'s turn-end compute degrades a rejected worker to an `UNKNOWN` record, and every rejection — worker script missing, the 30 s budget exceeded, the worker crashing — was stamped `detail: 'decode-fail'`. `decode-fail` is the contract C1 vocabulary for a transcript the analysis could not read, so such a record asserted a data claim the transcript did not support. The 2026-11-14 incident made the lie concrete: a profile install wiped `lib/host/seal-compute-worker.js` (05:39–14:59), so every turn/end in that window rejected and recorded `UNKNOWN/decode-fail` while the `seal-check` endpoint — which computes in-process, without the worker — answered `DONE` for the same sessions. Records are append-only, so those false rows kept suppressing the lamp on sessions that were archivable until the next turn/end overwrote them.

## Decision

A rejected worker compute now names its infra cause. `computeSealInWorker` rejects with a `SealComputeError` carrying a machine `detail`: `worker-missing` (no script next to the module), `worker-timeout` (30 s budget), `worker-error` (crash, no result, or an injected seam that threw). The turn-end catch reads that detail — anything unmarked degrades to `worker-error` — and still stamps `verdict: 'UNKNOWN'`. `decode-fail` is now reachable only from a decode the worker itself returned, which is the claim the C1 vocabulary was defined for.

The ruling's failure semantics are untouched: UNKNOWN still stamps the row, the relay gate stays fail-closed, and the projection schema already accepts an open detail string.

## Alternatives considered

Recording nothing on a rejected compute was rejected: a previous record would survive and could be a stale `DONE`, which is the fail-dark direction the UNKNOWN stamp exists to prevent, and the behavior would differ by whether a record already existed.

Dropping `UNKNOWN` records from the projection fold so the C1 pull snapshot shows through was rejected as a ruling change: it would make a Host verdict stop suppressing C1 — the `seal-light-host-state-ruling-1110` "Host 压 C1" semantics — and that belongs in a brief, not in a fix.

One undifferentiated `worker-fail` for every rejection was rejected: the three causes are exactly the root-cause candidates a future incident has to separate, and the record is the only artifact that survives to tell them apart.

## Consequences

Records stay truthful about what failed: a future worker outage leaves `worker-missing`/`worker-timeout` rows instead of `decode-fail`, so `decode-fail` in the log means a transcript that really did not decode. Existing false rows are append-only and are not rewritten here — they turn positive at the session's next turn/end once the worker is back (observed 2026-11-14: sessions flipping `UNKNOWN/decode-fail` to `DONE/sentinel-ok` after the worker file was restored).

`detail` is rendered through `SealLight`'s detail switch, which has a `default` arm, so the new codes draw no detail line and change no lamp tone; the verdict is what the tone reads.

## Testing

`tests/seal-state.spec.ts` (12 cases): the compute-throws case now expects `UNKNOWN/worker-error`, and a new case pins the boundary — a worker that returns `decode-fail` records `decode-fail`, a compute that rejects with `worker-missing` records `worker-missing`. Package `vitest run` (251/251 across 24 files) and `typecheck` (tsgo both configs) pass.
