# Agent Note: The remote bridge mounts as a family aggregate row

Status: implemented

## Problem

`@linxin666/dsh-remote-bridge` shipped as an independently installed plugin: its own `cordis.patch.yml` inserted row `remote-bridge`, and nothing in `packages/dsh-web-all/aggregate.yml` mentioned it. Installing the family bundle therefore left the bridge out, while the bridge README already said the bundle installs it — a promise about a row that did not exist. The two channels also have to work at the same time: a profile may carry the aggregate row and a standalone row for the same npm package, and each source registers the same process-wide surface, the `/ios/v1` upgrade route and the `/remote-bridge/pair/token` route. The protocol surface itself is owned elsewhere — [the bridge protocol note](2026-10-16-remote-bridge-protocol-v1.md) — and the row mechanism by [the fault-isolation shell note](2026-09-01-aggregate-plugin-fault-isolation-shell.md); this note owns how the bridge is installed.

## Decision

The bridge is a family member. `packages/dsh-web-all/aggregate.yml` lists `../dsh-remote-bridge` in `patchFrom` and in `deps`, so the generator emits insert row `web-ui-remote-bridge` with `name: '@linxin666/dsh-web-all/remote-bridge'` and `config.plugin: '@linxin666/dsh-remote-bridge'`, writes the `workspace:*` dependency, and maintains the `./remote-bridge` subpath exports (`icon`, `locale/{en,ru,zh}.json`) with a `shellNotes` description. The row sits after the remote-access pair (`remote-web-ui`, `update`) because the bridge is the family's second remote surface, yet it injects only official services — `typertGateway` and `webServer` on the host, `dsh-client-locale`, `dsh-client-ui-renderer` and `dsh-client-ui-sidebar` in the browser — so it owes no family row a seat and does not displace the adjacency `update` keeps to `remote-web-ui`. No `familyIds` override is needed: the derived row id `web-ui-remote-bridge` and subpath `remote-bridge` collide with neither the official row roster nor the standalone row id.

The host half is wrapped in the family's guard, `mountOnce('@linxin666/dsh-remote-bridge', applyImpl)`, from `packages/dsh-remote-bridge/src/mount-once.ts` (a `sync-shared` copy of `shared/host/mount-once.ts`). Without it the second source would register the same upgrade route and the same token route a second time on one host. With it the first mount owns the package name, a second mount is queued instead of dropped, and the queue is replayed when the owner disposes — the reload case (new loader entries mounting before the old ones are torn down) where dropping the refused mount would lose the plugin until the next host start.

The standalone channel stays open. The package keeps its own `cordis.patch.yml` with row id `remote-bridge`, keeps `dsh.bundle.patch`, and stays in the npm release flow, so `dsh plugin --profile <name> add @linxin666/dsh-remote-bridge` mounts it without the bundle and follows this package's own version rather than the bundle's. Both channels load the same npm package, which is what makes the guard's package-name key work.

The local desktop profile drops its standalone `link:` entry and its `dsh.profile.bundles` row for the bridge, so this machine has one install source again; the bundle row supplies the same halves.

## Alternatives considered

- **Correct the README and leave the package standalone.** Rejected: the sentence would then say the bundle does not carry the bridge, which is true but leaves the whole-bundle install incomplete for the family's second remote surface — the operator who installed the bundle would still have to know about a second package.
- **Add the bridge to the aggregate's `dependencies` while mounting it only through its own patch row.** Rejected: the aggregate's dependency list is the only entry point the generator maintains, and a package depended on but never inserted is exactly the state this change removes — the bundle would install the code and mount nothing. It also leaves the profile responsible for a row the bundle claims to own.
- **Ship the family row without the single-instance guard.** Rejected on the shipped failure shape: with both rows live, the second mount re-registers `/ios/v1` and `/remote-bridge/pair/token`, which the host web server reports as duplicate registration and which leaves two roster owners for one process. The guard is the family convention for exactly this pairing (`packages/AGENTS.md`), and every other family package already carries it.

## Consequences

- The bundle now owes the bridge's browser half a rebuild whenever it changes, because the aggregate inlines repository-internal client sources; `pnpm build` plus `pnpm libs:write` refresh `packages/dsh-web-all/lib`.
- A profile carrying both the aggregate row and a standalone link keeps working, but the two rows are one plugin: the second one is a no-op until the first disposes, so enabling both buys nothing beyond a slower row list.
- The package carries its own display metadata, and that is what a row mounting the bare package name renders: `icon.svg` (a byte copy of the family asset, so every family card shows one whale) and `locale/{en,ru,zh}.json` carrying `meta.title` and `meta.description`, both inside the `files` whitelist so the npm tarball ships them. The `locale` keys are load-bearing rather than cosmetic: the host reader resolves each language through the package's export map, so a `locale/` directory without matching `exports` entries is silently ignored and the row falls back to the package name and the npm description. The aggregate's `shell-metadata` tree stays the display source for the `web-ui-*` compat subpaths only; copying the bridge's text there would give one plugin two disagreeing display sources.

## Testing

`packages/dsh-remote-bridge/tests/plugin.spec.ts` mounts the plugin twice on the fake host the suite already uses: the second mount registers neither route, and disposing the first mount replays the queued one, which then registers both. Both cases fail against an unwrapped `apply` and pass with the guard. `node scripts/aggregate.mjs --check` pins the generated rows, the dependency and the shell metadata.
