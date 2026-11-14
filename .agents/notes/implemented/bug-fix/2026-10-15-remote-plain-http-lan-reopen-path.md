# Agent Note: Plain-HTTP LAN reopens stayed on a path no device credential can answer

Status: implemented

## Problem

A phone paired over a plain-HTTP LAN URL (the default for `lanBind: true`) could not come back to the app. That origin is never a secure context, so the [reopen service worker](2026-08-30-remote-reopen-service-worker.md) never registered there — and the capture script still rewrote the address bar to `/`, the one path the cookieless phone flow cannot satisfy. The next refresh, tab restore, or bookmark opened landed on the harness fallback seat's browser-auth 401 ("dsh web authentication required; reopen the URL printed by dsh web."), while the plugin's own device cookie sat unused in the same browser. Re-pairing was the only way back.

The structural fact behind it: the reopen worker and the bare-root address bar are the same decision. The worker exists to own `/` navigations; where it cannot exist, `/` must not be the address bar.

## Decision

The capture script picks its reopen path from the origin it runs in:

- `window.isSecureContext ? '/' : '/pair-app'` — the secure-context branch is the existing worker-owned canonical root, unchanged; the other branch keeps the plugin-owned landing in the address bar.
- Both targets are bare paths, so the one-time grant still disappears with the rewrite and no device credential enters history, the address bar, or a shared URL. This is what separates the adopted form from the `/pair-app?device=` shape the owning note rejected: no credential, only a path.
- `window.isSecureContext` is read inside the existing `try` block. An engine that never exposed the flag reads as falsy and therefore takes the landing path, which is the safe direction: `/pair-app` always answers (shell or bilingual re-pair page), `/` answers only with a browser-auth cookie the phone does not have.
- The landing it keeps is the same route the QR flow already lands on, so it needs no new surface, no new route, and no new fence: a live pairing cookie serves the patched shell and refreshes `lastSeenAt`, a revoked or cleared one serves `pairingFailurePage`.
- The official shell needs no compatibility pass for this. The harness index document carries `<base href="./">`, so at `/pair-app` relative `api/pair/*` calls and module assets resolve against the same origin root as at `/`, and the SPA reads no `location.pathname` at all.

## Alternatives considered

- **Serve the shell at `/` for any request carrying a live device cookie.** Rejected: `/` is the harness fallback seat, owned by `frontend-static` and gated by `connection.authorizeIndex`. A plugin route there would take the document away from every other consumer of the seat, including loopback desktops and any future harness index behavior, to solve a problem a path in the address bar solves. The blast radius is the whole origin; the fix is two lines.
- **Keep `/` everywhere and give the phone a harness browser-auth cookie.** Rejected on architecture by the owning note, and unchanged here: with that cookie the SPA calls `/api` directly, passes the connection fence, and 停止 stops cutting devices off on a cohort where nothing emits `api/gate`.
- **Extend the reopen worker to a non-secure origin** (register it somewhere else, proxy the origin, ship an https tunnel). Rejected: each adds a moving part to protect a cookie the phone already holds, and the tunnel variant changes the trust story the LAN flow is chosen for.
- **Leave the address bar at `/pair-app?device=<id>` on plain HTTP.** Rejected: a device id is a live session credential, and the whole grant-and-landing design exists to keep it out of URLs.

## Consequences

- A paired plain-HTTP LAN device reloads, restores its tab, or reopens its bookmark at `/pair-app` and gets the app back from the pairing cookie, refreshing its presence on every reopen exactly as the worker refreshes it on https. No re-scan, and the bilingual re-pair page is what a revoked device now meets there.
- The device-gated landing is reachable from a browser history entry for the first time, so its behavior under a cleared cookie is now part of the user-facing surface; `tests/routes.spec.ts` pins it (failure page, no shell, no capture script).
- A secure origin whose browser refuses the worker registration is unchanged and still falls back to the harness gate on `/` — that gap is documented as a known limitation rather than fixed, because a refused registration has no in-page signal the capture script can act on.
- The address bar on plain HTTP differs from https by one path segment. Nothing in the shell reads the path, so this is cosmetic; a reader comparing a screenshot between the two transports should expect it.
- One extra fact now lives in two places by design: this note owns the origin-dependent reopen target, and the package READMEs own it as the user-facing contract.

## Testing

- `tests/app-shell-capture.spec.ts` (new): the injected script runs against fakes for the four globals it touches. Non-secure context keeps `/pair-app`, stores the device id, publishes the host-mode marker, registers no worker, and leaves a query-free path carrying neither the grant nor the device id; a secure context keeps `/` and registers `/pair-app.sw.js` at scope `/`; an engine without the flag resolves to the landing.
- `tests/routes.spec.ts`: the landing refuses a caller without a live pairing (bilingual re-pair page, no official shell, no capture script), so the reopen path stays a credential gate.
- Package suite green; repository `pnpm typecheck`, `pnpm test`, `pnpm test:standards`, `pnpm docs:check`, `pnpm i18n:check` pass.
