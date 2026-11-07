# dsh-session-revive

English | [中文](README.zh.md)

Shadow-first automatic session revival for DSH Web: the plugin observes every
`turn/end` error, classifies its failure code, and for revive-class codes
(`TRANSPORT`, `TIMEOUT`) applies the ruled per-session revival account —
rolling 4h x 4 quota per chain, wall-class suspension at zero cost until
`resetsAt`, a 10-minute circuit breaker, same-cause wave holds released
staggered after a 5-minute quiet period, and the 150k context watermark.
Two stop causes join the same account per the 2026-11-07 triage ruling
(design §7): a `max-tokens` turn end (the provider answered, the output hit
the ceiling) and the goal-round-driver's durability flush failure (observed
through a logger exporter tap). Excluded causes — human abort, session
resume/fork markers, goal block/complete — are never continued; they only
write a `stop-parked` evidence line. Every detection and decision is one
structured JSON log line. The default `shadow` mode never touches a session;
`mode: 'live'` queues a continue nudge through the Host session controller.
Host-only — the package declares no `dsh.client` face.

## What it does

- Classifies each `turn/end` error: revive-class (`TRANSPORT`, `TIMEOUT`)
  enters the revival flow, wall-class records a zero-consumption suspension
  until `resetsAt`, and other codes are observed and logged only.
- Folds the two stop causes (design §7.2) into the same revival flow: a
  `max-tokens` turn end first clears any stale suspension (the provider did
  answer), then runs the account as a revive-class death; a durability flush
  failure warn line from the goal-round-driver is captured by a logger
  exporter tap and fed in the same way. Both consume the same 4h x 4 can,
  breaker, and waves as network deaths.
- Tags the live nudge by cause (design §7.2(4)): stop causes tell the model
  to `update_goal action=resume` first (the nudge turn carries direct-human
  authority), while `TRANSPORT`/`TIMEOUT` keep the plain "continue".
- Writes a `stop-parked` evidence line — never a continuation — for excluded
  stops (design §7.1): `turn/end` abort (with its cancel kind),
  `interrupted`/`forked` lifecycle markers, and `goal/change` block or
  complete.
- Runs the ruled account before every revival: breaker first (a re-death
  within 10 minutes of a revival stops that session for good), then
  suspension, the 150k watermark, the wave hold, and the rolling 4h x 4
  chain quota.
- Holds sessions while a same-cause wave is open (2 or more identical error
  codes within 15 minutes) and releases them after 5 quiet minutes, with each
  revive spaced by the configured stagger and charged to its own chain.
- Serves `GET /api/session-revive/status` (loopback-only) with mode,
  counters, held/suspended/tripped state, and per-chain quota usage for
  post-restart verification and evidence review.

## Install

Local link install (this package is not published to npm):

```powershell
dsh plugin --profile <name> add link:<repo>/packages/dsh-session-revive
```

The single bundle row (`session-revive`) mounts the event listener, the wave
release timer, and the status route. Restart the Host (or rely on live patch
reload) to activate.

## Config

Plugin config as validated by the schemastery schema (defaults and clamps
live in one place in `src/config.ts`):

| field | type | default | meaning |
|-------|------|---------|---------|
| `enabled` | boolean | `true` | Master switch; `false` skips listeners, timers, and routes |
| `mode` | string (`shadow` or `live`) | `shadow` | `shadow` logs the full decision account and withholds only the send; `live` queues the nudge |
| `staggerMs` | number | `10000` | Minimum spacing between planned revivals; anything below `10000` clamps up to `10000` with a warning |

The ruled parameters are fixed by the design ruling and are not
configurable: a 4 hour window with 4 revivals per chain (only revive-class
deaths consume), a 10-minute breaker, a wave of 2 same-cause errors inside
15 minutes released after 5 minutes without a new same-cause error, and a
150000-token context watermark that parks instead of nudging. Wall-class
codes (the design list plus its `AUTH` and model-configuration families)
consume nothing and suspend the session until `resetsAt`.

Every decision is one line through the Host logger: the
`dsh-session-revive ` prefix followed by a single JSON object stamped with
the active `mode`.

## Security model

- The status route is loopback-only (RFC 5735 local addresses): remote
  sockets answer `403`, so session ids and counters never leave the machine.
- No credentials, no outbound network, and no files written: the plugin
  listens to in-process session events and, only in `live` mode, queues a
  text message to the errored session through the Host's own session
  controller.
- `shadow` (the default) performs zero sends, so a mounted-but-unconfigured
  plugin cannot disturb any session until someone deliberately sets
  `mode: 'live'`.

## Known limitations

- State is in-memory: breaker trips, suspensions, quota stamps, and wave
  holds reset when the Host restarts; the structured logs remain the durable
  evidence.
- Morning-report integration is not in place yet: breaker and skip evidence
  lives in the log stream, waiting for a reader.
- The `live` send path exists but has never run against a real session;
  flipping the switch belongs to a turn-on batch with its own verification.
- Sessions at or above the 150k watermark park for both human and bot
  classes: the bot relay branch lands with the relay line.
- Subagent child sessions are in scope (the design covers all sessions);
  their `session.header.origin` is logged as evidence and an exclusion knob
  is deferred to tuning.
- Mid-turn silent deaths emit no `turn/end` event and are not detected here
  (the watchdog chain is a separate line).
- Codes outside both lists (for example `RATE_LIMIT`, `PI_AI_ERROR`) neither
  revive nor suspend: only the design's wall enumeration parks a session.
- The durability stop cause couples to the goal-round-driver's exact warn
  wording (a regex over the logger stream); a driver wording change silently
  stops detection until the signature is updated.
- The first error of a forming wave is decided before the wave exists; if
  the network is already down, the breaker and the 4h x 4 quota bound the
  damage.
