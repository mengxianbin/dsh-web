# Agent Note: Archive identity gate and ledger actor (triclass decision table)

Status: implemented

## Problem

The 2026-10-29 13:53 misarchive (taskbot R16 archived the human Session `session-e631dae6` while its user was typing) had no mechanical stop: the archive REST accepted any loopback caller for any target, the judge lived in skill text, and the ledger recorded only "when", never "who" — attribution took an hour of transcript archaeology. The m-note ruling (decision-log 2026-10-29T16:03) assigns every archive decision to an identity: a `bot-worker` Session is archived by a `bot-boss`, a `bot-boss` by its successor `bot-boss`, everything else by a human — with no exemptions — and requires the ledger to carry the executing actor.

## Decision

- **`POST /api/dsh-session-archive/archive` requires `actor`** (400 without it, mirroring the seal gate's required-field pattern): the deciding session id (`session-…` or bare uuid) or a human channel name (`manual`, …). `BatchRequestBody` gains the field; only this route requires it (unarchive/delete untouched, see Consequences).
- **New host module `src/host/identity.ts`** implements the decision table over `$DSH_HOME/session-attention.json` — the dispatch plugin's attention ledger, read fresh per archive batch (triclass rows, legacy `bot` rows counted as `bot-worker`, absent/corrupt file yields an empty table). `mayArchive`: human allows all; `bot-boss` allows `bot-worker` and `bot-boss` targets and denies `human`; `bot-worker` denies everything; an unclassified actor denies everything; an unrecorded target counts as `human`. `resolveActorClass`: session ids look themselves up (unrecorded session actor = denied, never guessed human), anything else is a human channel declaration.
- **The gate runs inside `ArchiveService.archive` per id** (after `not-found`, before the action), answering `skipped / identity-denied` with both classes in `detail`; the batch never taints, and the actor is persisted into every ledger entry it archives (`LedgerEntry.actor`, deserialized tolerantly).
- **Self-reported trust, stated openly**: the actor is a loopback request field, the same trust model as `recordManualArchive` — the gate stops honest-but-mistaken automation (the R16 shape), not a caller that lies. Caller wiring lives on the m-note side (taskbot skill passes the boss session id, `archive-janitor.mjs` passes `ownerSessionId`, manual skill calls pass `manual`).

## Alternatives considered

- **Soft constraint only (SKILL discipline)**: rejected by the ruling — R16 was exactly a session whose judgment lacked this rule; the brief's option C. The gate is the first line, skill text the second.
- **Fail-open on a missing actor (treat as human)**: rejected. It would leave every unwired bot caller able to archive human Sessions — the incident shape — while the batch already wires all known callers, so requiring the field costs one variable in three scripts.
- **Gate the native UI path too**: out of reach and out of scope — the sidebar never hits this plugin's REST (that is what `recordManualArchive` observes); it keeps its own confirmation/undo surface.

## Consequences

- Any REST caller that does not pass `actor` gets 400 until updated; the m-note batch updates `archive-janitor.mjs`, the `taskbot` and `dsh-session-archive` skills in the same change, and in-flight sessions running old skill text may see denials until they rotate (accepted, reported to the user).
- Ledger entries written by the native UI path (`observed` backfills) and pre-triclass entries carry no `actor`; only plugin-performed archives with a declared actor do.
- `/delete` and `/unarchive` do not consult the identity gate (outside this ruling's scope, reported as a residual) — delete remains behind its own confirmation contract.
- The gate depends on ledger health: while the attention ledger fails to record sessions (field issue observed 2026-10-29, reported separately), new session actors resolve unclassified and are denied until the ledger catches up.
- This branch (`local/sessionclass-triclass-1029`, based on tag `v0.4.11` = the deployed runtime) touches the same files as the in-flight `local/archive-seal-gate-plugin-1028` work (`routes.ts`, `janitor.ts`, `ledger.ts`); whoever lands second reconciles the per-id rejection paths.

## Testing

`tests/identity.spec.ts` (12 cases) covers the full matrix, bare-uuid canonicalization, blank/missing actors, channel names, and table parsing (legacy/unknown/absent/corrupt). `tests/janitor.spec.ts` gains a service-level identity describe (boss-archives-worker + boss-denied-on-human with ledger actor stamping; unclassified session actor vs channel actor) and migrates its existing `archive()` calls to declare an actor. `tests/routes.spec.ts` gains the actor-required 400 + declared-actor 200 case; `tests/ledger.spec.ts` gains the actor round-trip case. Package `typecheck`, `vitest` (147/147 across 16 files), and `verify-docs.mjs --write` all pass (2026-10-29).
