# Agent Note: dual-cohort client compatibility repair (store engine, injected faces)

Status: implemented

## Problem

The store-engine portion is superseded by [direct supported-platform resolution](../simplification/2026-10-11-retire-legacy-store-engine-shim.md). All engine-specific statements below, including the decision, consequences and verification, are historical; this note continues to own the independent agent-preset provider/declaration/injection decision.

After the 0.1.2-alpha.1 preview cohort migration landed on `dev`, the live GUI refused to load the family plugins on the running 0.1.1-rc.2 host (the newest npm-published release; the preview cohort returns 404 and cannot be installed). Two hard couplings to the new cohort surfaced, one after the other:

1. **The store engine require missed the module table.** The migration made `dsh-client-store` a frozen platform module and the shared client preset externalized it, so every rebuilt client bundle hard-required it at bundle evaluation:

   ```
   failed to import loader entry 47c06ebb (@linxin666/dsh-client-ui-web-ui-settings):
   client-modules: require("@deepseek-ai/dsh-client-store") missed the module table —
   not a platform seed word, not a materialized module, and no registered package factory
   ```

   The engine contract is identical across cohorts: rc.2's `@deepseek-ai/dsh-client-runtime/client` exports the same `createSnapshotStore` / `defineStore` / `shallowEqual` (literally the same `contract/store.ts` rehomed into `dsh-client-store` upstream), and rc.2 materializes it as the `dsh-client-runtime` inject module's `./client` face — the specifier the former RUNTIME_STORE_EXEMPTION served.

2. **The task-board entry pended forever on a 0.1.2-only injected service.** The Typert-gateway migration added `'remote.agentPresets'` to the client entry's hard `inject` list; the service only registers on 0.1.2 hosts (the api-remotes contribution), so on rc.2 the entry stayed `pending (waiting for service: remote.agentPresets)` and the boot reported one entry that did not activate. The roster itself has a working rc.2 source: pre-migration code read it through `connection.api.agentPresets.list({})`.

## Decision

Keep one client artifact per package for both host cohorts, resolving cohort-owned surfaces at runtime inside the shared seams:

- **Store engine (shared/tsdown.client.ts):** value imports of `@deepseek-ai/dsh-client-store` are no longer external. The bundle purity plugin redirects them to a generated shim module that resolves the engine through the loader's injected `require` at bundle evaluation: the platform module first, the legacy `@deepseek-ai/dsh-client-runtime/client` face second. The shim's specifiers are built with `join('')` so the static resolver cannot see them and the require calls are emitted verbatim into the factory scope. The shim forwards exactly the value surface both engines share — `notifySubscribers` exists only in the cohort package and must never be re-exported; a future value import of it fails the build with a missing-export error instead of silently breaking rc.2. Type-only imports are untouched: they are erased before bundling and keep importing the published 0.1.2 declarations.
- **Injected faces (task-board client):** `remote.agentPresets` left the hard `inject` list (every other entry's services register on rc.2). The preset roster is read at use time through whichever face the running host serves, never through a hard wait, so the mode picker keeps its presets without pending the entry on a host that serves none. The pre-migration face this bullet originally named, `connection.api.agentPresets`, is gone from the supported cohort: from 0.2.0-rc.2 on the connection handle carries only the wire (`isLoopback`, `generation`, `state`, `rpc`, `reconnect`, `registerGenerationSource`, `start`), so the roster is reached through the generated `remote.agentPresets` namespace inside a scoped `ctx.inject`, which runs the feed the moment the api-remotes assembly mounts the namespace and re-runs it when a reconnect may have switched deployments. A failed read keeps the previous options and the next reconnect retries, as before. Reading that namespace off the `remote` service without the inject throws (`cannot get property … without inject`) because the assembly applies beside this entry rather than before it, so a one-shot probe at mount time leaves the picker with nothing but "inherit" for the page lifetime.

Related: [preview SDK cohort via source-built tarball overrides](../../archived/process/2026-08-28-preview-cohort-tarball-overrides.md) (the migration that introduced the duality).

## Alternatives considered

- **Keep the hard coupling and require a host upgrade**: rejected — the 0.1.2-alpha.1 cohort is an unpublished preview, so the running rc.2 host cannot be upgraded to it; the family would stay broken in the only installable environment.
- **Revert `dev` to the rc.2 cohort**: rejected — undoes the deliberate migration; the sources already import the 0.1.2 faces.
- **Per-consumer try/catch requires in each package source** (store engine): rejected — duplicates the compat logic across nine packages and pollutes client sources; the preset is the single build-time seam every bundle already shares.
- **Build-time cohort selection (per-host artifacts)**: rejected — one binary artifact per host cohort reintroduces stateful builds and guarantees the next drift.
- **Drop the preset roster below the 0.1.2 cohort** (task-board): rejected — the rc.2 connection face serves the same roster, so a feature-less picker would be a self-inflicted regression.
- **Wait for the service softly instead of removing it from the inject list**: rejected — an inject wait either blocks activation (hard) or cannot express "continue without it" (cordis inject has no optional flag here); probing at use time is the same mechanism the bridge-fallback compat binder already uses.

## Consequences

- rc.2 hosts import the family client bundles again and task-board activates; 0.1.2-alpha.1 hosts keep the platform-module and injected-face paths unchanged.
- The `engines.dsh >=0.1.2-alpha.1` floors and the README DSH badge now overstate the client-half requirement (the repair tolerates rc.2), while the host halves still use the 0.1.2 faces. Lowering the declared floor back to rc.2 is a maintainer cohort-policy decision and was not made here.
- The inject contract's `dsh-client-store` row stays correct for 0.1.2 hosts; on rc.2 the host has no such package to inject and the shim's fallback carries the load instead.
- New value imports of cohort-only store exports fail the build visibly (missing export). New cohort-only injected faces must follow the task-board pattern — a scoped `ctx.inject` at use time — or the entry pends on a host that never serves them; reading the same namespace through the parent service without that inject throws instead of answering undefined, so a bare probe is never a substitute.

## Verification

- Rebuilt every workspace client bundle: zero hard `require("@deepseek-ai/dsh-client-store")` remain; the shim appears in exactly the nine bundles that value-import the store (desktop-launcher, doctor, market, perf, pet, remote-web-ui, task-board, tool-describe-image, web-ui-settings).
- The live rc.2 host serves the fixed bundles (fetched `http://127.0.0.1:3080/plugins/…` for web-ui-settings and task-board, both HTTP 200): the dual require fallback is present, and the task-board bundle's `inject` array does not contain `remote.agentPresets` while the roster feed reads it inside a scoped `ctx.inject`.
- Against a scratch 0.2.0-rc.2 host carrying this bundle, the board's mode picker lists the deployment roster (继承（部署默认：标准）, 标准, PTC, 极简, Cordis); pinning a preset in the create dialog stores it on the card, editing it in the card's execution settings survives a page reload, and the boot console reports no roster failure. The same probe on the unfixed bundle reproduced the shipped defect: `remote.agentPresets` threw `cannot get property "remote.agentPresets" without inject`, the connection handle offered no `api` fallback, and the picker listed only 继承（部署默认）.
- The rc.2 host tree's `dsh-client-runtime/lib/client.js` verified to export `createSnapshotStore` and `defineStore` (the engine fallback answers).
- `pnpm typecheck`, `pnpm test` (19 suites), `pnpm test:scripts` (226 pass), `pnpm docs:check`, `pnpm aggregate:check`, `pnpm market:check`, `pnpm skin-center:check` all pass; dsh-task-board re-verified after its change (tsc clean, 241 tests passed).
