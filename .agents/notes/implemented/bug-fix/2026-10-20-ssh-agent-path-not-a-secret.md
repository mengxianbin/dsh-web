# Agent Note: The ssh-agent path is not a secret, and Windows defaults to the native pipe (issue #1910)

Status: implemented

## Problem

Editing a stored host and switching its authentication to SSH Agent with the agent path left empty saved nothing: the dialog closed, the list refreshed, and the host still authenticated with its previous method — with no error anywhere. The host form classified `agentPath` as a secret, so an empty value set `secretEmpty`, and `HostFormDialog` then dropped the whole `auth` block from the PATCH. `store.update()` only touches authentication when `patch.auth !== undefined`, so a request without it is a legitimate "nothing to change" and answers 200 while keeping the old auth kind. The field's own hint says "leave empty to auto-detect", so the UI was actively steering users into the one input that could not work.

The failure was not cosmetic. A private key with a passphrase imports as `kind: 'key'` (the importer prefers `IdentityFile`), and agent auth is exactly what those users need — so the most agent-motivated path through the form was the one that silently failed.

A second defect sat behind it: with the `auth` block finally submitted, an empty agent path on Windows resolved to the literal string `pageant`, PuTTY's agent. A machine running the native OpenSSH `ssh-agent` service does not have Pageant, and the handshake fails with `Pageant is not running`. ssh2 already understands Windows named pipes, so the default was simply wrong.

## Decision

### `agentPath` is an address, not a credential

The form's "an empty secret field preserves the stored credential" rule applies to the password and to the private-key path only. For agent auth `secretEmpty` is `false`, so an agent form always submits its `auth` block; the existing normalization on the next line still turns an empty path into an omitted `agentPath`, which is the documented auto-detect value. Switching a host to SSH Agent therefore takes effect with the field left blank, which is what the hint promises.

The store is unchanged. It keeps the PATCH guard `patch.auth !== undefined` — that guard is what lets a tags-only update leave the stored credential alone, and it is correct once the client stops mis-classifying a non-secret.

### Windows auto-detect dials the native named pipe

`resolveAgentPath()` falls back to `WINDOWS_AGENT_PIPE` (`\\.\pipe\openssh-ssh-agent`) on win32 instead of `pageant`. The resolution order is otherwise untouched: an explicitly configured agent path wins, then `SSH_AUTH_SOCK`, then the platform default. A user who really runs PuTTY keeps Pageant by writing the literal `pageant` agent path, which ssh2 still treats as the Pageant protocol rather than a pipe.

Both `buildConnectConfig`'s agent branch and the forwarding resolution share this function, so authentication and forwarding move together.

## Alternatives considered

- Making the store treat a missing `auth` as "switch to agent". Rejected: a missing field cannot distinguish "the user chose agent" from "this caller only edited tags", and it would silently rewrite authentication on every partial update.
- Adding a separate "clear agent path" control instead of submitting an empty one. Rejected: an empty agent path already has a defined meaning (auto-detect) that the hint and the store both encode; a second control would make the common case the awkward one.
- Trying Pageant first on Windows and falling back to the named pipe when the Pageant handshake fails. Rejected: it doubles the failure paths, delays the real error, and reports "Pageant is not running" for machines that never installed it. One documented default plus an explicit `pageant` value is smaller and predictable.
- Keeping `pageant` as the default and only fixing the form. Rejected: it fixes the silent save while leaving the Windows agent user with a working request that still cannot connect — the same "it did nothing" experience one step later.

## Consequences

- An existing Windows host that relies on the old implicit `pageant` default now dials the native pipe instead. Such a host must set its agent path to `pageant` explicitly; the stored profile is not migrated, because the stored value was never written — it was inferred at connect time.
- The auto-detect wording in `form.agentPathHint` and `form.authKeepHint` now matches the behavior in all three languages: the path hint names the Windows named pipe, and the keep hint no longer claims an empty agent path preserves the previous authentication.
- The package `AGENTS.md` states the rule that produced the bug, so a later "secrets are never echoed" cleanup cannot re-absorb `agentPath`.
- README (both languages) documents the new endpoint order in the capability table and the security model.

## Testing

- `tests/host-form-dialog.test.tsx` renders the real dialog: switching a key host to SSH Agent with an empty path submits `{ kind: 'agent', agentPath: undefined }`, a typed path travels with the block, and empty password / key fields still omit `auth`. The first case fails against the previous code with `expected undefined to deeply equal { kind: 'agent' }`.
- `tests/connection-pool.test.ts` forces `process.platform = 'win32'` with no `SSH_AUTH_SOCK`: an agent host resolves to the named pipe, and an explicit `pageant` path still wins.
- `tests/locales-runtime.spec.ts` plus `pnpm i18n:check` keep the zh / en / ru hint text aligned.
