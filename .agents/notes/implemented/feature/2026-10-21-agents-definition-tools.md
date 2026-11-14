# Agent Note: Agent squad definitions get a model-facing tool surface

Status: implemented

## Problem

A squad definition is reachable only through its page. To ask which squads exist, add a member, or start one, a human has to open the page, fill a form and press a button — while the agent that just answered "how should I split this work?" is the one that knows which preset and permission the deployment offers. The definitions therefore stay outside the conversation that reasons about them, and every squad the user keeps has to be re-described by hand in the chat before an agent can use it.

Two shortcuts were in reach and neither holds. The package already installs a per-session tool set for the Agent Teams runtime, so the cheapest move looks like adding ten names to it. And the package already serves seven HTTP routes over the same ledger, so the second cheapest looks like calling those routes from the tool. The first puts definition management inside sessions that only exist during a squad run, where a definition is precisely what cannot be edited: a running team's roster is fixed, and the session that would do the managing is the one being managed. The second routes an in-process call through the browser-facing fence: it buys an HTTP round trip, a second decode, and a port, for nothing the service call does not already give.

## Decision

The package registers ten model-facing tools in every session: `squads_list`, `squads_read`, `squads_create`, `squads_update`, `squads_delete`, `squad_member_add`, `squad_member_update`, `squad_member_remove`, `squads_run_member` and `squads_run_squad`. They call `AgentsHostService` directly — the same object `src/host/routes.ts` calls — so the ledger, its lock, the launch order and every fail-closed pin are the ones that already exist. `DSH_AGENTS_ROUTE_PATHS` still lists seven routes; the tool surface adds none, removes none and needs no port.

Argument gating reuses the package's own parsers in `src/protocol.ts` (`parseTeamDraft`, `parseMemberDraft` and the id readers) instead of restating the caps, the exact-key rule and the enum membership in a second place. One parser means one answer to "is this draft acceptable": a field the page cannot send is a field a tool cannot send either, and a cap raised in the protocol raises it for both. The two run tools delegate to `AgentsHostService.run` and `AgentsHostService.runSquad`, so a tool-started run records what a page-started run records. `squads_run_squad` carries a goal and nothing else: the goal travels on the request and reaches the Lead through the `team:squad` system-prompt context, never as a fabricated user message.

Success values are `{ ok: true, ... }`. A domain refusal is a value — `{ ok: false, code, message }` — with `code` drawn from `AGENTS_ERROR_CODES`, `invalid-request` for a malformed call, and no new code introduced; only a failure this plugin did not raise is thrown.

## Gating and announcement

Registration is global with `enabled`, the convention [Family tool-surface conventions](2026-10-02-family-tool-surface-conventions.md) owns: one registration for the whole host, withdrawn when the setting turns off, which is what leaves the registry's per-scope restriction able to withhold these names. Only the placement is this package's own: the announcement is a separate `plugin:agents` section at order 220 from the family's section table, so it sits in the plugin guidance band rather than inside the team policy section a squad-run session gets, behind `announceToAgent` on the plugin's settings card (default `false`, volatile) and rendered through `visibleToolText` so it names only the tools visible to the scope assembling the prompt. A static sentence naming all ten would keep telling a model to call tools a setting or a restriction had already taken away, and the prompt is the only place that lie would be invisible.

## Partial updates and destructive confirmation

`squads_update` and `squad_member_update` merge partially: an omitted field keeps its current value, an empty string clears that optional field, and `name` refuses an empty string. A replace would force every caller to restate a member's brief, model pin and permission to change one of them, and the first caller that forgot would silently drop a pin the user had set — a data-loss shape for a call whose stated intent was "rename this".

`squads_delete` and `squad_member_remove` require `confirm: true`. Any other value answers `{ ok: false, code: 'invalid-request' }` before the ledger is touched, and a successful delete returns the deleted object's `id` and `name`. The flag makes an accidental delete a refused call rather than a lost definition, and the name in the return value is what lets the caller report what it removed: an agent that only sees `ok: true` cannot tell its user whether it deleted the squad or the member.

## Alternatives considered

- **Install the ten tools only into squad-run sessions, beside `team_*`.** Rejected. A squad-run session exists to run one squad and its roster is fixed for the run's lifetime, so the session that could manage definitions is exactly the one that cannot change them; and an ordinary conversation — where the agent is asked what squads exist, or told to build one — would still see nothing. It also inherits the install gate's cost: a re-scan of live agents on every membership change, for tools whose subject is the ledger rather than the session.
- **Call the plugin's own loopback HTTP routes from the tool.** Rejected. It would put the browser fence, the body cap and a JSON decode between the model and a ledger it can already reach in process, add a port dependency to a conversation, and make a local call fail the way a cross-origin request fails. The routes stay the browser's transport; the tools take the service.
- **Write a second validation layer for the tool arguments.** Rejected. The caps, the exact-key rule and the permission enum live in `src/protocol.ts` and are the ledger's only gate; a second copy would drift the first time either side changed, and the two surfaces would answer "acceptable draft" differently. Reusing the parsers needs no new dependency and keeps one owner for the contract.
- **Make the update tools replace the whole definition.** Rejected on the data-loss argument above: a partial merge costs one `undefined` check per field and cannot drop a pin the caller did not mention.
- **Delete without a confirmation flag, or answer with `{ ok: true }` alone.** Rejected. An identifier typo is cheap to make and unrecoverable, so the flag is the difference between a refused call and a lost definition; and a bare `ok` leaves the caller unable to name what it deleted, which is the one fact a destructive report needs.
- **Announce the tools with one static sentence, unconditionally.** Rejected on the argument the family already records in [Family tool-surface conventions](2026-10-02-family-tool-surface-conventions.md): guidance for a tool a scope cannot see only makes the model attempt a refusal. Here it would additionally survive a preset that restricts the surface, which is one of the states these tools must still work under.

## Consequences

- Every session carries ten more tool schemas. The announcement is off by default, so prompts stay clean until a user opts in, but the tool schemas are part of the registry in every session that inherits them.
- A definition the model writes is a launch target: `squads_run_member` and `squads_run_squad` open real sessions and spend the same API quota a page-started run spends, so one agent turn can start a squad. The pins still fail closed by name, and a run the deployment cannot honour is refused instead of degrading to a default.
- The HTTP fence is unchanged: no route moved, no route added, and the tools are reachable only inside this Host's own process. A deployment that never exposes the routes still serves the tools.
- Ledger ownership is unchanged. A tool call takes the same process lock and writes through the same fsynced rename, so a second Host still fails closed instead of interleaving writes.
- The two surfaces stay distinct: the definition tools exist in every session, and the `team_*` tools still install only into a squad-run session. Neither replaces the native subagent tools.

## Testing

The surface owns no rule of its own, so its coverage is the coverage of the paths it reuses: `packages/dsh-agents/tests/protocol.spec.ts` pins the argument parsers, `packages/dsh-agents/tests/service.spec.ts` pins the Host refusals the tools return as values, and `packages/dsh-agents/tests/routes.spec.ts` pins the seven-route list this surface does not extend. `packages/dsh-agents/tests/team-runtime.spec.ts` pins the contrast that keeps the two surfaces apart: no Team tool in a plain root session, the full set in a squad-run session.
