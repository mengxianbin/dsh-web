# Agent Note: The skill center gives plugin-provided skills an enable switch

Status: implemented

## Problem

A skill whose instruction file comes from a plugin provider has no writable path in the panel. The registry reports a `SkillSummary.path`, but the file sits outside every skill root this panel scans, so the row rendered with no toggle, no edit action and no delete button, and the write routes would have answered 404. A panel that lists a skill and then offers no way to manage the most basic property of it reads as broken rather than as bounded — and the switch is the control whose absence is hardest to explain, because every other row has it.

There is also no file the panel may rewrite to record the decision. The frontmatter switch the other rows use edits a SKILL.md that the plugin owns, in a directory the panel does not scan and is not documented to write: a corrupted frontmatter there would break the provider, not the panel, and a plugin upgrade could lose the setting outright.

## Decision

The switch state for a plugin-provided skill lives in a store of the panel's own, keyed by the identity the panel already displays.

1. **The store.** `provider-toggles.ts` owns one JSON document at `$DSH_HOME/dsh-skill-explorer/provider-toggles.json`, shaped `{ version: 1, disabled: [{ name, provider }] }`. The key is the stable `(provider, name)` pair: the name alone is not enough, because the registry merges by name while two providers can each supply a file for it, and an absent provider normalizes to the empty string so one skill always maps to exactly one record. Writes are atomic (unique temp file, `fsync`, `rename`), so an interrupted write cannot leave a half-written document behind.
2. **Tolerant, bounded reads.** A missing, corrupt, or foreign document reads as "nothing switched off" — the state of a fresh install — instead of failing the list route. A record whose name fails the official skill grammar or whose provider id is longer than 200 characters is dropped rather than carried forward, duplicates collapse, and the set is capped at 512 entries. `setProviderSkillEnabled` skips a no-op write, so both directions are idempotent and a double click or a retried request cannot stack duplicates. The identity type is imported type-only, so the store cannot form a runtime cycle with the collector that owns the name grammar.
3. **The route.** `POST /api/dsh-skill-explorer/set-provider-enabled` takes `{ name, provider?, enabled }` and validates the identity with the same guard the store applies. It never receives or writes a path: the client sends the identity it displayed, never a location. **Disabling** requires a fresh collection to still resolve that pair to a `provider-file` row — the same "only what the panel showed" rule the file write routes follow through `resolveScannedSkill`, here with the identity instead of a path — and answers 404 otherwise. **Enabling** only ever drops a record, so it is allowed unconditionally: a plugin can be uninstalled while its record is still stored, and that record must stay removable.
4. **The collection applies the store last.** `collect.ts` exports `applyProviderToggles`, which clears `modelInvocable` for the rows it names, and runs it as the final step of `collectSkills`. Last is load-bearing: the registry merge can replace a scanned entry with the registry's own pathless one, so applying the store earlier would let merge order decide whether a row is switchable. Only a `provider-file` row is touched — an `editable` row's switch rewrites its own frontmatter and is already reflected by the scan, and a `virtual` row has no file at all. Like the frontmatter field this switch stands in for, it clears `modelInvocable` only; the provider's own `userInvocable` policy is not the model's automatic-call decision and stays as registered.
5. **One switch, two identities.** The panel offers the switch whenever the row has a path or is a `provider-file` row, and the toggle calls the frontmatter route with the certified path in the first case and the panel-local route with the identity in the second. Edit and delete stay absent for both pathless states, because those controls genuinely would answer 404.
6. **The scope is panel-local, and every surface says so.** The host registry still loads the skill. The switch changes what this panel lists as invocable, not what a session can load; taking such a skill away from the model for real means removing or disabling it where its provider gets it. The row hint, the package README (security model and known limitations) and the package `AGENTS.md` state this instead of implying the model stopped receiving the skill.

## Scope and boundary

The store is not a provider registry, not a model-catalog authority, and not a way to edit or delete a provider's file. The official `skill` tool catalog remains the authority on what a session can load, and the panel's catalog alignment stays owned by [The Skill Center Lists What the Official Provider Loads](../bug-fix/2026-10-03-skill-center-lists-official-loadable-skills.md); the invocation-policy rule for a skill with an editable file is owned by [Omitted Invocation Fields Mean Invocable in the Skill Center](../bug-fix/2026-10-03-skill-explorer-invocation-omission-means-allowed.md); the pathless-row presentation this narrows is owned by [The Skill Center Manages the Custom Roots the Provider Row Declares](../bug-fix/2026-10-05-skill-center-manages-provider-row-custom-roots.md). None of them is superseded.

## Alternatives considered

**Rewrite the provider's SKILL.md frontmatter anyway.** Rejected: the panel's whole write safety property is that it only touches paths a fresh scan produced, and a path the registry reports would have to be re-validated by a scan that does not exist for this file. It would also make a plugin upgrade able to lose the setting.

**Keep no switch and let the row explain itself.** Rejected: the requirement is a control. The row already distinguishes "provided by plugin" from "no local file"; leaving both control-less is what made a listed skill look broken in the first place.

**Key the store by skill name alone.** Rejected: the registry merges by name, so two providers can each supply a file for one name and only one row is shown. A name-only key would let one provider's record silence another provider's row.

**Key the store by the provider's file path.** Rejected: it reintroduces exactly the uncertified path this note refuses to accept, and it goes stale the moment the plugin moves or repackages its file.

**Apply the store inside the registry merge instead of at the end of the collection.** Rejected: the merge can replace a scanned entry with the registry's own, so merge order would decide whether a row is switchable — an ordering fact that must not be able to change a user's recorded decision.

**Make disabling unconditional, like enabling.** Rejected: a disable record is honored from the next list onward, so an unconditional one could silence a row the panel never showed. Enabling only removes a record and carries no such risk, which is why the asymmetry is deliberate.

**Write the switch through the official skills registry.** Rejected: this panel is a GUI management layer with no registry write surface, and a registry-level disable is a host-wide behavior change it has no standing to make.

**Keep the switch in the panel's plugin config.** Rejected: that config is layered with the profile patch and the host, so a machine-written field there is a shared, hand-editable surface rather than panel-owned state, and a hand edit of the patch would discard it.

**Poll or watch the registry for changes and reflect them in the store.** Rejected: the store is only read at collection time, so a list that already ran reflects a toggle the moment it is made. Watching would add a second source of truth for a value the user sets in exactly one place.

## Consequences

- A plugin-provided skill can be switched off in the panel, and the panel's own list agrees with the switch on the very next read: the store is read per request rather than captured at mount, so a toggle is honored immediately and a restart picks the stored set back up.
- The switch is a view decision only. The host registry still loads the skill, and the row hint, the README and the package AGENTS.md all state it, so a user cannot read the switch as "the model no longer has this".
- The store is panel-owned and disposable: deleting the file returns every plugin-provided skill to enabled, and a corrupt, foreign, or oversized document degrades to that same state rather than failing the list.
- An identity the panel no longer lists can still be enabled, so a stored record stays removable after its plugin is gone, but it cannot be disabled, so the store cannot grow entries for skills the panel never showed.
- A user who wants such a skill gone from the model for real must act where its provider gets it. That is the one place where this switch is weaker than it looks, and it is the reason the panel-local scope is stated on every surface rather than only here.
- The bounded, deduplicated document means a hand-edited file can waste the panel's fidelity but cannot grow without limit or make the store unreadable.

## Testing

`packages/dsh-skill-explorer/tests/provider-toggles.spec.ts` covers the store on its own: a switched-off skill leaves exactly one record under the DSH home, switching the same skill off twice keeps a single record, switching one back on leaves the other switched off, a returning panel still sees what it switched off, enabling a skill that was never switched off leaves no document at all, a damaged file reads as everything enabled, a foreign document shape reads as empty, an unmatchable record is dropped, an oversized document is capped, a name outside the official grammar yields no record, and the store stays inside the plugin's own home directory. `tests/routes.spec.ts` covers the route end to end: the next list reports the skill as not model invocable, a second disable stores one record, a host restart still shows it switched off, switching back on restores the invocable view, disabling a skill the panel does not list as plugin-provided is refused, enabling one the panel no longer lists is allowed, and a malformed request answers 400 without writing. `tests/collect.spec.ts` covers the application step: a record naming a `provider-file` row clears `modelInvocable`, while one naming an `editable` row, a `virtual` row, an unlisted skill, or the same name under a different provider changes nothing. `tests/panel.spec.tsx` covers the rendering: the provider row carries a switch while a truly fileless row carries none, and toggling the provider row certifies its provider identity instead of a path. The package suite passes (176 tests).
