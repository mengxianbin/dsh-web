# Agent Note: The board hides the official automation-tasks entry

Status: implemented

## Problem

The DSH web shell mounts two scheduling surfaces into the same sidebar. The official `ui-schedule` client half contributes the "Automation tasks" row over the Host Schedule service — the reminders a model creates with `schedule_create` and that the Host delivers into a session — and this repository's task board contributes the "Task board" row over its own Host ledger, which starts real DSH sessions on a cron schedule. A deployment that installs the family shows both rows side by side, and the two do different jobs: the official one is a reminder catalog, the board is a task ledger with permission gates, run groups and subtask cascades. The board is the family's more complete surface, so the sidebar offers a duplicate entry for the same job.

Neither surface may be dropped from the Host. The repository never modifies a DSH source checkout, and the official Schedule service is the Host's own: reminders a model wrote through `schedule_create` live there and still need their page. The board's master switch already owns the board's own row (switching the board off hides that row and the board view), so the sidebar's duplicate has to follow the same switch instead of disappearing unconditionally.

## Decision

While the board is enabled, the board's browser half hides the shell's official automation-tasks row, and switching the board off brings the row back.

The guard lives in `packages/dsh-task-board/src/client/suppress-schedule-row.ts`. It reads the shell's own panel-list ledger for the official entry (the id `schedules`) and takes that entry's accessible name from the same `resolveSlotLabel` call the shell's panel projection makes, so the match follows the active language instead of a hard-coded translation. It then locates the row inside the shell's global panel list seat (`sidebar.panellist`, whose per-row anchor the slot renderer stamps) and writes one inline `display: none` on the shell's own button. The row stays mounted and React keeps owning it; the official page keeps working everywhere else it is reachable, and the write is re-applied after every DOM change through the family's shared body-mutation hub, because the shell may mount or replace the row at any time.

The board's master switch owns the state, exactly as it owns the board's own row: the guard hides the official row in the same branch that mounts the board's row and restores it in the branch that unmounts it. A deployment without the official plugin has no such entry in the ledger, and the guard then hides nothing.

## Alternatives considered

- **Disable the official `ui-schedule` loader row in the profile.** A row-level `disabled` override is the supported way to keep a plugin out of a profile, and it was the first candidate. It loses on three counts: the override is static, so the family aggregate's patch layer would hide the official row even in a deployment whose board is switched off; it removes the official page as well, which strands the Host reminders that `schedule_create` writes; and an override naming a row the profile does not declare is a stale entry the loader has to prune, so a family installed outside a `dsh-web-app` profile would carry dead configuration.

- **Shadow the official row in the slot ledger.** A list cell's winner is its lowest-priority entry, so registering the board's row under the official id would replace the official row — but only if the board also shadowed the official `main` page under the same key, which turns the board into the official panel (the host's own panel analytics would then report the board as the cron panel) and costs the board its own panel identity. The board keeps its id, and the official row is hidden instead of replaced.

- **Hide the row with CSS keyed on the official clock glyph or on a literal translation.** The official row carries no plugin-owned hook — the family's own rows do, and the skins resolve the owning plugin through it — so the clock glyph is shared with other surfaces and a hard-coded label breaks in every language but one. The ledger supplies the label the shell itself renders, and the guard reads it from there.

- **Ask the Host to own the choice (a "superseded panel" concept in the slot contract).** The Host's slot contract has no such notion, and this repository may not modify a Host checkout, so the question is left open for an upstream change; the guard is the smallest thing that fits the contract as it stands.

## Consequences

The sidebar shows one scheduling entry while the board is on, and the official entry returns with the board's master switch. The official automation-tasks page is not removed: the Host reminders a model created stay reachable, and nothing is orphaned by the family's choice.

The guard reads the shell's row markup — the slot anchor and the accessible name. A shell that stops stamping them leaves the official row visible again, which is a visible duplicate entry rather than a broken board, and the board itself never depends on the guard.

## Testing

`packages/dsh-task-board/tests/suppress-schedule-row.spec.ts` pins the contract: the official row is hidden while the board is on, the other rows are untouched, the board's own row is never hidden, the row comes back when the board is switched off, nothing is hidden on a deployment without the official plugin, and a row the shell replaced is hidden again. The live Web GUI is the other half of the evidence: the sidebar shows one scheduling entry with the board enabled.
