# dsh-auto-route

English | [中文](README.zh.md)

Auto source routing for DSH Web (ruling form 乙, 2026-10-24): a resident
Host-side controller polls the OpenCode Go meters
(`GET https://opencode.ai/console/api/go/status`, bearer key read into
process memory only) and, when **any** of the three windows reads
`used/limit >= 0.99` (unrounded), switches the **active session set** to the
MiMo official route through `sessionController.selectModel`; when **all
three** windows read `< 0.70` it switches back to `opencode-go`. The policy
state is served read-only at the loopback-fenced
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
that trade needs retuning.

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
| `triggerRatio` | `0.99` | Any window `used/limit >=` this switches to `switchTo` (unrounded) |
| `restoreRatio` | `0.70` | All three windows must read `<` this to switch back (strict) |
| `minDwellMs` | `0` | Shortest triggered-phase stay before a restore; `0` = off |
| `activeWindowMs` | `1800000` | Request recency that keeps a session in the active set |
| `switchTo` | `mimo` / `mimo-v2.6-flash` | Target on trigger (no effort → the model's own default) |
| `restoreTo` | `opencode-go` / `mimo-v2.6-flash` / effort `high` | Target on restore (restores the deployment default behavior) |
| `meterUrl` | `https://opencode.ai/console/api/go/status` | Go meter source |
| `meterKeyEnv` | `OC_GO_CC_API_KEY` | Env var holding the bearer key (memory only, never logged) |
| `balanceGuardrail` | `enabled: false` | MiMo balance guardrail — disabled pending session-276c5584 |

A target that is missing from the live model catalog **blocks the edge**
(nothing half-switches) and stays visible on the status endpoint; the next
poll retries once the catalog offers the model.

## API

Every route is loopback-only (RFC 5735 127/8, `::1`, IPv4-mapped, plus
same-origin markers); remote sockets answer `403`.

### `GET /api/auto-route/status`

`200 { ok: true, service: "dsh-auto-route", policy: { … } }` with:

- `phase` (`baseline` | `triggered`) and `effectiveSource` (provider id the
  policy considers in force — what the badge renders), `lastDecision`,
  `lastDecisionAt`
- `lines` (the configured trigger/restore/dwell/cadence/window values),
  `targets`
- `windows` (last reading: `used`/`limit` in USD, unrounded `ratio`,
  `resetsAt`), `readingAt`, `lastPoll`
- `lastTrigger` / `lastRestore` (edge ratios plus `switched`/`skipped`/
  `failed`/`defaultSaved`), `lastOutcome` (per-session results),
  `targetProblem` (blocked-edge diagnostics)
- `activeSet` (tracked sessions with running flag and request recency;
  subagent sessions are marked and never switched)
- `balanceGuardrail` (`enabled` plus a note naming the pending dependency)

`403` non-loopback, `405` wrong method, `500` status-producer failure.

## Behavior

- **Active set** = sessions that are running or made a request within
  `activeWindowMs`, tracked from `session/event` request headers and
  `agent/status`; cold sessions are never batch-resumed.
- **Edges fire once**: the switch pass runs on the phase edge, not on every
  poll; failed `selectModel` calls are classified (subagent ownership →
  `skipped`, anything else → `failed`) and counted on the edge record.
- **Default follows the policy**: each edge also saves the deployment default
  (`agent-default-model`), covering the empty-active-set case so new sessions
  land on the in-force side.
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
- `src/host/routes.ts` — the loopback-fenced status route.
- `src/host/loopback.ts`, `src/host/http.ts`, `src/mount-once.ts` — generated
  copies of the repository-shared host modules (edit `shared/host/*` and run
  `node scripts/sync-shared.mjs`).

## License

Apache-2.0
