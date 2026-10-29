# Agent Note: Session attention classification and one-time default pin

Status: implemented

## Problem

The sidebar shows human-facing Sessions and bot task Sessions in one flat ordering; keeping human work on top was entirely manual pin/unpin, and nothing recorded who a Session serves. Taskbot dispatches task Sessions continuously (user ruling of 2026-10-29, m-note decision-log), so the human's attention surface sinks under new bot work every batch, and at Host startup there was no pass that could re-surface it: dispatch never declared an initiator, the quick ledger stored no origin, and the registry stored no classification.

## Decision

- **`POST /api/session-dispatch` gains an optional `sessionClass: 'human' | 'bot'`** (validated in `parseDispatchBody`; absent or invalid-as-default means `human`). The default fails toward attention: a caller that forgets the field gets a pinned Session, not a buried one.
- **New host module `src/host/attention.ts`** — `AttentionLedger` backed by `$DSH_HOME/session-attention.json` (atomic temp + fsync + rename, corrupt file quarantined to `<path>.corrupt-<epoch>` and rebuilt, mirroring the bindings ledger). Records are canonical-id keyed and hold `{ class, defaultApplied, source, updatedAt }`.
- **Exactly one default application per Session** via three serialized triggers on one internal chain: the **startup pass** (every current workspace member without a record → classify `human`, pin; records with `defaultApplied: false` → retry under their recorded class), the **dispatch declaration** (`declare` runs after create and before the first prompt, so a `bot` declaration can never lose a race to a first message), and the **first real user message** (`session/event` with `type === 'user/message'` and `data.source.kind === 'user'`) as the fallback for Sessions created in the UI mid-run. After `defaultApplied: true` no code path ever changes that Session's pin again — manual pin/unpin survives every restart (user ruling A, 2026-10-29).
- **Classification rule** (user ruling A, 2026-10-29): human-dispatched task Sessions = `human`; bot duty Sessions (rotation successor, watchdog takeover) = `human`; bot-dispatched task Sessions = `bot`; anything undeclared (UI-created, or predating this ledger) = `human`.
- **Workspace-membership gate**: only Sessions listed in some workspace and not in `archivedSessionIds` are ever recorded or pinned (subagent children, side threads, and forks never join a workspace list). Pinning uses the id spelling the workspace lists — that is the row id the client matches against `pinnedSessionIds`.
- **Wiring in `src/index.ts`**: the ledger is constructed with a structural view of `workspaceRegistry` (same cast convention as `sessionController`), the startup pass is enqueued at mount before any route serves, the dispatch routes receive `attention`, and a `session/event` subscription runs the first-message fallback. A ledger failure is reported as `attentionRecorded: false` alongside `bindingRecorded: false` and never fails a dispatch.

## Alternatives considered

- **Harness fork patch (store origin in workspace registry state, apply defaults in bootstrap)**: rejected. Everything needed — enumerate members, pin/unpin, observe session events — is reachable from this plugin; a host change would add fork-patch governance, a frontend/host rebuild, and no extra capability. The registry schema stays upstream-owned.
- **Re-apply defaults at every Host startup**: rejected. It clobbers manual pin changes on restart; the ruling explicitly chose "every session once, manual changes survive every restart".
- **Track a manual-override flag and skip only user-touched Sessions**: rejected as unnecessary state with an attribution race (was the last pin-set change mine or the user's?). Apply-once makes the question moot.
- **Classify at attach time (pin every new Session on creation)**: rejected. Blank/never-messaged placeholder rows would pin immediately, amplifying ghost clutter; the first-real-user-message trigger pins only once a Session has content, while `defaultApplied: false` records let the startup pass or a later message settle them.

## Consequences

- Classification lives only in the sidecar; losing the file degrades to `human` on the next startup pass (fail toward pinning), never to a crash.
- The plugin cannot infer duty-vs-task for bot-created Sessions: dispatchers declare it. The convention lives in the caller side (m-note `dsh-session-dispatch` and `taskbot` skills, guard scripts): task dispatch → `bot`, rotation/takeover → `human`, human-initiated dispatch → omit or `human`.
- First boot after upgrade pins every pre-existing undeclared member (including any live bot task Session that predates the ledger — one manual unpin clears it, and it never re-pins).
- No UI surface shows the class; the effect is pin ordering only.
- Dead or never-messaged records with `defaultApplied: false` retry cheaply on each startup (one refused pin, no write when nothing changed).

## Testing

`tests/attention.spec.ts` (16 cases) covers the document parser, the startup pass (human defaults, archived skip, listed-spelling pinning, retry of pending records, failed-pin persistence, corrupt-file quarantine), the once-per-session guarantee across ledger restarts, `declare` (human/bot/ledger-failure rejection), and `ensureFirstMessage` (human fallback, non-member gate, applied-record no-op). `tests/routes.spec.ts` gains 5 cases: `sessionClass` validation, the wire default `human`, `declare`-before-prompt ordering for `bot`, `attentionRecorded: false` on ledger failure, and the no-attention-service profile shape. Package typecheck, `vitest` (83/83), and `tsdown` build pass; `verify-docs.mjs --write` re-recorded the README pair (2026-10-29).
