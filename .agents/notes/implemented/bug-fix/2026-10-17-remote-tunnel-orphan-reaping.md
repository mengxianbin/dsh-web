# Agent Note: A crashed host's tunnel child is reaped by the next start

Status: implemented

Owns one lifecycle decision: what happens to the `cloudflared` child of the auto tunnel when the host dies without tearing the tunnel down. The supervision of a *running* tunnel is owned by [A running tunnel is supervised by its public URL](2026-09-25-tunnel-readiness-watchdog.md); this note owns the process that outlives the host.

## Problem

`TunnelManager` owns the child through the `cloudflared` package's `Tunnel`. A graceful exit reaches `dispose()` -> `stop()` -> `teardown()` -> `handle.stop()`, which kills the child, so a clean shutdown leaves nothing behind. A crash does not: the child is reparented to `launchd`/`systemd` and keeps its edge registration, holding a hostname nobody serves while the next host spawns a second connector beside it.

Measured on 2026-10-17 after the 0.2.1-rc.2 host crashed repeatedly (`dsh-task-board` `assertPeerLive` threw a TypeError on `signal`): one such child survived as pid 4548, `ppid 1`, running

```
cloudflared tunnel --url http://127.0.0.1:19387 --no-autoupdate --protocol http2 --http-host-header <hostname>
```

None of it was usable: nothing listened on 19387 any more, the host that owned it was gone, and its `trycloudflare` hostname was already deregistered — the public entry answered HTTP 530 with the same dead hostname in the body. The only manual way out was to pattern-match the command line by hand, which is exactly what must not be automated naively: the same `pgrep -f 'cloudflared tunnel'` that finds the orphan also finds the user's own tunnel, and any pattern-based kill can hit a process the plugin never started.

## Decision

The manager records the child it spawned and reaps exactly that child on the next start.

- **Record after the spawn.** `attempt()` records `{ pid, command, ownerPid, recordedAt }` at `$DSH_HOME/remote-web-ui-tunnel-child.json` (mode `0600`) as the first thing after the factory returns, where `command` is the child's own `spawnargs` joined with single spaces and `ownerPid` is the host process. A handle that exposes no OS process is simply never recorded — a record is an observation, not a guess.
- **Clear when the child stops.** `stopHandle()` stops the handle and deletes the record, but only a record this manager wrote; a sibling host's record is not its to drop. `fail()` and `teardown()` both go through it, so the graceful path keeps leaving nothing behind.
- **Reap before the next spawn.** `attempt()` runs the reap after the binary is ensured and before `factory()` spawns, so the leftover is gone before a second connector exists. The reap settles one recorded leftover:
  - no trusted record (absent, or missing a positive `pid`/`ownerPid`/`command`) -> drop the file, verdict `none`;
  - the recorded pid is gone, or the process now at that pid reports a *different* command line -> drop the file only, verdict `stale`, no signal. Pid recycling therefore cannot make the plugin signal a stranger;
  - the recorded owner host is still alive -> leave both alone, verdict `owned`. Two live hosts can share one DSH home (two profiles, or a plugin reload inside one host), and each owns its own child;
  - otherwise `SIGTERM` the recorded pid, poll liveness for a bounded grace (3 s), `SIGKILL` if it survived, drop the file, verdict `reaped`.
- **The command line is what identifies the process.** The pid alone is a number that gets reused; `ps -ww -p <pid> -o command=` (Linux: `/proc/<pid>/cmdline`) must reproduce the recorded line exactly. Nothing matches by process name, by port, by parent, or by pattern.
- **Fail safe, not loud.** A reap that throws only logs a warning and never fails the tunnel attempt; a platform with no `ps` and no `/proc` (Windows) reports an unreadable command line, which reads as `stale` and signals nothing.

## Alternatives considered

- **`pkill -f 'cloudflared tunnel'`, or any pattern match.** Rejected outright: it is the one action that can kill a tunnel the user started by hand, and it cannot distinguish the plugin's child from a wrapper that merely mentions it. The recorded pid plus a matching command line is the only form that identifies a process the plugin really started.
- **Record the pid only.** Rejected: a recycled pid would then make the next start kill an unrelated process. The command line comparison is what turns a number into an identity.
- **Find the orphan by the port it proxies.** Rejected: the leftover's `--url` names the loopback port of the *dead* host (19387 above, already closed), so a port match finds nothing at the next start, whose own port is different.
- **Spawn the child in its own process group (`detached: true`) and kill the group.** Rejected: it changes who receives the terminal's signals (Ctrl-C would stop reaching `cloudflared`) for a cleanup that only ever needs one recorded pid.
- **Reap from the host or the plugin manager at boot.** Rejected: neither owns the child, neither can know whose child it is, and the host that would act is the one that just crashed. The manager that spawns the child is the only component that can write an honest record of it.
- **One record per profile.** Rejected for now: one record per DSH home is enough once the owner-pid guard is in place, and a per-profile file would need a profile identity the tunnel manager does not otherwise have.

## Consequences

- A graceful exit is unchanged: `dispose()` still kills the child and now also drops the record, so a healthy host never reaps its own live child.
- A crash loses at most one reap: a record overwritten by a live sibling, or a crash between the spawn and the record write, leaves that one child behind.
- The record is one file per DSH home, so two hosts that crash in sequence keep only the last record; the earlier child needs the same manual handling as before.
- Windows never reaps (no `ps`, no `/proc`), and the Linux `/proc` branch is unit-tested here but not exercised on a Linux host.
- The plugin now signals a process at startup. That is a new safety-relevant behaviour and is disclosed in the package README pair.

## Testing

- `packages/dsh-remote-web-ui/tests/tunnel-orphan.spec.ts` (8 tests over real `node -e` children in a throwaway `DSH_HOME`): a leftover with a dead owner is reaped on the next start; a dead pid and a changed command line each drop the record without signalling; a child that ignores `SIGTERM` is killed after the bounded wait; a live owner keeps its child *and* its record; the manager never drops a record it did not write; the Linux `/proc` parse yields the same line as `ps`.
- `packages/dsh-remote-web-ui/tests/tunnel.spec.ts` keeps the graceful path pinned: dispose kills the child and leaves no record file.
- Measured against the real binary on 2026-10-17 in an isolated `DSH_HOME`: a self-spawned `cloudflared` recorded with a dead owner came back `reaped` (process gone, record cleared), a record whose command did not match came back `stale` with the process still alive, and a record owned by the live test host came back `owned` with both the process and the record kept.
