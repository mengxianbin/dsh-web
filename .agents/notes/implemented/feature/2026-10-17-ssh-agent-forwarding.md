# Agent Note: Per-host SSH agent forwarding (issue #1851)

Status: implemented

## Problem

dsh-ssh could authenticate with a local ssh-agent, but it could not forward that agent to the remote: every git fetch, rsync or deploy hop on the far side needed its own key material, and the only workarounds (copying a key to the server, or a second agent there) defeat the point of using an agent at all. OpenSSH has had the capability for decades as `ForwardAgent yes` / `ssh -A`, so a host entry that claimed to stand in for the user's `~/.ssh/config` could not express one of its security-relevant directives, and the importer dropped `ForwardAgent` silently — the same failure shape the ProxyCommand work fixed in [the ProxyCommand transport note](2026-09-10-ssh-proxycommand-transport.md).

The capability is dangerous in a way the surrounding connection code is not: it lets the remote host sign with this machine's keys. Any design therefore had to make the trust decision explicit, per host, and had to keep the failure modes loud.

## Decision

`forwardAgent` is an optional boolean on a stored host entry in `~/.dsh/dsh-ssh.json`, off by default, and it is written only when it is `true`: a profile that never opted in keeps exactly the bytes it had, so a downgrade or an older reader never sees a key it does not understand.

### Endpoint resolution order

Forwarding is additive — it never changes how the host authenticates, it only lets the connection broker signatures for the remote side. On connect (`buildConnectConfig`) an enabled host gets `agentForward: true` together with a resolved local endpoint, in this order: the host's configured agent path, then `SSH_AUTH_SOCK`, then `pageant` on Windows. When the host authenticates with agent auth, that path has already been resolved, so forwarding reuses it rather than resolving a second, possibly different, endpoint — the agent the remote signs through is the agent that authenticated the connection. `resolveForwardAgentPath()` exists as its own name so the forwarding path can evolve without touching auth, even though both currently share one resolution.

### Per-session request behavior

ssh2's `agentForward` is negotiated per channel, not per connection, so every exec and every PTY session on an enabled host sends its own `auth-agent-req@openssh.com`. Nothing is requested on a host that did not opt in. Because the request is per channel, a setting that only applied to new connections would look like it worked while every existing channel kept running without it, which is why a PATCH carrying `forwardAgent` drops that host's pooled connection in the same way the other connection fields do (`routes.ts`, alongside host / port / user / auth / proxyJump / proxyCommand).

Address-form ProxyJump hops deliberately carry no `forwardAgent`: an ad-hoc address was never configured by the user, so it must never inherit the target's opt-in. A hop written as a configured alias uses that alias's own entry, which is how a user forwards on a bastion on purpose.

### Failure modes

- No endpoint on this machine, with forwarding enabled: the connect is refused with an actionable error (`agent forwarding is enabled for this host but no ssh-agent endpoint is available: set SSH_AUTH_SOCK, start Pageant on Windows, or configure an agent path`). ssh2's own message for the same situation names neither the host nor a way out, and a silently non-forwarding session is exactly what the user cannot see is broken.
- A server with `AllowAgentForwarding no` refuses the request; ssh2 errors or closes that session, and the plugin surfaces that error as it comes back. There is no downgrade to a non-forwarded session, because a session that quietly lost its agent fails later, somewhere else, with a confusing authentication error.

### Import and agent surface

The `~/.ssh/config` importer maps `ForwardAgent yes|true|on` to enabled and `no|false|off` — or no directive at all — to disabled; an unrecognized value leaves it off rather than failing the import, because an unknown keyword must never cost the user the whole Host block. `ssh_list` reports `forwardAgent` on every host and renders a `forward` column (`yes` / `-`) in its table: forwarding is a security-relevant opt-in, so the model sees it in the table and not only in the JSON payload.

## Alternatives considered

- A single global switch for the whole plugin. Rejected: the trust boundary is a host, not the plugin — a user forwards to their own build box and never to a shared bastion, and one global flag forces exactly the wrong choice on one of them.
- Always-on forwarding (what many interactive ssh wrappers do). Rejected on the security model alone: it silently grants every configured host the right to sign as this machine.
- Probing agent availability eagerly, at store-write or panel-load time, to disable the checkbox on a machine without an agent. Rejected: the endpoint can appear or disappear between the probe and the connect (an agent started later, a forwarder that dies), so the probe would report a fact that has already expired; resolving at connect time is the only place the answer is true, and it is also where the failure has to be raised anyway.
- Storing the flag always, as `forwardAgent: false`, to keep the shape uniform. Rejected: it rewrites every existing profile file on the first unrelated save and makes "the user turned it off" indistinguishable from "this entry predates the field".
- Resolving the endpoint once per pooled connection instead of per connect. Rejected: it is the same thing in disguise (ssh2 fixes the agent at connect), but it hides that a toggle only takes effect after the pool drops the connection — which the PATCH path now does explicitly instead of leaving to the idle sweep.
- Downgrading to a non-forwarded session when the server refuses the request. Rejected: it converts a hard, immediate, explainable failure into a later authentication failure on the far side with no trace of the cause.

## Consequences

- A host that opts in inherits the whole trust surface of the local agent for the lifetime of the connection: every session on that host can sign with every key the agent holds. The README security section states this in the user-facing wording, and `packages/dsh-ssh/AGENTS.md` carries the maintainer-side rule.
- Toggling the flag costs a reconnect for that alias, and tunnels on it are dropped with the rest of the pool.
- The importer now honors `ForwardAgent`, so an imported host can arrive with forwarding already on. That is the user's own `~/.ssh/config` talking, but it means an import is a security-relevant operation and the hosts list shows the badge immediately afterwards.
- A Windows machine without Pageant running resolves the endpoint to `pageant` anyway (the string is the endpoint, not a liveness check), so the failure surfaces at the agent handshake rather than at resolution. This matches ssh-agent authentication's existing behavior; no separate liveness probe was added.
- The stored format is unchanged for every host that does not opt in, so no migration, version bump, or store-schema change was needed.

## Testing

- `tests/store.test.ts`: the flag round-trips through `find` and `summarize`, stays absent on disk when off, rejects a non-boolean on create / update / validate, toggles off while an omitted key keeps the stored value, and the `ForwardAgent` import table (`yes` / `true` / `on` on, `no` / absent / unrecognized off).
- `tests/connection-pool.test.ts`: a password host with forwarding gets `agentForward` plus a concrete agent path, a host without it gets neither, an agent-auth host reuses its configured endpoint, and a host with no endpoint throws the actionable forwarding error.
- `tests/agent-forwarding.test.ts`: against the embedded server, an exec and a PTY session on a forwarding host each send exactly one session-scoped request, a host without the opt-in sends none for either, and a server that refuses the request surfaces its error instead of a success.
- `tests/tools.test.ts` / `tests/routes.test.ts`: `ssh_list` carries `forwardAgent` as a required schema field and renders `yes` in the `forward` column, and a PATCH of the flag stores it while dropping the pooled connection.
- `tests/panel-hosts.test.tsx`: the checkbox saves `forwardAgent: true`, unchecking sends `false`, and the badge appears only on enabled hosts.
- `tests/helpers/ssh-server.ts` counts `auth-agent-req@openssh.com` requests per session and can refuse them (`acceptAgentForwarding`), which is what makes the live assertions above possible.
