# Agent Note: Authorized devices get names and an explicit duplicate merge

Status: implemented

## Problem

The desktop remote panel derived every device label live from the stored User-Agent (`deviceNameFromUserAgent()`), so a phone read as `Android · Chrome` and a second scan from the same phone produced an identical row with a different session id. Pairing deliberately mints one session per accept because mobile cookie contexts split (camera preview, in-app browser, system browser), and `maxDevices` (default 4) is a hard cap, so duplicate rows silently push out older authorizations. The roster had no way to name a device and no way to collapse duplicates. The browser pairing path itself is owned by [the remote-control UI note](../architecture/2026-08-29-remote-control-reuses-official-ui.md); this note owns the roster's naming and duplicate handling.

## Decision

`DeviceSession`, `DeviceSnapshot` and the client `DeviceFrame` carry an optional `name`. It is persisted in the existing `devicesFile` store, and the panel renders `deviceDisplayName()`: custom name, then the UA-derived name, then the localized unknown-device fallback. The name is display metadata and never reaches an authorization decision; the device id remains the sole credential.

Renaming is `POST /api/pair/rename` (`{deviceId, name}`) on the same loopback-only control plane as revoke; a blank name clears the label. Duplicate handling stays explicit: pairing still mints a session per accept, because two physically different devices can present the same User-Agent. Grouping is presentation-only (`duplicateDeviceGroups()` groups rows by exact non-empty User-Agent) and shows a "may be the same device" hint plus a merge button. `POST /api/pair/merge` (`{deviceIds}`) keeps the most recently active row, revokes the rest, refuses mixed User-Agents and unknown ids, inherits a typed name from a dropped row when the survivor has none, and persists the revocation through the existing revocation path.

The trigger also gains `data-testid="remote-trigger"` so external plugins can anchor on it instead of the `aria-label` the panel root shares.

## Alternatives considered

- **Merge automatically at accept by User-Agent.** Rejected: the same UA does not prove the same physical device. Silently revoking one of two identical phones would cut off a credential the operator never revoked, which is exactly the quiet loss the per-device controls exist to prevent.
- **Keep the name in a sidecar file owned by another plugin.** Rejected: the browser path already owns the device store, and a second file would drift from the session it names (a revoked session would leave a stale label behind). The name belongs to the session row and disappears with it.
- **Implement the merge in the panel as N revoke calls.** Rejected: the survivor must be chosen from the same snapshot the operator saw, and N independent calls leave the panel with a partial group when one fails. One host-side operation picks the survivor and writes the revocation once.

## Consequences

- Device labels survive a restart and a sweep; the persisted file gains an optional `name` key, which older files simply lack.
- A merge is a revocation: the dropped rows' browsers are cut off on their next request, exactly like unpair. The hint says "may be the same device" precisely because this is the operator's call.
- The two new endpoints sit behind the loopback fence, so they add no LAN or tunnel surface; the README security model names them beside mint/stop/revoke.
- Tests pin the service semantics (sanitization, blank clear, merge survivor/refusals/name inheritance, persistence), the route fences and payload contracts, and the panel flows (inline rename, duplicate hint and merge).
