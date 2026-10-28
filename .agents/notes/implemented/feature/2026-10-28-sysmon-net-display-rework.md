# Agent Note: Sysmon net cell drops the failure count + tooltip hover-freeze + quick probe retry

Status: implemented

## Problem

Three same-day reports (2026-10-28) from a user watching the chip:

1. **The failure count does not represent the present**: the fourth cell's
   `⚠n` comes from a 10-minute sliding window — it climbs and decays on a
   ten-minute timescale. Ruling quote: "don't show the failed-session count
   anymore; the count's update window is far too long to reflect the current
   real-time state."
2. **The tooltip flickers**: while hovering, the native `title` tooltip blinks
   once a second and can't be read. Root cause: the payload re-renders every
   second, rewriting the `title` string (the second-resolution refresh stamp
   plus four read-outs), and **a native tooltip is dismissed whenever `title`
   is mutated under the pointer** — the dwell timer resets every tick.
3. **Latency vanished, only the failure badge remained**: a captured moment
   read `Net ⚠36` with no milliseconds. Diagnosis: right after that moment the
   live `/api/sysmon/samples` served `rttMs=41` fresh — the capture fell in a
   probe-failure streak longer than `RTT_STALE_MS` (150s = two 60s rounds +
   grace), so the RTT aged to `—` under the "never show a stale number" rule
   while the failure badge still stood, becoming the only rendering. The
   failure log corroborates a genuinely bad link at the time (`failures`
   8 → 36 → 43). On a 60s cadence, three consecutive misses blank the cell for
   minutes — the reading goes silent exactly when it matters.

## Decision

One same-day ask (option "withdraw completely", user-selected) settled all
three:

- **Withdraw the display (full)**: the `⚠n` badge, the red net state, the
  `net` key of `data-warn`, and the tooltip's failure count and route label
  **all leave the display** — the cell renders only `formatNetValue`
  (`19ms` / `—`), and `netLine` renders only the round trip or the idle
  notice. Locales (zh/en) drop the `{failures}` placeholder from
  `chip.netDetail` and delete `chip.netProvider`; the dsh-i18n ru mirror
  follows. **The wire and the counting pipeline stay untouched**:
  `failures`/`provider`/`warn` keep riding the payload, and
  `netWarnFailures` now only sets the payload's `net.warn` flag (README
  config row reworded). The skin-center semantic contract table's `chip` row
  drops the `net` key and dates the ruling. Rationale for the full form: the
  red state and the count share the same window — keeping either half would
  still misrepresent "the present".
- **Tooltip hover-freeze** (flicker fix): `SysmonBody` holds the title in
  state — **never written while hovered** (a `hoveredRef` blocks the
  per-second `setTitle`), and leaving the hover restores the live title from
  the latest payload. The native title and its ~1s dwell remain. **The hooks
  must sit above the 404 early return** (the first attempt placed them after
  it and React immediately threw "Rendered fewer hooks than expected" — the
  `hostOff` branch changed the hook count).
- **Quick retry after a failed probe** (latency-presence fix):
  `ping-probe.ts` adds `PROBE_RETRY_MS = 15_000` — a failed round retries
  after 15s, and only success restores the 60s cadence
  (`schedule(ms === null ? retryMs : intervalMs)`). A transient loss no
  longer blanks the cell for minutes; a sustained outage still honestly
  reads `—` (that is the rule, not a bug). Steady-state traffic remains one
  packet per minute: the quick retry only ever runs while probes are
  failing.

## Alternatives considered

- **Withdraw the badge but keep the red state / shrink the window to 60s**:
  the user explicitly picked "withdraw completely" in the ask — the red state
  and the count share the 10-minute window, so keeping either half conflicts
  with the ruling.
- **A hand-rolled CSS tooltip (hover div)**: fixes the flicker and shows
  instantly, but introduces clipping, touch-fallback and theming risks; the
  native-title freeze is a one-state fix — smallest change wins.
- **Lengthening `RTT_STALE_MS` to keep a number on screen**: violates the
  established "never show stale values" rule; fixing the probe cadence is the
  real cure (the staleness bound stays at 150s).

## Consequences

- The net cell collapses from four states (`19ms` / `⚠n` / `19ms ⚠n` / `—`)
  to **two** (`19ms` / `—`); `data-warn` and the red coloring keep only the
  `cpu`/`mem`/`disk` keys.
- The payload still carries `failures`/`warn` (wire unchanged, no breakage
  for older consumers); if a short-window failure indicator is ever wanted,
  the pipeline is already there.
- While hovered the tooltip is a snapshot from hover start (≤1s old) and
  resumes live values on leave — stable readability beats millisecond
  freshness.
- Tests **82 green** (81 → 82: net −1 (badge examples) + chip +1 (hover-freeze
  case) + ping-probe +1 (quick-retry case)): net 11, net-observe 3,
  ping-probe 13, chip 19, seats 7, routes 4, sampler 9, sample 16. The
  freeze case asserts the `title` attribute does not change when the second
  poll lands mid-hover, and resumes after `mouseLeave`.
- Gates: package typecheck / test (82) / build; repo `i18n:check` (16
  namespaces, zh = ru balanced, `chip.netProvider` deleted in all three
  languages), `docs:check` (README pair re-recorded via
  `verify-docs --write`).
- **Activation**: the display layer and the freeze are client-half — rebuild
  then F5; the quick retry lives host-half (`ping-probe.ts` loads with the
  plugin effect), so it needs the host hot-mount to take effect or a DSH web
  restart (human-run).
