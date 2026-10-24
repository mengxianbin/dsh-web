# Agent Note: dsh-sysmon — session-header system-metrics chip

Status: implemented

## Problem

Diagnosing a slow machine repeatedly meant leaving the DSH Web GUI to open
Task Manager and Traffic Monitor for CPU, memory and disk numbers. Those
windows cost screen space, a process each, and a context switch at exactly the
moment attention is already on a long-running session. The usage glance in the
sidebar logo row proved the in-GUI pattern, but it only covers provider quota —
no host resource signal exists anywhere in the shell, so a saturated box stays
invisible until the session visibly stutters.

## Decision

- **One dual-face plugin, `packages/dsh-sysmon`**, link-install only
  (`private: true`, not published, not registered in `dsh-web-all`): the
  `typeperf` transport is Windows-specific and must not ride the cross-platform
  aggregate bundle.
- **Host half** (`src/host/sampler.ts`): one resident `typeperf -si 1` child
  streams `PhysicalDisk(_Total)` `% Disk Time`, `Disk Read Bytes/sec` and
  `Disk Write Bytes/sec` over stdout; the 1s tick also diffs `os.cpus()` and
  reads `os.totalmem()`/`os.freemem()`. A `SampleRing` keeps 600 samples
  (ten minutes). `GET /api/sysmon/samples` serves the newest sample plus
  sustained warn flags behind the shared pair-access fence (loopback or
  paired device), with the full ring only on `?history=1`.
- **Warn is a sustained streak, not a spike**: a metric reddens only after
  `warnStreak` consecutive samples (default 3) at or above its threshold
  (default 90/90/90, all overridable in the profile patch).
- **Browser half** (`src/client/SysmonChip.tsx`): seats into
  `conversation.session.header.actions` with entry id `sysmon`, order 10 so
  it lands right of the agent-preset label. It polls once per second while
  the tab is visible; container queries drop the unit labels at ≤620px and
  the whole chip at ≤440px, mirroring the preset label's sacrifice ladder.
- **Degradation is per-signal**: route 404 hides the chip (disabled or
  uninstalled host); a disk row older than 5s serves `null` so the chip shows
  `—` instead of a stale number; an unsolicited child death triggers a
  3s-delayed respawn; a failed poll keeps the last snapshot.
- **typeperf must spawn without `-f`** (see `packages/dsh-sysmon/AGENTS.md`):
  on zh-CN Windows the `-f CSV` flag diverts the CSV payload into a default
  `输出.csv` in the process cwd and stdout carries only progress noise. Four
  P0 probes (2026-10-24/25) established the transport: no `-f`, pipe stdout,
  ~1 CSV line/second.

## Alternatives considered

- **Bottom status bar (`shell.bottom` slot)**: always visible even with no
  session, but it claims the single-occupant slot forever and adds a permanent
  24px row to every layout; the header chip keeps the row budget untouched and
  the user's eye is already on the header during a session.
- **Sidebar logo row beside the usage glance**: rejected — the 40px row is
  already exactly filled by the glance's three window rows plus the stats
  column; adding three more read-outs would overflow precisely the space the
  user flagged as tight.
- **Per-call `Get-Counter` via PowerShell**: rejected — one process spawn per
  sample would add churn and latency, the opposite of the process-count goal.
- **typeperf with `-f CSV` plus a temp file**: the earlier draft; P0b proved
  the flag diverts data to a cwd `输出.csv`, and a rotated temp file adds
  litter risk (two stray `输出.csv` files polluted repos during probing and
  had to be swept). The pipe path needs no file at all.
- **koffi/PDH native bindings**: rejected — a native addon is heavier to
  build and link than one resident `typeperf` child, for no observable
  latency win at 1s cadence.
- **Automatic per-process attribution**: out of scope by user ruling — the
  chip answers "is the machine hot", and `scripts/common/io-attribution.ps1`
  remains the manual culprit-finder.

## Consequences

- The net process count moves by about −1 to −2: one `typeperf` child joins,
  Task Manager and Traffic Monitor can retire for the glance use case.
- The chip is invisible on the blank new-session screen and the no-session
  workspace view (the header row does not render there); this matches the
  user's 90%-in-session working pattern.
- The ring buffer dies with the host process; a future history view needs a
  new client surface but no host change.
- `packages/dsh-sysmon/AGENTS.md` pins the typeperf `-f` trap; changing that
  spawn argument will silently break disk sampling.

## Testing

- `tests/sample.spec.ts` covers CSV parsing (header, blank first row, short
  line), the >100 clamp, MB/s formatting, ring capping and the streak warn
  derivation including null-metric exclusion.
- `tests/sampler.spec.ts` drives the sampler through injected fake clock/cpus/
  child/interval seams: CPU diff math, disk-row freshness and staleness,
  header/blank-row rejection, sustained warn flags, unsolicited-exit respawn
  and stop() semantics.
- `tests/routes.spec.ts` uses the dispatch-plugin fake req/res pattern for the
  200 shape, `?history=1` opt-in, 403 fence and exact route path.
- `tests/sysmon-chip.spec.tsx` (jsdom) asserts the three read-outs, warn
  coloring plus `data-warn`, the pre-first-payload placeholders, the 404 hide
  contract and the keep-last-snapshot behavior, and the tooltip/GB helpers.
- Package gates: `pnpm --filter @linxin666/dsh-client-ui-sysmon typecheck`,
  `test` (38 passing) and `build` are green as of 2026-10-25.
