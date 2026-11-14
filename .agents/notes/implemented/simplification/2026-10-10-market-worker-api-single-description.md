# Agent Note: Give the market worker's public API one description authority

Status: implemented

## Problem

The market worker's HTTP surface is described three times, and the descriptions no longer agree. `market/worker/src/index.js` (599 lines) is the router; `market/worker/src/openapi.js` (205 lines) is the OpenAPI document served at `/openapi.json`; `market/worker/src/api-doc.js` (54 lines) and `market/worker/src/api-catalog.js` (21 lines) are the human page and the RFC 9727 linkset served at `/.well-known/api-catalog`.

Measured against the router, the document already lags. `index.js` handles 17 literal `/api/...` paths; `openapi.js` names 12. Served and undocumented: `/api/install-batch`, `/api/asset-attest`, `/api/relay/register`, `/api/relay/unregister` and `/api/skin-center/v2/skins/`. The catalog and the docs page inherit the same list, so a consumer that reads the published description cannot discover the batch install or the relay registration the site itself uses.

`scripts/market-worker.test.mjs` pins the catalog's shape but not its coverage, which is why the gap survived: nothing fails when a route is added without a description entry.

## Decision

`market/worker/src/api-surface.js` is the description authority: one `API_ROUTES` entry per route, carrying the method, the path, the OpenAPI summary, the OpenAPI operation object, and the curated Chinese prose plus status column of the human page. The table lists 18 routes, including the four the router served while neither document described them: `/api/asset-attest`, `/api/install-batch`, `/api/relay/register` and `/api/relay/unregister`.

`openapi.js` (205 lines to 27) and `api-doc.js` (54 to 56) assemble their output from that table instead of carrying their own lists; the page keeps its chrome and its examples, the served documents keep the shapes the catalog links to, and `api-catalog.js` is unchanged.

`scripts/market-worker.test.mjs` gains one test: it derives the served API paths from the router source (`path ===` and `path.startsWith` literals, excluding the `/api-docs.html` page and mapping the skin-center prefix to its documented shape) and fails when that set and the table disagree in either direction.

## Context & Efficiency Impact

No runtime behavior changes: the routes, their responses and the served documents keep their current content, with the five missing paths added to the description as part of the change. The work deletes a structure rather than a feature: one of the three descriptions stops existing as an independent list.

The maintenance gain is that adding a route no longer requires remembering two other files, and the drift the test cannot currently see becomes impossible.

## Evidence

- Router paths (17 literals) versus document paths (12 literals), read from `market/worker/src/index.js` and `market/worker/src/openapi.js`.
- `market/worker/src/api-catalog.js` links `/openapi.json` and `/api-docs.html` as the service description and documentation, so both are public contract surfaces rather than internal notes.
- `scripts/market-worker.test.mjs` asserts the catalog's linkset shape (its pagination and clamp cases) but contains no assertion that every served path appears in a description.
- The five undocumented routes are live: `/api/install-batch` writes the batch install the market card performs, `/api/relay/register` and `/api/relay/unregister` serve `dsh-remote-web-ui`'s stable-hostname relay, and `/api/asset-attest` is read by `scripts/market-verify-assets.mjs`.
- No Agent Note owns the description files; the notes that touch the worker (`2026-09-02-stable-hostname-relay`, the telemetry notes) record the routes, not the description surface.

## Alternatives considered

- **Keep the three files and add only a coverage test.** Rejected as the primary proposal: it makes the gap fail loudly but leaves three lists to update, and the prose copy in `openapi.js` still has to be edited by hand for every route.
- **Generate the router from the OpenAPI document.** Rejected: each route carries its own D1, Turnstile and caching behaviour, so the router is the source of behaviour and the document is the derivative; generating the former from the latter would invert the ownership.
- **Delete the OpenAPI document and serve only the human page.** Rejected: the document is the machine-readable half of a public surface the homepage links, and the change would remove a capability rather than a duplicate.
- **Leave the drift and document the five missing routes in the page only.** Rejected: the drift is mechanical and recurs with every future route, which is what the single table removes.

## Testing

- `node --test scripts/market-worker.test.mjs` passes 60 tests, including the new coverage test; `pnpm test:scripts` passes 373.
- `/openapi.json` carries 18 paths (14 before) and `/api-docs.html` renders 18 rows.
- `pnpm market:check` reports `market/dist` up to date: the worker serves its documents from `src`, so the committed site build is untouched.

## Risks

- The generated document loses the hand-tuned ordering and examples that `openapi.js` carries today; the per-route description text preserves the prose, but the shape of `/openapi.json` will differ, so a consumer diffing it sees a change even though the API does not change.
- The route table becomes a new single point of failure: a route registered outside it is invisible to the description and to the coverage test, so the test should assert from the router's own registration rather than from a hand-kept list.
- The worker is deployed by `deploy-market.yml`; the change must ship with the site build rather than only with the plugin family, or the published description and the deployed worker disagree for one release.
