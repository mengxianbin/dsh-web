# Task-board settings verification — 2026-10-11

English | [中文](task-board-settings-verification-2026-10-11.zh.md)

## Scope and task book

Frozen verification snapshot for code commit `99721251`. Current contracts belong to the [reasoning-effort decision](../../.agents/notes/implemented/feature/2026-10-11-task-board-reasoning-effort.md) and [subtask decision](../../.agents/notes/implemented/feature/2026-09-24-task-board-subtasks.md).

| Work item | Boundary | Acceptance |
| --- | --- | --- |
| Host effort pipeline | Task fields, strict protocol, ledger, runner and tools | Model-coupled inheritance, clear/import round trips, fresh/reused session payloads and failure before prompt |
| Client controls and Team default | Task editors, catalog mapping, successful GUI joins and zh/en/ru copy | Declared levels only; no optimistic Team update; service availability gate |
| Independent review | Read-only source and behavior checks | Reproduced defects corrected; malformed-catalog and promotion guards covered |
| Real GUI | Scratch DSH home and official CLI only | Create/link, clear, reload, host restart, unavailable Team service, desktop/narrow layout and cleanup |

Implementation and rework used explicitly authorized `deepseek-official/deepseek-flash` subagents with disjoint file scopes; the dispatcher owned review, validation, documentation and local commits. No child staged or committed files. The SDK/runtime cohort stayed at `0.2.0-rc.2`; ledger schema stayed at 6.

## Recorded evidence

| Check | Result |
| --- | --- |
| `pnpm typecheck` | All 18 packages passed |
| `pnpm test` | 3793 passed; 1 existing native-power smoke skipped |
| Task-board package suite | 1034 passed; 1 existing skip |
| `pnpm test:scripts` | 384 passed |
| New helper/picker branch coverage | 99.06% combined; each file above 90%; client files 100%, core effort rules 95.45% |
| Build and fingerprints | `pnpm build`, `libs:write`, `libs:check`, `aggregate:check` passed; generated client bundle and map committed |
| Repository gates | Test standards, docs, zh/en/ru parity, runtime dependency purity, emoji audit and diff whitespace passed |
| Real GUI | 62/62 assertions passed; final committed bundle repeated the desktop flow at 20/20; console and asset errors 0 |

The isolated ledger confirmed the parent model/effort pair, two child `parentId` links and `teamRun: true`. Clearing removed the effort key rather than storing an empty string; refresh and a restart of the same scratch profile preserved state. Manual Team disable survived reopen; another successful GUI join enabled it again. A profile without the Agent Teams bundle did not promote its parent.

At 1600×1000 and 420×900, the form had no horizontal overflow, label/select left-edge drift was 0px, action buttons remained reachable, keyboard focus was visible, and reduced-motion sampling found no new control movement. Static KFL scanning found no new-file issues; pre-existing stylesheet warnings were not reclassified as fixes.

Every probe was stopped. The final probe used port 53723 and was recovered by an exit trap; ports 53711/53712/53713/53721/53722/53723 had no listeners afterward. The user's process 880 on port 53697 remained running and received no signal. HTTP tokens stayed in scratch files, not in this archive.

## Limits and recovery notes

- No LLM generation or actual teammate derivation was run. Official SDK contracts and contract-verified runner/service tests cover selection payloads; card settings do not redefine native teammate routing.
- Live GUI verification covered declared levels, not an orphaned stored level. Its visible-but-disabled option is covered by DOM tests and the HTML platform contract.
- KFL evidence is scoped, not full certification: 200% zoom, other viewports, narrow linking geometry, full overlay enter/exit pairs and real touch hardware were not measured. Existing color, hierarchy and icon contracts were reused; no new CSS, custom icons or animation implementation was added.
- Early test-standard violations and 86.91% branch coverage were corrected without weakening thresholds or baselines. One unrelated parallel-run abort test was flaky; isolated repeats and subsequent complete suites passed without production changes. QA helper locator/wait issues and the dispatcher's omitted URL-file argument were corrected before successful reruns.
- No push, version change, release, SDK upgrade or user-service restart was performed. Host-side updates require the user to reload or restart their installed DSH service after applying the local plugin build.

## Screenshots

![Task model, reasoning level and enabled Team](assets/task-board-settings-2026-10-11/team-enabled.png)

![Narrow task-creation execution settings](assets/task-board-settings-2026-10-11/narrow-settings.png)
