# Agent Note: A named tunnel's ingress port follows the bound port, update-only

Status: implemented

## Problem

A named tunnel is the mode this plugin offers for an operator's own domain: the public hostname is permanent, so a paired phone keeps its bookmark and its pairing cookie across `dsh web` restarts (the fence consequences of that are owned by [the tunnel reconnect trust note](../bug-fix/2026-09-13-remote-web-ui-tunnel-reconnect-trust.md)). The hostname is fixed; its ingress rule is not. The rule names `http://127.0.0.1:3080`, and a later `dsh web` may listen elsewhere — an operator `--port`, another profile, a second instance taking the old port. Cloudflare then answers 502 for a hostname this plugin still reports as published, and nothing in the package could see it: the plugin owns the connector, the dashboard owns the ingress, and a manual edit is easy to forget because no UI changes when the port does (issue #1948).

The opposite failure mode is worse than the 502. A plugin that "fixes" the document by rewriting it wholesale can drop a rule, reorder the ingress, or replace a catch-all — an outage on a hostname another service also uses, caused by a diagnostic feature.

## Decision

`ingressSync` (default off) is the only write path this package has into a tunnel configuration, and it is update-only by construction. `src/ingress-sync.ts` owns a pure planner and a single-flight runner: read the document, prove a plan, write only a proven drift, read the document back.

The plan (`planIngressUpdate`) has exactly three outcomes:

- **unchanged** — the matched rule's service already names the bound port. No write, and no document is even offered to the caller.
- **apply** — one full document that differs from the read one at exactly one place: the `service` string of the rule whose hostname equals the configured host. The proof is mechanical (`withoutTargetService` strips that one key from both documents and compares the canonical JSON), so the invariant is a test assertion rather than a comment. That service must also belong to this machine: its host has to be a loopback literal (any 127.0.0.0/8 address whose four dotted segments are real 0-255 octets — so `127.9.9.9` passes and `127.999.999.999` does not — `::1`, or `localhost`) or one of the host's own LAN IPv4 addresses (`lanIPv4Addresses()`, read per run). A neighbour's address, another network's address, or a DNS name such as `dsh-nas` is a conflict, because that port serves whatever that address is and retargeting it would break a service this plugin does not own.
- **conflict** — no document at all. Missing `ingress`, an `ingress` that is not an array, a rule that is not an object, any wildcard hostname, a missing or duplicated target hostname, a last rule that carries a hostname (no catch-all), a service that is not an http(s) origin, or a service hosted anywhere but on this machine.

Discovery is explicit rather than derived: `cfApiToken` (a settings secret), `cfAccountId`, and `cfTunnelId` are three separate fields. The named-tunnel run token (`tunnelToken`) is never parsed for them — its internal format is not a contract this package owns, and doing it in the browser half would put an account id into page state.

Convergence is a state machine (`off`, `waiting`, `applied`, `failed`, `conflict`) with three properties the rest of the plugin depends on:

- **The bound port is the only target fact, and it has to be a real one.** Before `ctx.webServer.port` exists the runner makes no request at all and reports `waiting`; a half-read webServer that hands over `NaN` or `Infinity` is normalized to "no port" rather than becoming a conflict about our own configuration. The plugin's existing port-settle re-plan (the one that starts the quick tunnel) delivers the port a second later. There is no second retry loop of its own.
- **Single-flight with a generation guard.** Every schedule bumps a generation, and every branch that ends up without a target — the master switch off, no hostname, no finite bound port, missing settings — invalidates the in-flight run through one `invalidate()` path, so a run superseded by any of them cannot write, settle, or report an applied frame. The run checks the generation before every request attempt — so a retry scheduled by a 429/5xx/network backoff cannot outlive its target — and again immediately before its only write. A settings save or a port settle that lands mid-flight discards the stale target instead of writing it, and a discarded request publishes nothing (the queued run reports). A short debounce (300 ms) coalesces the burst a save produces. The identity a converged target is recorded under includes a truncated SHA-256 digest of the API token, never the token: rotating the credential re-reads the document, and the same credential does not.
- **Bounded, honest failure.** 401/403 and any other non-429 4xx are terminal (`failed`). 429/5xx/network are retried at most twice; past that the frame reports the last status. A conflict never retries by itself.

The write is a full-document PUT because the API has no single-rule patch, and it is followed by exactly one read. A read-back that disagrees is a `conflict` (`verify-mismatch`) and is never rewritten: one tunnel document has one writer, and a concurrent writer (the dashboard, another machine running the same sync) has to be reconciled by a human rather than fought by a loop. The quick tunnel is never a target: `autoTunnel` mints a new hostname per start and owns the public base, so the sync reads as `off` there instead of editing an unrelated tunnel.

The frame rides `PairingSnapshot.ingress` (so `/api/pair/status` carries it to a desktop or a paired device and never to an unpaired tunnel visitor) and the settings card renders it beside the switch. It carries the public hostname, the bound port, the two service strings, the rule position and a reason. Those service strings are redacted of userinfo: a tunnel service may carry `user:password@` for a protected origin, the write preserves it byte for byte, and no audit field shows it. The frame never carries the credential, and the default transport itself refuses to build a request to any origin other than `https://api.cloudflare.com`, so the token cannot reach another host even if a caller assembles such a URL.

## Testing

`tests/ingress-sync.spec.ts` (53 cases, no network) pins both layers:

- the pure plan: the one-difference invariant, the untouched rule/catch-all/top-level key, the unchanged verdict, every conflict shape with its code and the absence of a document, the loopback/own-LAN host allowlist (including `192.168.1.5` and `dsh-nas` as refusals), and userinfo redaction in the audit strings while the write preserves them;
- the runner: zero requests while off, unconfigured, hostname-less, port-less, or holding a non-finite port; one read when nothing drifted; GET/PUT/GET on a drift with the exact PUT body; 401/403 terminal at one call; 429 and network bounded at three attempts; a rejected write as conflict; a disagreeing read-back as conflict with no second write; a converged target not re-read until the credential changes; a failed target retried on the next schedule; a stale generation dropped before its only write and dropped again during a pending 429 backoff (so the stale port never PUTs, only the queued target does, and the interrupted 429 is never published as a failure either); a target cleared mid-flight — token or hostname — invalidating the in-flight run so it neither writes nor reports applied, with the terminal frame being the cleared configuration; the live-port normalizer turning `NaN`/`Infinity` into "no port" so the caller reaches the settle retry; a pending backoff wait released on dispose with no further request; and the token appearing only in the `Authorization` header, in no frame, and in no audit field.

`tests/routes.spec.ts` pins the `/api/pair/status` split: an unpaired non-loopback caller gets no `ingress` (and no `service`/`hostname`) while a live device reads the frame. `tests/pairing.spec.ts` pins the frame in the snapshot without repeat emits, and `tests/settings-surface.spec.ts` pins the four volatile card fields plus the token's secret role.

## Alternatives considered

**Let the dashboard own it and document the manual step.** Rejected: the manual step is exactly what fails silently. Nothing in the UI changes when the port does, and the operator only learns about it from a 502 on a hostname the plugin still advertises.

**Run the connector with a local ingress file (`cloudflared tunnel --config`) instead of the remotely managed configuration.** Rejected: it needs the tunnel's locally-run credentials (not the dashboard token) and forks the source of truth — a deployment managing its route set in the dashboard would silently lose every later dashboard change.

**Patch only the changed rule.** The Cloudflare API offers no single-rule patch: the only writable representation is the whole configuration document. That is why the plan has to prove the rest of the document rather than assume it.

**Retry the write until the read-back agrees.** Rejected: with two writers (a dashboard tab open) that loop fights a human and can oscillate, and it would make a conflict look like a transient error.

**Derive the account and tunnel ids from the tunnel token.** Rejected: the token's internal format is Cloudflare's to change, the decode would have to happen somewhere, and the natural somewhere is the browser half — putting an account id into page state for a value the operator can copy from the dashboard once.

## Consequences

- The plugin can now report, per tunnel, whether the published hostname actually reaches this host's port, with a reason when it does not — the frame is the audit trail that the 502 previously lacked.
- A conflict is a stop, not a retry: a deployment with the dashboard open and the sync on will see `verify-mismatch` until one side is closed. That is the intended trade — the alternative is silent clobbering.
- The account token is a second credential in this package. Its blast radius is the Tunnel:Edit permission the operator grants; it is stored as a settings secret, sent only to the Cloudflare API, and never logged or rendered.
- **Coverage gap, deliberately named**: this shipped without a live Cloudflare acceptance. Every path is covered by offline tests through the injected fetch seam, and the release notes/issue state that #1948 must not be closed on that evidence alone.
- Residual risk: the API has no conditional write, so a writer that lands between the read and the PUT is only detectable afterwards (as `verify-mismatch`), never prevented.
