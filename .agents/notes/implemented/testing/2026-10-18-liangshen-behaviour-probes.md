# Agent Note: Behaviour probes measure the process, not just the score

Status: implemented

Pairs with [the dispatcher rules maintained in place](../architecture/2026-10-18-liangshen-dispatcher-rules-maintained-in-place.md), whose changes it exists to test; extends [the request-surface catalog and eval tooling](2026-09-13-liangshen-request-surface-catalog-and-eval-tooling.md).

## Problem

The package already ran a live matrix, and its own report reached a defensible-looking conclusion: five arms, 15/15 passing, "the persona has no measurable effect". The sample was three tasks per arm with one repetition, which the report itself flagged, and every measure it took was an outcome measure — pass rate, tool calls, tokens, cost, duration.

That combination cannot see the failures this mode actually has. A session can pass every task while having taken the strictest reading of an under-specified rule, spent its per-cycle quota on checks that could not fail, let a low-priority backlog run to escalation, and planned its own call budget until nothing was left to submit. None of those move a pass rate; all of them are the difference between a dispatcher that works and one that only looks like it does. The evidence for that shape came from outside this repository, and it is uncomfortable for a reason worth recording: the same session also scored well on standard tasks, so a benchmark made of standard tasks would have cleared it.

The matrix also had no way to state what a probe means. Without an oracle and a pair of scripted policies, "the model scored 60" says nothing about whether 60 is the good or the bad end of the range the environment allows.

## Decision

Four small deterministic environments, one per behaviour, each shipped with an oracle and two scripted policies, in `packages/dsh-liangshen/tools/probes/`.

- **prior-override** — a junction simulator whose rule says a cycle allows "at most 2 checks". The simulator counts check calls, so one call carrying three movements is legal and admits three. Reading it as "2 movements" tops out at 8 admitted; spending one call to test the reading reaches 12. The probe grades the outcome and records whether the reading was ever tested. One admission per cycle, because without that cap a session can reopen a second batch and reach the ceiling without testing anything — found the first time the probe ran against a real session, which scored 24.
- **refresh-quota** — a release scheduler with two dry runs per cycle, reset every cycle. Drying the whole backlog always conflicts, teaches nothing, and the cycle is spent holding; one small batch reveals the lane rule and three jobs fit. Records served, holds, and quota utilisation, so hoarding and useless checks are distinguishable.
- **oncall-backlog** — twelve alerts, two handled per step, ten steps, and a P3 that escalates if nobody looks at it. A severity-first sweep ends with a clean P1 board and six escalations; a deadline-first sweep ends with none. This is the one rule change with a direct behavioural target: the per-turn sweep.
- **budget-ledger** — twenty services, one fault, twelve calls, and the real used/remaining count printed on every result. A full sweep does not fit; the fault is reachable in four calls. Records whether it submitted, with how much left.

`tools/probe-selftest.mjs` runs both scripted policies through each environment and asserts that the good one passes, the bad one fails, and the named metric moves in the stated direction. It costs nothing and runs in seconds, so a probe that cannot discriminate is caught before any model is charged. `tests/probe-selftest.test.ts` wraps it as a gate.

The corpus ships as `tools/tasks/liangshen-v41-probes.json`, whose tasks carry `from` (a directory plus support files, materialised into the workspace) instead of inline `files`, because a probe is a small program and inlining it into JSON would make it unreviewable. A task may also carry `metrics`: the same program shape as `check`, printing one JSON object of numbers, recorded beside the verdict and aggregated per group by `benchmark-report.mjs` into its own table. The two columns are deliberately separate — the point of a probe is that they can disagree.

The runner needed two repairs before any probe could run at all under DSH 0.2.1, and both are recorded here because a suite that silently records four failed sessions reads exactly like four failing probes. The variant patch no longer disables `headless-startup`: it publishes the `headlessStartup` provider that `sandbox-policy` and the agent-plane rows inject, so disabling it leaves every dependent row waiting for a service that can never appear and the preset never mounts. The patch also re-enables the `credentials` row, which 0.2.1 disables in the headless bundle, turning each request into an immediate authentication failure. With both rows corrected the shipped arm completes a real session (four tool calls, one file written, 91,941 tokens) instead of returning in 1.8 s with zero usage.

`benchmark-live-run.mjs` also gained `--route provider/model[/effort]`. The default stays the fixed route so an aggregated comparison still reads one route per report; a probe run may name the route the operator actually uses, which is the only reading that says anything about that operator's sessions.

## Alternatives considered

- Port the external driving benchmark wholesale. Rejected: its environment rewards aggressive trial and error, and importing that incentive would measure this mode against a game it is not playing. Each probe isolates one behaviour with an oracle whose good and bad ends are computable.
- Grade behaviour from the reasoning text. Rejected: the durable session log does not always carry reasoning text (a provider may persist a signed block with an empty body), and the wording counters that do survive can move opposite to behaviour — "let me check" rises while real checks fall.
- Extend the existing standard-task matrix instead. Rejected: standard tasks were measured to be exactly the ones that cannot show this. They stay, as the control.

## Consequences

- The mode has four behavioural targets with numbers attached, and a rule change can be judged on the number it was meant to move instead of on a pass rate that was already 100%.
- Four more live sessions per arm per repetition; the probes are small, so a full pass costs far less than one matrix row.
- The probes are deterministic and offline, so a regression in an oracle fails the free gate rather than a paid run.
- One risk accepted: a probe environment is authored by the same repository that authors the rules, so it can be softened. The scripted bad policy is the defence — it must keep failing.
- `--route` can only name a provider the headless composition registers. A provider that only the web profile mounts fails without a message: the turn completes, the run records zero usage, and every probe reads as a failure. Check `totalTokens` before believing a probe result.

## Testing

- `node tools/probe-selftest.mjs` — all four probes separate their policies (admitted 12 vs 8; served 24 vs 0; escalations 0 vs 6; submitted 1 vs 0).
- `pnpm vitest run` in the package — the selftest gate plus the existing matrix, report, and composition suites.
