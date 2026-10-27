# dsh-auto-route

English | [中文](README.zh.md)

Auto source routing for DSH Web (ruling form 乙, 2026-10-24; parameters
revised 2026-10-27): a resident Host-side controller polls the OpenCode Go
meters (`GET https://opencode.ai/console/api/go/status`, bearer key read into
process memory only) with two up-edges and one shared down-edge:

- any window `used/limit >= 0.95` (unrounded) moves **only the global default
  model** to the MiMo official route — new/rotated sessions are born on the
  live side while running sessions keep working;
- any window `>= 0.99` additionally batch-switches the **active session set**
  through `sessionController.selectModel`;
- when **all three** windows read `< 0.95`, both legs return to
  `opencode-go`.

The policy state is served read-only at the loopback-fenced
`GET /api/auto-route/status` — the authority for the sidebar's current-source
badge. Host-only — the package declares no `dsh.client` face, so nothing
appears in the browser roster.

## Why

Two thresholds exist on purpose: the glance v3 UI starts warning red at 85 %,
while this controller acts at 99 % — 「85 % UI 预警 / 99 % 自动动作」. Harness
ships no provider failover (no `failover` config anywhere), and the dispatch
plugin only creates sessions, so a programmatic switch channel plus a policy
controller had to be built. The 30–60 s poll leaves a small burn-through race
between polls at the 99 % line; the line and the cadence are configurable if
that trade needs retuning. The 95 % default line (2026-10-27) exists
precisely for that race: successors are already born on the live side, so a
missed in-flight edge costs one failed attempt, not a dead night.

## Install

Local link install (this package is not published to npm):

```powershell
dsh plugin --profile <name> add link:<repo>/packages/dsh-auto-route
```

The single bundle row (`auto-route`) mounts the Host controller. Restart the
Host (or rely on live patch reload) to activate.

## Config

Every ruling parameter is configurable on the plugin row; defaults are the
2026-10-24 ruling values.

| field | default | meaning |
|-------|---------|---------|
| `enabled` | `true` | Master switch |
| `pollIntervalMs` | `45000` | Poll cadence; clamped into the ruling range 30–60 s (clamp is logged) |
| `triggerRatio` | `0.99` | In-flight edge: any window `used/limit >=` this batch-switches the active set to `switchTo` (unrounded) |
| `defaultRatio` | `0.95` | Default edge: any window `>=` this moves only the global default model to `switchTo` (2026-10-27) |
| `restoreRatio` | `0.95` | Shared down-edge: all three windows must read `<` this for both legs to return (strict; was 0.70) |
| `minDwellMs` | `0` | Shortest triggered-phase stay before a restore; `0` = off |
| `activeWindowMs` | `1800000` | Request recency that keeps a session in the active set |
| `switchTo` | `mimo` / `mimo-v2.6-flash` | Target on trigger (no effort → the model's own default) |
| `restoreTo` | `opencode-go` / `mimo-v2.6-flash` / effort `high` | Target on restore (restores the deployment default behavior) |
| `meterUrl` | `https://opencode.ai/console/api/go/status` | Go meter source |
| `meterKeyEnv` | `OC_GO_CC_API_KEY` | Env var holding the bearer key (memory only, never logged) |
| `balanceGuardrail` | `enabled: false` | MiMo balance guardrail — disabled by the 2026-10-27 ruling (no cash gate, burn to balance) |

A target that is missing from the live model catalog **blocks the edge**
(nothing half-switches) and stays visible on the status endpoint; the next
poll retries once the catalog offers the model.

## API

Every route is loopback-only (RFC 5735 127/8, `::1`, IPv4-mapped, plus
same-origin markers); remote sockets answer `403`.

### `GET /api/auto-route/status`

`200 { ok: true, service: "dsh-auto-route", policy: { … } }` with:

- `phase` (`baseline` | `triggered`) and `effectiveSource` (in-flight provider
  id — what the badge renders), plus `defaultsSource` (what a brand-new
  session inherits; diverges from `effectiveSource` in the 95–99 dead zone),
  `lastDecision`, `lastDecisionAt`
- `lines` (the configured trigger/default/restore/dwell/cadence/window
  values), `targets`
- `windows` (last reading: `used`/`limit` in USD, unrounded `ratio`,
  `resetsAt`), `readingAt`, `lastPoll`
- `lastDefaultSwitch` / `lastTrigger` / `lastRestore` (edge ratios plus
  `switched`/`skipped`/`failed`/`defaultSaved`), `lastOutcome` (per-session
  results), `targetProblem` (blocked-edge diagnostics)
- `activeSet` (tracked sessions with running flag and request recency;
  subagent sessions are marked and never switched)
- `manualLocks` (sessions a human touched: divergent `provider/model` value +
  lock time — both edges skip them until realigned; A case, 2026-10-27)
- `balanceGuardrail` (`enabled` plus a note naming the ruling that keeps it
  off)

`403` non-loopback, `405` wrong method, `500` status-producer failure.

## Behavior

- **Active set** = sessions that are running or made a request within
  `activeWindowMs`, tracked from `session/event` request headers and
  `agent/status`; cold sessions are never batch-resumed.
- **Edges fire once**: each pass runs on its latch edge, not on every poll;
  failed `selectModel` calls are classified (subagent ownership → `skipped`,
  anything else → `failed`) and counted on the edge record.
- **Two legs, one down-edge**: the default edge (`default-switch`) saves the
  deployment default (`agent-default-model`) and never touches running
  sessions; the in-flight edge batch-switches the active set (and repeats the
  default save); the shared restore returns both — but its session pass runs
  only when the in-flight leg had engaged, so a default-only restore never
  stomps sessions the policy never moved.
- **Manual locks (A case, 2026-10-27 人工锁定优先)**: every durable
  `model/selection` event is classified auto vs human (write expectation +
  ledger + live-target comparison — the shared `selectModel` channel carries
  no origin metadata); a human touch locks the session so **both edges** report
  `skipped` / `manual-lock` until its value realigns with the ledger or the
  live target. Locks and ledger are in-memory (a restart clears them);
  same-value and effort-only touches stay invisible (disclosed blind spots).
- **No decision on bad data**: a failed meter poll records `lastPoll.ok:
  false` and touches nothing; recovery resumes on the next good reading.
- Policy state is in-memory: a Host restart boots back to `baseline`, and the
  first poll re-derives the phase from live meters.

## Layout

- `src/index.ts` — plugin entry: injects `webServer`, `sessionController`;
  wires the event listeners, the controller, and the status route.
- `src/policy.ts` — pure phase logic (trigger/restore edges, hysteresis,
  dwell, incomplete-reading fail-safe).
- `src/controller.ts` — poll loop, catalog pre-flight, switch pass, default
  save, status view.
- `src/meters.ts` — go/status fetch (unrounded ratios, no secret ever
  logged).
- `src/active-set.ts` — running/recent/subagent activity ledger.
- `src/manual-lock.ts` — manual-lock ledger (A case): write expectations,
  ownership values, and the locks both edges honor.
- `src/host/routes.ts` — the loopback-fenced status route.
- `src/host/loopback.ts`, `src/host/http.ts`, `src/mount-once.ts` — generated
  copies of the repository-shared host modules (edit `shared/host/*` and run
  `node scripts/sync-shared.mjs`).

## License

Apache-2.0
