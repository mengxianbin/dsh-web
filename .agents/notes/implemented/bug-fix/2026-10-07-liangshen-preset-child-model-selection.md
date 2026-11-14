# Agent Note: Liangshen preset child-model selection opt-in

Status: implemented

## Problem

`packages/dsh-liangshen/presets/liangshen/agent.cordis.yml` derived its delegation rows from the builtin presets but dropped the child-model opt-in while copying them: neither `tool-subagent` nor `tool-subagent-fork` carried it. Every consequence of the opt-in hangs off it:

- the delegation tool publishes no `provider` / `model` / `reasoning_effort` parameters, so an explicit child route fails at call time with `child model selection is disabled for this tool instance`;
- the tool description never carries the child-selection sentence and `list_subagent_models` is never registered, so the model has no discovery path;
- the web settings page subagent model-selection toggle therefore reads as dead under this preset even though the host owns the settings service (`subagent-model-selection-settings`, mounted by the official `dsh-web-app` host bundle).

Every official preset that ships delegation rows enables the opt-in on the spawn row (`standard.patch.yml`, `ptc.patch.yml`, `cordis.patch.yml`), so the shipped Liangshen roster was the outlier.

The opt-in itself was split upstream afterwards: `modelSelection` publishes the route fields and `modelDiscovery` registers `list_subagent_models`, while the pre-split `modelSelectionSettings` is retired in the harness cohort this repository runs against. A field the loader schema does not declare is never read — Schemastery keeps the undeclared field and fills the declared booleans with `false` — so a preset carrying only the retired key loses the opt-in again, with no load error and no warning to notice. The cohort pinned in `devDependencies` (`0.2.1-rc.3`) still declares only the retired key, so neither spelling alone serves both cohorts.

## Decision

The `tool-subagent` row enables both current knobs, `modelSelection: true` and `modelDiscovery: true`, and keeps the pre-split `modelSelectionSettings: true` beside them: each cohort reads the key it declares and leaves the other unread, so the opt-in survives the split. The row drops back to the current pair once no supported cohort predates it.

The `tool-subagent-fork` row enables neither, and discovery must not move there:

- upstream registers the discovery tool under the FIXED name `list_subagent_models` (`registerListSubagentModels` in `packages/subagent/tool-subagent/src/list-models.ts`) into the scope the row composes into;
- a preset-scope row installs per composed Agent through `candidate.ctx.inject(...)`, so every discovery owner reaching the same composition scope registers that one name into the same Agent scope;
- the tool registry rejects a duplicate name inside one scope: `NamedEntries.insert` throws from its duplicate factory, with the message `tool "list_subagent_models" is already registered in this scope`. A second discovery owner therefore fails session composition outright instead of adding a second opt-in.

So the shipped invariant is: exactly one delegation row per composition scope may enable discovery, and the fork row is precisely the row a maintainer would complete by mistake. The constraint is written into the preset file beside the row, and `tests/preset-composition.test.ts` counts the discovery owners structurally over the parsed composition (descending into group rows) rather than only pinning the spawn row text, plus a mutation check that injects a second owner into the fork row and asserts the guard counts it.

The route fields alone are per instance, so `modelSelection` on the fork row would collide with nothing; the row still leaves them off, because the official Standard, PTC, and Cordis rosters leave both off there and this preset mirrors their shape. Child route selection needs a provider that advertises `agentOptions`; in-process Spawn and Fork both do. The harness's `/model-selection-settings` service samples the user preference during Agent creation, independently of tool installation, so no preset row mounts it.

## Testing

- `packages/dsh-liangshen/tests/preset-composition.test.ts` asserts the spawn row carries the current pair plus the retired spelling, that the fork row carries neither, that the parsed composition has exactly one discovery owner (`['tool-subagent']`), and that injecting `modelDiscovery: true` into the fork row reports `['tool-subagent', 'tool-subagent-fork']`, so the guard cannot pass vacuously.
- The retired key was measured inert on the cohort this repository runs against: parsing the row through that checkout's own `Config` keeps `modelSelectionSettings` and leaves `modelSelection` / `modelDiscovery` at `false`, while the published `0.2.1-rc.3` declares `modelSelectionSettings` and neither new key.
- `pnpm --filter @linxin666/dsh-liangshen test` (364 tests) passes.
- No live GUI evidence: the preset change takes effect in a new session, and the running host was left untouched.

## Alternatives considered

- Enable the opt-in on both the spawn and the fork row so every delegation tool could pick a route. Rejected for discovery: that is exactly the configuration that makes the whole session fail with `tool "list_subagent_models" is already registered in this scope`. The route fields alone are safe on the fork row, but the official rosters leave them off there.
- Patch upstream to register the discovery tool idempotently, or under a per-tool name. That is the right fix, but it belongs to `@deepseek-ai/dsh-tool-subagent`, and this repository never modifies the harness or its SDK packages. It is filed upstream instead; the preset-side comment and test keep the local roster correct until it lands.
- Ship only the current pair and drop the retired key. Rejected: the SDK pinned in `devDependencies` declares only the retired key, so this package's own cohort would lose the opt-in silently — the defect this note records, moved one generation over.
- Declare a preset-local `agentOptions` block (`provider` / `model` / `reasoningEffort` / `maxTokens` are the real upstream field names, confirmed in the installed schema) to pin a default child route instead of enabling model-facing selection. Rejected: it does not restore the settings toggle the issue is about, and it would silently force one child route for every delegation. The key stays unset; it remains a valid separate choice for an operator who wants exactly that.
- Omit the opt-in and document the limitation. Rejected: it leaves the reported defect in place on a preset whose upstream counterpart carries the flag.

## Consequences

- The web settings page child-model selection toggle is honored under Liangshen mode: with the host settings enabled, the model sees the route parameters on `subagent` and can call `list_subagent_models`; an explicit route is checked against the Session allowed list, and without a recorded policy it falls back to the parent Agent's current route.
- Both spellings ship until the supported cohort moves past the split, and the preset file states the deletion condition beside them.
- The one-owner rule now binds discovery alone. A maintainer who wants routed forks can enable `modelSelection` on the fork row without breaking composition, but the shipped roster does not, matching the official presets.
