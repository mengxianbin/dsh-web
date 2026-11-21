# Agent Note: The liangshen preset mounts the human /goal command beside the goal tool

Status: implemented

This note owns the goals section of the liangshen preset composition, `packages/dsh-liangshen/presets/liangshen/agent.cordis.yml`, and the structure guard that keeps it in `packages/dsh-liangshen/tests/preset-composition.test.ts`. The host-side goal domain those rows consume belongs to dsh's own goal packages, not to this repository.

## Problem

Issue #1961: a liangshen session served no `/goal` command. The preset's goals section declared the model-facing `tool-goal` row alone, and its comment asserted that the `/goal` command stays on the host plane. That assertion was the opposite of the host composition: the Web bundle keeps the goal service and the goal-round driver on the host but disables the base command producer, leaving the producer to the agent preset, and dsh's own `dsh-command-goal` documentation says the same thing in one line — the standard, ptc, and cordis presets mount the producer and minimal omits it. All three of those presets declare a top-level `command-goal` row named `@deepseek-ai/dsh-command-goal` immediately before `tool-goal`. Liangshen therefore shipped the model surface of one domain without its human surface, and the comment explained the gap with a fact the bundle contradicts.

## Decision

1. The goals section of `packages/dsh-liangshen/presets/liangshen/agent.cordis.yml` declares the domain's two consumers as two plain top-level rows: `- id: command-goal` with `name: '@deepseek-ai/dsh-command-goal'`, and the existing `- id: tool-goal` with `name: '@deepseek-ai/dsh-tool-goal'`. Neither takes a realm, matching the builtin presets: a command row consumes the host `commands` service and the host goal service, and an entry-local realm would hide them.
2. The section comment states the split as it is: the goal service and its session driver stay on the host plane, while the command and the tool are mounted by the preset.
3. `packages/dsh-liangshen/tests/preset-composition.test.ts` pins the pair structurally through the preset's own composition reader: exactly one top-level `command-goal` row naming `@deepseek-ai/dsh-command-goal`, the `tool-goal` row still present, one declaration of the command in the file, no copy nested inside a group, and a non-vacuity check where deleting the row makes the guard read it back as absent.

## Alternatives considered

- **Leaving the host to mount the command producer, as the removed comment claimed.** Rejected: the Web bundle disables the base producer precisely so a preset owns it, so a session on a preset that omits the row has no `/goal` command at all — the reported defect.
- **Wrapping both rows in a group with an entry-local realm.** Rejected: the builtin standard, ptc, and cordis presets declare them top-level, and this file's header reserves realms for services a preset publishes; these rows consume host services, so a realm would hide `goals` and `commands` and neither row would register.
- **Adding `command-goal` and dropping `tool-goal` to match the minimal preset.** Rejected: the issue asks for the human command while keeping the existing goal tool, and the driver settles a session through the model's own `update_goal`, which removing the tool row would take away.

## Consequences

A liangshen session serves `/goal` from the same row the builtin presets use, so create, edit, pause, resume, clear and inspect work from the composer without a model turn, and `update_goal` keeps working beside it. The preset no longer carries a comment that contradicts the host composition. Nothing else moves: the row resolves against the host's own installed copy exactly as `tool-goal` already did, so no package dependency or lockfile entry changes.

## Testing

`npx vitest run tests/preset-composition.test.ts` in `packages/dsh-liangshen`: 13 passed, including the added goals-section scenario and the existing composition-validity scenario that parses the edited file.
