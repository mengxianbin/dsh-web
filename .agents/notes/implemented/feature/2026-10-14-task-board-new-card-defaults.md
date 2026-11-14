# Agent Note: New-card defaults for the task board

Status: implemented

## Problem

Creating a card means choosing the same four execution targets again. A deployment that runs every card under one agent preset, permission, model and reasoning level re-picks the same four values in the new-task dialog, and a model creating cards from a conversation passes them on every `task_board_create` call. Nothing in the board's settings says where a NEW card starts: those settings cover the board's runtime behavior and goal acceptance, and the create path stores exactly what its caller sent, so an omitted execution target keeps meaning "no pin, resolved at run time".

Reinterpreting an omitted target as "use the default" would change that meaning everywhere at once: the GUI form, the board's own agent tool and the extension provider's `tasks.create` write through the same create path, and the one-time `import` action normalizes stored rows of its own.

## Decision

The settings card carries one more topic, New-card defaults, holding four volatile keys: `cardDefaultMode`, `cardDefaultPermission`, `cardDefaultModel` and `cardDefaultReasoningEffort`. Every one defaults to an empty string, which pins nothing: a deployment that configures none of them creates cards exactly as it did before this topic existed, and an edited value applies to the cards created afterwards with no restart. The topic is one more collapsed row of the settings card's topic list ([settings disclosure cards](./2026-10-01-task-board-settings-disclosure-cards.md)) and is written by that card's single save.

The four are prefills, never pins. The GUI new-task dialog opens with the configured values already selected and the user may change any of them; the card stores what it was created with and stays editable afterwards, like every other execution target.

A new card takes each target in one order: the choice made in the dialog wins over the values carried over from the card it was created from, which win over the board defaults. Duplicating a card keeps every pinned value of its source and fills only the fields that source left unset; a subtask created from a parent keeps the parent's pinned values the same way, except that the parent's PERMISSION never participates — the permission is not copied onto a card at creation ([subtasks](./2026-09-24-task-board-subtasks.md) owns that invariant), it is resolved along the ancestor chain at launch together with the confirmation stamp of the ancestor that provided it.

`cardDefaultReasoningEffort` is bound to `cardDefaultModel` exactly as a card's own effort is bound to its own model ([reasoning effort](./2026-10-11-task-board-reasoning-effort.md)): the default level applies only while the card's final pinned model IS the configured default model. A caller that picks a model of its own borrows no level at all — neither the source card's nor the default one — and a blank `cardDefaultModel` makes the default level inert.

A default permission may sit above the session permission baseline. That is a configuration choice, not a bypass: the value is only what the form offers, and the existing pre-execution gate is untouched, so a card whose effective permission is above the baseline still refuses to run until a human confirms that binding.

The Host create path opts in. The create action gains the boolean `applyCardDefaults`, which fills the targets the caller left out with the board defaults, and `task_board_create` sets it. Without the flag the action behaves exactly as before, so the extension provider's `tasks.create` and the legacy browser import — neither of which sets it — keep their own meaning for an absent field.

A saved default reaches a page that is already open. The board's client follows the settings form the settings card saves through: when the signature of the four `cardDefault*` keys changes it re-reads the authoritative Host snapshot (`BoardController.refreshHostState()`), so a new-task dialog opened later in the same page session prefills from the saved values with no reload, and a cleared default stops being offered at once — the Host represents "not configured" by omitting the key, so the browser mirror takes that field from the snapshot rather than from the previous value. One save causes one re-read; a write to any other setting causes none.

## Required verification

- The four keys persist in the settings namespace, are volatile, and an empty value leaves every create path byte-for-byte as it was: no pin is added and no default is substituted.
- The GUI dialog shows each configured default as the selected value and lets the user override it; the created card stores the override, not the default.
- Priority holds in each creator: an explicit dialog choice wins; duplicating a card keeps the source's pins and applies the defaults only to the fields the source left unset; a subtask created from a parent resolves defaults only where the parent pinned nothing and never takes the parent's permission.
- The effort binding holds in every direction: the default level is applied only while the card's final model is `cardDefaultModel` and the caller picked no model; a caller that picks a model of its own gets no level, neither the source's nor the default; a blank `cardDefaultModel` makes the default level inert; and a source card's own model/level pair still travels together.
- The gate still holds: a default permission above the baseline leaves the card unconfirmed, and a manual run or a cron trigger still refuses until a human confirms it.
- `applyCardDefaults: true` fills only omitted values and never overwrites one the caller passed; the same create action without the flag, the provider's `tasks.create` and the legacy import produce unchanged cards.
- Saving the defaults reaches a page that is already open: without a reload, a new-task dialog opened after the save prefills from the saved values, and clearing a default returns that field to unset on the next open.

## Alternatives considered

**Prefill in the browser only.** Rejected: a card created through the board's agent tool would then ignore the configured defaults, and the same board would answer differently depending on who created the card; covering both creation paths with one setting is the point of the change.

**Read an omitted execution target as "apply the board default".** Rejected: absence is a value — it is how "no pin, inherit" is stored — so reinterpreting it would silently pin cards in deployments that never configured a default, and it would reach the extension provider's `tasks.create` and the legacy import, which share the create action. The opt-in flag keeps the new behavior inside the paths that ask for it.

**Offer a universal reasoning-level list as the default's choices.** Rejected: adapters own the levels their model supports, and the existing effort decision already refuses a universal low/medium/high list; a default level the resolved model does not declare could only be rejected by model selection at run time. The default is chosen from the same catalog-derived list the card's own selector uses.

**A board-level pin rather than a prefill** — the shape [the create-dialog decision](./2026-09-27-task-board-create-dialog-regions.md) rejected when the deployment default was the only inherit target. Rejected here for the same reason: a pin would override the deployment default for every card the user never configured. A prefill with its own "unset" state leaves that inherit target in place, so what the earlier note protected still holds — the per-card choice stays where the judgement is made.

**Publish the values on the board's event stream.** Tried, measured on an isolated probe host, and reverted. The browser mirror would have followed the SSE frames instead, with a frame re-sent after a volatile settings write. The connection frame did carry the current value, but the frame emitted right after a save carried the value as of BEFORE that write — two consecutive edits both lagged one step — while `GET /api/task-board/state` already answered with the new one: the Loader hands a volatile update to its fiber while the new document is not yet visible to that fiber. Frames also merged into the mirror as an unconditional overwrite, so that stale value could replace a fresher one, which is worse than the defect it was meant to fix. Re-reading the snapshot on the settings-form signature has neither failure.

## Consequences

- A deployment that wants one agent preset, permission, model and reasoning level for its cards states them once; any card may still differ, and an unconfigured default keeps today's behavior for everyone else.
- The defaults cannot lift the permission gate: they change what the new-card form offers, not what the Host lets run.
- The GUI dialog and `task_board_create` with `applyCardDefaults: true` now agree on where an unset target lands; the extension provider's own create path and the legacy browser import are unchanged and keep their own meaning for an omitted field.
- The settings card gains four keys in a topic of its own, so the collapsed topic row that names them carries the whole feature; a deployment that never opens it is unaffected.
