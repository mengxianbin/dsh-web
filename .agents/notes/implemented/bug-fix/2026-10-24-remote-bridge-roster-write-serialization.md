# Agent Note: Serialize device-roster writes on Windows

Status: implemented

## Problem

Two APNs deliveries can fail in the same turn and retire their Live Activity tokens concurrently. Each retirement updates the in-memory `DeviceRoster` and awaits `#persist()`, but the writes themselves had no ordering. On Windows, two same-directory renames racing to replace `devices.json` fail with `EPERM: operation not permitted`. The existing dead-token test reproduced the failure consistently on this host, while a sequential rename probe succeeded.

The issue is not the roster's schema or its atomic-write guarantee. The old code already used a unique temporary file, `fsync`, close, rename, and `chmod 0600`. What was missing was exclusion between concurrent write operations, leaving both durability and the final token-retirement result dependent on filesystem timing.

## Decision

`DeviceRoster` now keeps one per-instance `#writeQueue`. `#persist()` appends the real write to that queue and returns the caller its own promise. The existing `#write()` implementation remains unchanged: temporary file, `fsync`, close, atomic rename, and `chmod 0600`.

The queue tail catches a failed write only to let later writes proceed; it does not hide that failure from the caller awaiting it. In-memory mutations keep their current synchronous order, and each queued write serializes the roster current at that moment, so the final file includes every accepted mutation.

The regression is covered by the existing `tests/liveactivity.spec.ts` scenario with two concurrently rejected tokens. No dependency, schema, protocol, or public API changes are introduced. The fix is separate from the [push-notification contract](../architecture/2026-10-21-remote-bridge-push-notifications.md) and was found during [SDK cohort rc.3 validation](../architecture/2026-10-24-sdk-cohort-0.2.1-rc.3.md), not caused by an rc.3 API change.

## Alternatives considered

**Retry the rename on `EPERM`.** Rejected: an arbitrary retry would hide the race instead of establishing write order, and a concurrent replacement could still make the persisted result timing-dependent. Serialization addresses the cause.

**Log and ignore persistence failures.** Rejected: a dead token that remains on disk can be retried against APNs later, contradicting the retirement contract. Callers still receive the original error.

**Use one process-global queue for every roster.** Rejected: independent roster instances and files do not need to block one another. Exclusion is required only within one roster/file pair, so the queue belongs to the instance.

**Change the on-disk format or make retirement best-effort in memory only.** Rejected: existing profiles and the durable schema remain valid, and an in-memory-only retirement would be lost on restart.

## Consequences

- Concurrent token retirement no longer races the Windows replacement of `devices.json`; the original failing 33-test live-activity file passes.
- `pnpm --filter @linxin666/dsh-remote-bridge typecheck`, the full package suite (42 files, 583 tests), and `pnpm --filter @linxin666/dsh-remote-bridge build` pass after the change.
- The complete workspace `pnpm test` also passes on the rebased tree. A separate task-board mount timeout under parallel load passed when rerun alone and passed again in the following full-suite run; it is not part of this fix.
- No migration is needed: existing `devices.json` files load under the same version-2 schema, and the temporary-file and permission semantics are unchanged.
