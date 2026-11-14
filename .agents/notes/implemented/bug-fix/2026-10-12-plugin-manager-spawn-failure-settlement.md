# Agent Note: Plugin-manager settles a failed CLI spawn instead of taking the dsh host down

Status: implemented

## Problem

Two independent Windows defects met in one feature, and the second turned the first into a host outage.

Every `.cmd` shim has to be executed through the command processor, and `spawnDsh` asked for it by bare name. A bare name resolves through the host `PATH`, so a host whose `PATH` carries no `%SystemRoot%\system32` — a packaged Desktop launch, a service account, a stripped environment — got ENOENT for a binary that is present on disk. Every CLI-backed plugin operation then failed at once, on a host that was otherwise healthy.

Worse, no spawn outlet in the package carried an `error` listener. A `ChildProcess` without one turns a failed spawn into an unhandled `error` event, which is an uncaught exception: one failing CLI call took the whole dsh host process down with it. The wait sites carried the mirror defect — each resolved on `close` alone, and a spawn failure frequently never produces a `close` — so where the host survived, the caller waited forever and the channel probe or the install job stalled instead of reporting.

The detached relaunch helper in `restart.ts` had the same unhandled-`error` hole for a spawn that fails after the call returns, and its retry loop understood only an exit code, so a helper that never started at all read as a helper that started and exited cleanly.

## Decision

Every child this package spawns resolves a real binary and settles on a failure.

- **The command processor comes from the environment, not from PATH.** `windowsCmdPath(env)` reads `ComSpec` first — matched case-insensitively and ignoring blank values, because Windows spells that variable several ways depending on who wrote it (a launcher, a service, the user's own shell) — then `SystemRoot`, then `windir`, and falls back to the conventional `C:\Windows`, joining `System32\cmd.exe` onto whichever root it found. ComSpec is preferred because it is the variable Windows itself keeps for this and it names the real binary. The POSIX branch is untouched: a POSIX host spawns the CLI directly and needs no command processor at all.
- **Every spawned child is guarded at the spawn site.** `guardSpawnFailure` attaches the listener that was missing: it records the failure reason on the child and, when the child has not closed yet, emits `close(-1)` itself. A caller that only waits for `close` therefore neither hangs nor crashes. `SPAWN_FAILURE_EXIT_CODE` is that `-1`, and only a genuine spawn failure triggers it — an error whose `syscall` starts with `spawn`. A later lifecycle failure such as a kill that did not land is left to the normal close path, because there the child really did start and its exit code is the true verdict.
- **One wait helper serves every outlet.** `awaitChildExit` attaches its own listener pair, so it is safe even for a child that arrived through an injected spawn seam and therefore skipped the guard. `awaitCliExit(child, output, timeoutMs?)` folds it: it arms the optional kill timer, appends the failure reason to the bounded output capture, and returns the exit code. The five sites that each hand-rolled the same timer-and-`close` promise — the official installer channel probe (`detectOfficialChannels`), `CliGateway.runCli`, the shared job runner `CliGateway.runInner`, `CliGateway.rollbackInstall` and the post-install boot preflight `CliGateway.verifyBoot` — now share it, so a process that never started is reported exactly the way any other non-zero exit is.
- **The relaunch helper journals a spawn failure instead of dying on it.** `startRelaunchHelper` attaches an `error` listener that appends the reason to its journal and tolerates a missing log, and the detached launcher's retry loop now treats a spawn error like an exit: it retries within its attempt budget and gives up naming the reason, rather than reporting a clean stop for a helper that never ran.

The package README's security model carries the user-facing half of this: the command processor is addressed by absolute path and a spawn that still fails settles as a failed job carrying the reason, instead of taking the host down.

## Alternatives considered

**Keep the bare `cmd.exe` name and rely on the launcher to compose a PATH.** Rejected: the failing case is precisely a host whose PATH a launcher did not compose. The binary's location is already a fact of the environment, so reading it is strictly more reliable than asking PATH to find it again.

**Prepend `%SystemRoot%\system32` to the child environment instead.** Rejected: it repairs one missing directory rather than the resolution itself, it changes the environment every CLI call inherits (and so every other PATH-dependent lookup inside that call), and it leaves the bare-name dependency in place for the next caller.

**Use `shell: true` for the shim spawn.** Rejected: it re-parses the argument vector through a shell, which is exactly what `windowsCmdShimArgs` and `windowsVerbatimArguments` exist to avoid, and it would widen the injection surface this package deliberately narrowed.

**Let each caller's own `error` handler do the settling.** Rejected: Node emits `error` asynchronously, and with no listener the process is already gone before any caller code runs. The settle has to be attached where the child is created, before the event fires.

**Reject the awaiting promise on a spawn failure.** Rejected: every outlet already has a defined non-zero-exit path that renders the captured output, so turning the failure into a rejected promise would add a control-flow branch to five call sites to reach a state they can already express. `awaitChildExit` does expose the failure as a value (`spawnError`), so a caller that prefers to branch still can.

**Settle on every `error` event rather than only a spawn failure.** Rejected: a child that has already closed would have its real exit code overwritten by a synthesized close, reporting a spawn failure for a process that ran and failed for its own reasons.

**Guard the host instead of the children.** Rejected: an unhandled `error` event kills the process, so nothing at a higher level gets to run. There is no recovery point above the spawn that could catch this.

## Consequences

- A Windows host whose PATH omits the system directories still runs every CLI-backed plugin operation, because the command processor is resolved from the environment rather than looked up by name.
- A failed spawn degrades the one plugin feature, not the dsh host process: the operation reports a readable reason through the output it already renders, and no outlet waits forever.
- `spawnDsh` returns a guarded child on both branches, so a new call site inherits the settlement rather than having to remember to add it. An outlet injected through the `spawnImpl` seam is covered by `awaitChildExit` instead.
- The failure is reported as exit code `-1`, which no real CLI exit code can collide with, so a caller can tell "never started" from "ran and failed" without parsing text.
- A relaunch helper that cannot start still means the restart does not happen; now the journal says why and the host survives to report it, instead of dying on the `error` event.
- The five outlets share one wait path, so their timeout and output handling can no longer drift apart the way five hand-rolled copies did.

## Testing

`packages/dsh-plugin-manager/tests/spawn-failure.spec.ts` spawns names no PATH can resolve, so the failures are deterministic and independent of the host PATH, and records uncaught exceptions across each case. It covers five resolutions of `windowsCmdPath` (a ComSpec path, a lower-case `comspec`, a blank ComSpec falling back to `SystemRoot`, a `windir`-only environment, and an environment naming no root at all), the settlement itself (a failed exit code plus the reason in the capture, no uncaught exception, and a caller waiting on `close` alone resolved rather than hanging), the real `detectOfficialChannels` probe degrading to "no official channels" when its CLI cannot be spawned, a `CliGateway` install whose CLI cannot be spawned settling as an `error` job naming ENOENT with the host intact, and the relaunch helper journalling `helper spawn error` while reporting that no helper started. The package suite passes (338 tests).
