# @linxin666/dsh-client-ui-sysmon

English | [中文](README.zh.md)

DSH web GUI plugin sysmon — a live system-metrics chip in the session header.
It shows CPU, memory and disk activity sampled every second on the Host plus a
passive provider-network reading, and reddens any metric that has sat at or
above its threshold for a sustained streak, so a saturated machine or a
degrading model link is visible without leaving the chat.

## What it does

- Seats a compact chip into `conversation.session.header.actions`, right of
  the agent-preset label: four tabular-numeral read-outs (CPU busy %, memory
  used %, disk busy %, provider network) plus a hover tooltip with disk
  throughput, memory absolutes, and the network detail line.
- Mirrors the same chip into `conversation.header.leading`, the one header
  cell that renders with no Session and stays visible while a blank Session
  hides the actions row. A module-level mount signal keeps the two seats
  exclusive, so exactly one copy paints: the actions copy wins whenever both
  would be mounted.
- Samples on the Host every second: CPU from an `os.cpus()` diff, memory from
  `os.totalmem()`/`os.freemem()`, and disk from one resident `typeperf` child
  that streams the three `PhysicalDisk(_Total)` counters over stdout.
- Reads the provider network passively (v4, latency half revised 2026-10-27):
  the Host taps the connection segment of each real model request at the
  socket layer — DNS lookup → TCP connect → TLS handshake completion, on the
  exact route real requests travel, direct or through a local HTTP proxy —
  and listens to the harness's `agent/request-error` for failures classified
  as `TIMEOUT`/`TRANSPORT`, both over one shared **10-minute sliding window**.
  The tooltip states which segment the number covers (direct handshake, or
  proxy tunnel where the loopback leg to the proxy is not network). The
  reading renders as `23ms` / `⚠3` / `23ms ⚠3` and reddens once the
  windowed failure count reaches the threshold; an empty window shows `—`,
  never a stale number. **Zero active probes, zero extra traffic** — the
  measurement rides the same path as real requests, proxy configuration
  included. TTFT (first-token latency) left the main grid with this revision:
  provider queue time and first-token generation drown the network component,
  while a connection segment shares the millisecond dimension of the
  CPU/memory/disk read-outs.
- Keeps a ten-minute in-memory ring buffer (600 samples) behind
  `GET /api/sysmon/samples`, so a future history view needs no host change.
- Warns by sustained streak, not by single spike: a metric reddens only after
  `warnStreak` consecutive samples (default 3) at or above its threshold.
- Degrades on its own: when the host half is off or disabled the route 404s
  and the chip hides itself; a stalled disk child shows `—` for disk rather
  than a stale number; a failed poll keeps the last snapshot and retries.

## Install

This package is link-install only. It is not published to npm and is not part
of the `dsh-web-all` aggregate bundle (its `typeperf` sampling is Windows-only).

### From this repository

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm install
pnpm --filter @linxin666/dsh-client-ui-sysmon build
dsh plugin --profile web add link:$(pwd)/packages/dsh-sysmon
```

## Config

The plugin exposes a schemastery config; override any key in the profile
`cordis.patch.yml` plugin row, then restart the DSH service.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch for the sampler, the network observer, and the route. |
| `cpuWarnPercent` | number | `90` | CPU busy percent that reddens the chip. |
| `memWarnPercent` | number | `90` | Memory used percent that reddens the chip. |
| `diskWarnPercent` | number | `90` | Disk busy percent that reddens the chip. |
| `warnStreak` | number | `3` | Consecutive 1s samples required to warn. |
| `netWarnFailures` | number | `1` | Windowed network failures that redden the net reading; `0` disables the red state (the count still renders). |

## Security model

`GET /api/sysmon/samples` is a read-only route behind the shared pair-access
fence: a loopback request always passes, and a live remote-web-ui paired-device
cookie passes too. Every unpaired LAN or tunnel request is refused with `403`.
No credential, file path, or process name crosses the wire — only aggregate
per-second counters plus the network reading (connection-segment milliseconds
with a `direct`/`proxy` handshake-shape flag, a failure count, and the
provider route name, e.g. `deepseek` — a route identifier, not an endpoint
URL and not a key; the `ttftMs` field is a null compatibility stub).

## Known limitations

- Disk metrics require Windows (`typeperf`); on other platforms the chip
  shows `—` for disk while CPU and memory still work.
- `% Disk Time` on `_Total` can exceed 100 on multi-queue disks; the display
  clamps it to 100 while history keeps the raw value.
- The ring buffer is in-memory and lost on restart; there is no history UI yet.
- The fallback copy sits in the header's leading cell, so between states the
  chip moves from the left edge (no Session / blank Session) to beside the
  preset label (active Session).
- Per-process attribution is out of scope; run
  `scripts/common/io-attribution.ps1` from m-note when you need the culprit.

## License

Apache-2.0.
