# Agent Note: MiMo Re-login Kit

Status: implemented

## Problem

The dsh-usage MiMo balance probe carries a platform SSO cookie (`MIMO_PLATFORM_COOKIE`) that expires silently: the 2026-10-25 expiry froze the sidebar figure at ¥36.87 for 27 hours (the stale-fact TTL, filed as [usage-stale-fact-ttl](../../bug-fix/2026-10-27-usage-stale-fact-ttl.md), now degrades such figures instead). Recovery was entirely manual — log in somewhere, copy a Cookie header out of DevTools, edit an environment variable, restart dsh — and the "which browser profile" friction hid the real gap: no path existed for a cookie to travel from a browser back into the credential store. The TTL fixes the lie; this kit fixes the recovery.

## Decision

A new link-only host plugin, `packages/dsh-mimo-relogin`, mounts six loopback-fenced routes around one page (`GET /api/mimo-relogin/page`):

- **Silent renewal** replays the platform's own ticket chain headlessly — `genLoginUrl` → `account.xiaomi.com/pass/serviceLogin` → platform `/sts` — rotating `api-platform_serviceToken` from stored account cookies. Proven live 2026-10-27: the chain completes with no form while the account `passToken` (30 days) lives, and settles on the credential form (`verdict: interactive`, HTTP 409) once it does not. Manual re-login is thereby capped at roughly one per `passToken` lifetime, and the renewal itself never needs a browser.
- **Capture** reads both cookie jars from the chrome-debug instance (port 9224) over CDP — the browser half of the same flow the 2026-10-27 probe demonstrated end to end.
- **Open window** attaches to a running debug window or launches the dedicated debug Chrome (config `chromePath`/`chromeProfile`, defaults follow the chrome-debug convention).
- **Paste** is the manual floor for both credentials.

Every write path is fail-closed: the platform half must answer `GET /api/v1/balance` with the candidate value before `credentials.set` runs; the account half's proof is the renewal that consumes it. Two managed references carry the state — `MIMO_PLATFORM_COOKIE` (probe fuel, consumed by the dsh-usage MiMo adapter) and `MIMO_ACCOUNT_COOKIES` (renewal fuel, contains the account SSO root `passToken`) — both in the provider-managed store, which outranks the environment layer, so updates land within one probe cycle without a restart. After each successful store the kit pokes dsh-usage's `/api/dsh-usage/refresh` so the sidebar shows the new figure within seconds.

## Alternatives considered

- **Deepseek-style OAuth window (authorize → code → exchange)**: rejected as infeasible — the platform's `serviceLogin` callback is signature-bound to its own `/sts`; there is no third-party client registration, so no code can be exchanged by anything but the platform itself.
- **Bounce-only page (open the login URL and stop)**: rejected as a dead end — logging in somewhere does not transport the cookie back; the whole problem is transport.
- **Standalone paste page as the product (the earlier "B plan")**: kept only as the paste fallback; with capture and headless renewal working, a paste-only product would ship the manual floor as the ceiling.
- **Writing the environment variable**: rejected — process env needs a restart and lives outside the credential seam; the managed store wins over env and hot-publishes.

## Consequences

- Renewal depends on the platform's internal `genLoginUrl`/`serviceLogin`/`/sts` shapes; a platform change surfaces as `verdict: failed` plus a hop list on the page rather than silent breakage, but it does mean the kit can break without a harness release.
- `MIMO_ACCOUNT_COOKIES` is an SSO root (30-day `passToken`) stored in plaintext credentials like everything in that store; the README states the care requirement.
- The debug profile default hardcodes this machine's chrome-debug path (`D:\tech\m-note\.local\chrome-profile`); other machines override `chromeProfile`.
- The kit mounts through `cordis.patch.yml` insert (id `mimo-relogin`), profile link-only, no npm release — same shape as dsh-session-dispatch.

## Testing

`tests/relogin.spec.ts` (10 cases) covers the loopback fence, the renewal chain replayed against the observed 302/307 sequence (token rotation asserted, ticket params asserted absent from hops), the interactive-form fallback storing nothing, capture's fail-closed probe gate (both the unproven jar and the never-signed-in window), paste slot/newline validation, and the opener's mode reporting — all seams injected (fetch, jars, liveness, opener). Typecheck, build, docs:check, i18n:check and aggregate:check gate the package.
