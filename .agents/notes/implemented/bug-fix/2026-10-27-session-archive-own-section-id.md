# Agent Note: Session archive seats its own settings section id

Status: implemented

## Problem

The settings shell renders one nav row per `settings.section` registration and never merges same-id sections; its registry refuses a second registration of the same `id` at the same `priority` (default 0), and `order` only sorts the rows. `dsh-session-archive` seated the official `archived-sessions` id, which is how it kept exactly one archive entry on a cohort whose official page is no longer mounted. On a profile that also runs a third-party archive plugin — several seat a first-level archive section — the same id at the same priority occupies one seat twice: one registration throws, or one of the two entries disappears from Settings with no visible error. Either way a user who enabled both plugins loses an archive surface they never removed (issue #1955).

## Decision

The plugin seats its own section id, `dsh-session-archive` (the plugin id), at order 25.

- The id is this plugin's own namespace, never a seat that belongs to the official page or to another plugin. Two archive plugins can be enabled at once, one entry each, and neither has to detect or defer to the other.
- Order 25 is kept, so the entry stays where archive management already sat: beside the official `archived-sessions` row, not at a new position in the nav list.
- A profile with one archive plugin still shows exactly one entry. The plugin does not require the official page to be absent, and it retires and disables no foreign row.
- The label still resolves through this plugin's own `arch.nav` copy in the namespace's active language, so a language pack keeps reaching it.

The [takeover decision](../architecture/2026-09-15-sdk-cohort-0.1.6-alpha.1-alpha-branch.md) stays on record for the cohort that needed it. Its one-entry premise now rests on id ownership instead of id takeover: one entry per archive plugin, and no two plugins ever claiming the same seat.

## Alternatives considered

Disambiguating the takeover instead of renaming the id — a different `order`, or claiming the official id only when no other registration is observable — was rejected. The conflict key is `id` plus `priority`, so another order only moves the row in the list and leaves the seat taken; `settings.section` also offers no occupancy arbitration to read before registering, so a plugin cannot prove the seat is free. The collision would simply move to whichever load order and whichever third plugin happened to match the id, and a silent disappearance is exactly the failure mode being fixed.

Keeping the official id and requiring users to disable one of the two plugins was rejected: it turns a composition decision into a support ticket, and the third-party plugin is not ours to change.

Removing this plugin in favour of the official page was rejected for the reasons already recorded in the takeover note: native has no deletion, no batch operations and no retention policy, so the removal is a capability regression.

## Consequences

Two archive plugins enabled at once now show two archive entries — one per plugin — and that is the accepted outcome: each entry carries its own plugin's behaviour, and neither can suppress the other. A single-archive-plugin install is unchanged in count and in position.

The section id is a plugin-owned identifier, so it no longer tracks the official one and needs no coordination when upstream re-mounts or renames its own page.

`packages/dsh-web-all/aggregate.yml` records the same fact in its archive-entry comment, and the package README pair states the id ownership instead of claiming no other archive plugin registers the seat.

## Testing

`pnpm --filter @linxin666/dsh-session-archive exec vitest run tests/section-identity.spec.ts` passes: the registered id is `dsh-session-archive`, the official `archived-sessions` id is not registered, order 25 is kept, the nav copy resolves, and one registration is taken per mount and released on unmount. `tests/section-identity.spec.ts` also mounts beside a foreign `archived-sessions` registration at the default priority and asserts both entries exist, using a fake registry that refuses a duplicate `id` and `priority` pair the way the shell does, plus a guard case proving another `order` does not avoid that refusal.

Package `test`, `typecheck` and `build` pass, and `node scripts/aggregate.mjs --check` reports no drift. A live GUI round with both archive plugins enabled on one profile is not covered by this change and remains open for QA.
