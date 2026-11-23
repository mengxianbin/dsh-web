# dsh-task-fsm

English | [中文](README.zh.md)

Task finite-state machine for DSH Web, implementing the pure-worker design
(`pure-worker-design-1123`): a worker + host mechanical-gate organization
where every task's progress is tracked by an explicit state machine instead
of a boss session. The machine authority is a single flat file
`~/.dsh/task-fsm-state.json` (host read/write; the board row stays the
human-readable ledger face). The host half mounts guarded routes under
`/api/task-fsm`; the browser half seats freeze marks, hover sub-reason rows
and a read-only frozen snapshot on session rows.

## What it does

- State x event transition table with a published completeness assertion —
  the machine refuses unknown events and unknown state/key combinations
- Six guards G1-G6 checked at the host before an action lands (worktree
  plan, taskRef 409 uniqueness, scope registry, acceptance gate, heartbeat
  liveness, terminal-write permission)
- Queue tiers (red / yellow / not-enqueued) with four-piece hover
  sub-reasons: what / why / who / next
- Frozen session marks (snowflake / lock) carrying the freeze reason on
  hover, a read-only snapshot when the row is opened, and two wake triggers
  (prerequisite terminal reached, quota free)
- Archive layering: children follow the parent worker, roots stay for
  human archiving, terminal states raise a notification
- Browser row seats registered through the public slot contract — zero
  harness source edits

## State file

`~/.dsh/task-fsm-state.json` is the machine authority (versioned schema,
atomic writes; a corrupt file is rejected loudly and never silently
rebuilt):

```json
{
  "version": 1,
  "taskRef": "content/tech/ai/dsh/tasks.md#<anchor>",
  "state": "backlog",
  "queue": "none",
  "session": { "id": "session-…", "mode": "active" },
  "attempts": { "redisp": 0, "autofix": 0 },
  "history": []
}
```

Old mechanisms (`taskbot-state.json`, dispatch bindings) have zero
read/write overlap with this file; the two tracks share services only
(taskRef 409, quota, revive, archive plugin, queue verdicts).

## Guards

1. G1 worktree plan — a task book without a worktree plan is refused
2. G2 taskRef 409 — one live binding per taskRef
3. G3 scope registry — the taskRef prefix must sit in a human-opened scope
4. G4 acceptance gate — machine readings must be green before terminal E8
5. G5 heartbeat liveness — a broken chain feeds revive (E13 / E14 / E10)
6. G6 terminal write — terminal writes follow the acceptance-gate ledger

## Install

Registered in m-note `.dsh/installed-plugins.json` and installed into the
web profile by `plugin-install.py`; manual form:

```bash
dsh plugin --profile web add link:D:/tech/dsh-web-prod/packages/dsh-task-fsm
```
