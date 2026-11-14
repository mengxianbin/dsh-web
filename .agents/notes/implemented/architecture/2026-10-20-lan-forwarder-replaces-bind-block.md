# Agent Note: LAN reachability is a runtime forwarder, not a managed webserver-row block

Status: implemented

Supersedes in part [remote control reuses the official UI](2026-08-29-remote-control-reuses-official-ui.md) (its LAN-bind bullet), [the LAN-bind block asks the installed host which bind addresses it accepts](../bug-fix/2026-10-17-remote-web-ui-wildcard-bind-capability.md), and the profile-writer rounds of [issues 1389/1390/1381](../bug-fix/2026-09-06-issues-1389-1390-1381-fixes.md) and [issues 1743/1751](../bug-fix/2026-09-29-open-issues-resolution-1743-1751.md): the block those notes fixed no longer exists. [The forwarding-header fence](../bug-fix/2026-10-19-reverse-proxy-loopback-fence.md) owns the classification rule the forwarder relies on.

## Problem

The LAN access toggle shipped as a managed block in the profile `cordis.patch.yml`: `writeLanBind` rewrote a `- id: webserver` item between two marker comments and replaced that row's whole config with a static literal. Three properties of that arrangement were load-bearing, and each one is a defect in the architecture it produced:

- The row the block wrote is the row the harness takes its bind from. Same-id patch rows replace a row's config wholesale, so the official `host: !!js ctx.webStartup.host ?? '127.0.0.1'` expression was replaced and `--host`/`--port` stopped reaching the server; the literal the plugin had guessed became the bind.
- The profile patch is watched by the Host, so the write recomposed the running process and rebound a live listener. A literal the installed webserver schema refuses is a startup brick this plugin cannot repair, because it mounts only after the webserver that refuses to start.
- Reachability lived in a file's bytes: a network change needed a profile edit and a restart, and the card could only report `pendingRestart`.

Issue #1917 reports the outcome: an explicit `--host` stopped working on a profile the toggle had touched, and the toggle was the one thing in the package that wrote a file it did not own.

## Decision

LAN reachability is runtime state of this process. The plugin owns no bind: the profile's `- id: webserver` row belongs to the official bundle and is never written, `--host`/`--port` reach it, and the host keeps listening on `127.0.0.1`. Reachability comes from a forwarder (`packages/dsh-remote-web-ui/src/lan-forward.ts`):

- It listens on this machine's first LAN IPv4 address, at the web server's actual port, and re-issues every request to `127.0.0.1` on that same port — HTTP and WebSocket upgrades alike, each leg rebuilding its own hop-by-hop headers.
- It owns the request's Host and forwarding headers: a client-supplied value is discarded, never appended to, and the forwarder stamps the LAN authority it was reached at plus `X-Forwarded-For` and `x-forwarded-proto`. The upstream leg therefore arrives as a forwarded request, so every fence that decides "is this the desktop" keeps refusing it while the phone-facing fences match the LAN authority the QR link advertises.
- The plan (`forwardPlanOf`) only ever returns a concrete interface address, because the wildcard would collide with the loopback listener on the same port. Toggle off is `off`; an operator who pointed `--host` at the network is `host-bind` and the forwarder yields the port; a machine with no LAN IPv4 address is `no-address` and the card says so.
- A bind that cannot be taken (the address went away after a network change, the port is taken) costs the LAN edge only: the loopback listener is never touched, the failure is logged and reported, and the host cannot be bricked.
- The legacy block a version up to 0.4.8 wrote is removed once per process at activation (`removeManagedBlock`): an atomic temp-file replacement with the file's mode preserved, only when the markers are actually there, and nothing written back. A failed removal is reported loudly, because a surviving block keeps replacing the bind on every later start.
- The status frame carries `forward { listening, host, port, reason, error }`, `localBindHost` beside the reachable `bindHost`, `legacyBlockRemoved`, and `pendingRestart: false` — the field stays for the card's existing readers, and `lanBind` is schema-volatile, so the toggle now binds the next request rather than the next start.
- Every reachability consumer follows the forwarder: `lanEdgeHost` and `applyLanBases` publish the forwarder's address as the pairing service's LAN bases, so the QR links and the phone-facing fences keep matching what a LAN client dials.

## The boundary this creates

One consequence is a boundary rather than a defect: with the web server bound to `127.0.0.1`, the harness's `/api` Host fence answers a LAN authority with 403, so a LAN browser no longer reaches the native `/api` surface — the client moves its transport onto this plugin's paired `/remote` gateway instead. Restoring native `/api` over a LAN authority needs the harness web server's `trustedHosts`, which is outside this repository; an operator who binds the host to the network themselves with `--host` gets that surface under the harness fence alone. The package README states this instead of implying that the LAN toggle is a general-purpose API exposure.

## Alternatives considered

Keeping the block and only making it safer (the 0.4.5 to 0.4.8 hardening rounds) was rejected: the premise that a file can own a live listener is the defect, so every fix kept `--host` dead and every toggle restart-bound.

Keeping the block only on hosts that refuse wildcard binds, i.e. writing a concrete LAN IPv4 literal, was rejected: that is what shipped before this note, and it still bricked a machine whose address changed while the file kept the old literal, and still swallowed the CLI flags.

Making the host itself bind `0.0.0.0` and dropping profile writes was rejected: the installed webserver schema refuses the wildcard ([the capability note](../bug-fix/2026-10-17-remote-web-ui-wildcard-bind-capability.md)), and a network-wide bind additionally makes the harness `/api` fence auto-trust LAN literals, a posture this package deliberately avoids.

Documenting an external `socat` or reverse-proxy step instead of shipping a forwarder was rejected: an operator step no test covers, broken by every address change, and invisible to the status frame the card renders.

Running a second web-server instance for the LAN address was rejected: two listeners competing for one port is exactly what the forwarder exists to avoid, and the web server owns exactly one.

Reusing the package's existing loopback proxy (`loopback-proxy.ts`) for the LAN leg was rejected: that path exists to re-issue the desktop's own `/remote` traffic with the process credential, while the LAN edge must stay unauthenticated by design and must rewrite the headers that would otherwise make a network request look local.

## Consequences

- `--host`/`--port` regain their ordinary meaning, and no code path in this package writes a profile file except to delete the block an older version left behind.
- A network change needs neither a profile edit nor a restart: the interface list is re-sampled on each reconcile, so flipping the toggle is enough.
- A failed bind is a reported LAN outage carrying a reason on the status frame, not a dead host.
- A machine that still carries a legacy `0.0.0.0` block needs one manual edit, because the host refuses that value before this plugin loads and the cleanup therefore never runs there. Every other legacy block is removed automatically, and the README keeps the manual instruction for that one shape.
- The native `/api` surface is no longer reachable from a LAN authority, so a LAN browser rides `/remote`; the boundary above and the README security model state it.
- The forwarder is now security-relevant code: it must keep discarding the client's Host and forwarding headers, and `packages/dsh-remote-web-ui/AGENTS.md` carries that rule together with the requirement that a change to it moves the bilingual README and the package tests.

## Testing

- `packages/dsh-remote-web-ui/tests/lan-forward.spec.ts` (11 tests) pins the shape end to end: a forged loopback Host is replaced by the LAN authority so the request is not the desktop, a client cannot smuggle its own forwarding headers through, the LAN listener shares the web server port on a different address, an occupied port and a vanished address are reported while the loopback listener keeps serving, a WebSocket upgrade arrives with the LAN authority stamped, a dispose releases the port, and starting the same target twice keeps one listener.
- `tests/lan-bind.spec.ts` (15), `tests/lan-bind-plan.spec.ts` (12), `tests/lan-bind-status.spec.ts` (10) and `tests/lan-bind-status.spec.tsx` (10) pin the plan reasons (`off`, `host-bind`, `no-address`), the status frame fields (`forward`, `localBindHost`, `legacyBlockRemoved`, `pendingRestart`), the one-shot atomic legacy cleanup, and the card's rendering of those states.
- `tests/port-unbound.spec.ts` (8 tests) covers the LAN edge that never writes a bind: no code path writes the web server row, the legacy cleanup runs before the LAN edge and the firewall, a bind that cannot be taken is reported rather than thrown, the CLI `--host` is honoured by yielding instead of rewriting, and a machine with no LAN address is told rather than skipped. `tests/lan-bind-hmr-nesting.spec.ts` (4 tests) keeps that work off the settings transaction and touches the profile at most once per process, only to remove.
- Repository gates: `node scripts/verify-docs.mjs`, `pnpm emoji:check`, `pnpm i18n:check`, `pnpm test:scripts` and `pnpm test:standards` are green with the change, and the specs above are the affected lanes of `pnpm -r test`. The GUI round (forwarder listening on the LAN address, a phone pairing from it) is the manual E2E in the package README.
