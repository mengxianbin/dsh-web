/**
 * dsh-session-revive — shadow-first automatic session revival. A `turn/end`
 * error with a revive-class code (TRANSPORT/TIMEOUT) enters the ruled revival
 * account: rolling 4h x 4 quota per session chain, wall-class codes suspend
 * at zero cost until resetsAt, a 10-minute breaker stops a session that dies
 * again right after a revival, same-cause waves hold sessions until a 5-minute
 * quiet period then release them staggered, and the 1M context watermark
 * parks oversized sessions. Two stop causes join the same account per the
 * 2026-11-07 triage ruling (design §7): a `max-tokens` turn end (the provider
 * answered, the output was truncated) and the goal-round-driver's durability
 * flush failure warn (observed through a logger exporter tap) — both nudge
 * with a cause-tagged text telling the model to `update_goal action=resume`
 * first. Excluded causes (human abort, session resume/fork markers, goal
 * block/complete) are never continued — they only write a `stop-parked`
 * evidence line. Every detection and decision is one structured JSON log
 * line. Two stall probes join the same line shape (pure-worker-migration-1123
 * §三 缺项①②, design §7.4): owner-heartbeat staleness and turnOpen silence
 * emit `stall-detected`/`stall-cleared` readings feeding FSM E13 — evidence
 * only, no send, no kill. `mode: 'shadow'` (the default) suppresses only the send — the full
 * decision account still runs so the ruled parameters can be tuned against a
 * real night of logs; `mode: 'live'` queues the nudge through the host session
 * controller. Host-only package: no `dsh.client` face.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DURABILITY_WARN_RE,
  PARKED_TURN_END_REASONS,
  STAGGER_MIN_MS,
  Config,
  conditionOverrideNotice,
  nudgeTextFor,
  refineFailureCode,
  resolveConfig,
} from './config.ts'
import { MechanismHealth, readHostReviveHalted, removeReviveHealth } from './health-state.ts'
import { mountOnce } from './mount-once.ts'
import { RevivalPolicy, type PolicyRecord } from './policy.ts'
import { makeListRows, runBootSweep, type SweepListApi } from './sweep.ts'
import { dispatchNudge, type ChildHeaderFacts } from './delivery.ts'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { StallTracker, makeHeartbeatReader, ruledStallDeaths, type StallRecord } from './stall.ts'
import { makeStatusRoute } from './host/routes.ts'
import { attributeProbeFailure, probeRoute, type ProbeResult } from './v2-probe.ts'
import { ReviveV2Machine, type V2ArchiveReason, type V2Record } from './v2-machine.ts'
import { SETTINGS_READ_TTL_MS, makeTtlReader, planNudgeDelay, planProbeTimer, wakeDelayFor } from './v2-timers.ts'
import { ReviveV2StateWriter } from './v2-state.ts'
import { createLoopbackChainPorts, runArchiveRelayChain } from './v2-chain.ts'
import { runTranscriptFirstGate } from './v2-transcript.ts'

export const name = 'dsh-session-revive'
export const inject = ['webServer', 'sessionController']

export { Config }

/**
 * Structural view of the host session service for nudge sends: the real
 * controller brands requestId/sessionId, which this plugin mints as plain
 * strings (same projection dsh-session-dispatch casts).
 */
interface ReviveSessionApi {
  prompt(
    request: {
      requestId: string
      sessionId: string
      mode: 'queue'
      content: readonly { type: 'text'; text: string }[]
    },
    signal?: AbortSignal,
  ): Promise<unknown>
}

/**
 * Structural view of the raw persistence seam the boot sweep reads (same
 * projection style as `ReviveSessionApi`), whose branded ids this plugin
 * passes as plain strings. The list face lives in `sweep.ts` as
 * `SweepListApi`, declared against the envelope the controller returns.
 */
interface SweepPersistence {
  open(
    id: string,
    mode: 'read',
  ): Promise<{
    read(
      offset?: number,
      length?: number,
      options?: { signal?: AbortSignal },
    ): Promise<{ events: readonly SessionEvent[] }>
    close(): Promise<void>
  }>
}

// ── Revival v2: settings-derived route resolution and refusal detection ───

/** Best-effort settings service read: a hiccup resolves undefined, never throws. */
function readSettingsNamespace(
  ctx: Context,
  ns: 'llm-pi-ai' | 'llm-deepseek',
): Record<string, unknown> | undefined {
  try {
    const settings = ctx.get('settings') as
      | {
          get?(name: unknown): unknown
          describe?(options?: unknown): Array<{ ns: string; value: unknown }> | undefined
        }
      | undefined
    if (settings === undefined) return undefined
    if (typeof settings.get === 'function') {
      const value = settings.get(ns)
      if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
    }
    if (typeof settings.describe === 'function') {
      const descriptors = settings.describe({ redactSecrets: false })
      if (Array.isArray(descriptors)) {
        const match = descriptors.find(
          (d) =>
            d.ns === ns ||
            (ns === 'llm-pi-ai' && d.ns === 'llm' && typeof (d.value as { providers?: unknown } | undefined)?.providers === 'object') ||
            (ns === 'llm-deepseek' && (d.ns === 'llm-deepseek' || d.ns === 'llm-deepseek-api-key')),
        )
        if (match !== undefined && typeof match.value === 'object' && match.value !== null) {
          return match.value as Record<string, unknown>
        }
      }
    }
  } catch {
    // Never let a settings read throw into the probe loop or the gate.
  }
  return undefined
}

/** The official adapter's fallback endpoint when no baseURL is configured. */
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** DeepSeek-family provider ids (local predicate; no cross-package import). */
function isDeepSeekProvider(provider: string): boolean {
  return provider === 'deepseek' || provider.startsWith('deepseek-')
}

/**
 * Resolve a route's provider baseURL from the llm settings namespaces,
 * mirroring dsh-usage's `routeBaseUrl` (wall follows route, design section
 * five). Undefined means fail closed: the probe cannot run, so the session
 * parks until the settings name a path.
 */
function makeResolveBaseURL(
  ctx: Context,
): (route: { provider: string; model?: string }) => string | undefined {
  // Every scheduling pass resolves a route, and each unresolved namespace is a
  // full profile-directory scan; the TTL keeps those reads off the hot path
  // (a settings edit reaches the next probe round within one TTL anyway).
  const readPi = makeTtlReader(SETTINGS_READ_TTL_MS, () => readSettingsNamespace(ctx, 'llm-pi-ai'))
  const readDs = makeTtlReader(SETTINGS_READ_TTL_MS, () => readSettingsNamespace(ctx, 'llm-deepseek'))
  return (route) => {
    const pi = readPi()
    const providers = pi?.providers
    if (typeof providers === 'object' && providers !== null) {
      const entry = (providers as Record<string, unknown>)[route.provider]
      const baseURL = typeof entry === 'object' && entry !== null ? (entry as { baseURL?: unknown }).baseURL : undefined
      if (typeof baseURL === 'string' && baseURL.trim() !== '') return baseURL.trim()
    }
    if (isDeepSeekProvider(route.provider)) {
      const ds = readDs()?.baseURL
      if (typeof ds === 'string' && ds.trim() !== '') return ds.trim()
      return DEEPSEEK_DEFAULT_BASE_URL
    }
    return undefined
  }
}

/**
 * Structural refusal probe for one assistant message (design section three,
 * L2 half): the current dsh-llm surface carries no `finishReason`/`refusal`
 * field, so this reads the shapes that COULD carry one and returns false when
 * none is present - never firing on today's messages, never widening the
 * progress boolean on a guess.
 */
function structuralRefusal(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const candidate = message as {
    content?: unknown
    source?: { finishReason?: { kind?: unknown }; refusal?: unknown }
  }
  if (candidate.source?.finishReason?.kind === 'refusal') return true
  if (candidate.source?.refusal === true) return true
  const content = candidate.content
  if (Array.isArray(content)) {
    return content.some((block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'refusal')
  }
  return false
}

/**
 * Mount the plugin: subscribe to session events, run the policy, log every
 * decision, and serve the loopback status endpoint. Routes and listeners ride
 * one cordis effect so fiber disposal tears everything down.
 */
export const apply = mountOnce('dsh-session-revive', (ctx: Context, config?: Config): void => {
  const validated = Config(config)
  if (validated.enabled === false) {
    // 拍板⑮: disabled = the face disappears, not turns bad — drop any ledger
    // a previous run left behind (the reader then sees 未接线, never a stale green).
    removeReviveHealth()
    return
  }
  const resolved = resolveConfig(validated, (raw, clamped) => {
    ctx.logger.warn(
      `dsh-session-revive: staggerMs ${raw} is below the ${STAGGER_MIN_MS} ms design floor; clamped to ${clamped}`,
    )
  })
  // 拍板账⑨: a condition-list override is loud at startup — the effective
  // lists and the ruled defaults print side by side so drift shows on boot.
  const overrideNotice = conditionOverrideNotice(resolved)
  if (overrideNotice !== undefined) ctx.logger.warn(overrideNotice)
  ctx.effect(() => {
    const policy = new RevivalPolicy({
      staggerMs: resolved.staggerMs,
      conditions: resolved.conditions,
      conditionOverrides: resolved.conditionOverrides,
    })
    const sessions = ctx.sessionController as unknown as ReviveSessionApi
    const abort = new AbortController()
    const sendTimers = new Set<ReturnType<typeof setTimeout>>()
    /** Anti-herd anchor: when the previous nudge will actually fire (see planNudgeDelay). */
    let lastNudgeAt = 0
    let wakeTimer: ReturnType<typeof setTimeout> | undefined

    // Child-session header index (design 件1): only `origin=subagent` rows are
    // retained — captured from the boot list rows (both listRows consumers)
    // and from any live event the child emits. Send dispatch reads it to
    // route through the parent-authorized delivery seam instead of the fenced
    // generic prompt (围栏零改 — the fence itself is never touched).
    const childHeaders = new Map<string, ChildHeaderFacts>()
    const noteHeader = (sessionId: string, header: ChildHeaderFacts): void => {
      if (header.origin === 'subagent' && !childHeaders.has(sessionId)) {
        childHeaders.set(sessionId, {
          origin: 'subagent',
          ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
        })
      }
    }
    const noticeRow = (row: { readonly sessionId: string; readonly origin?: 'subagent'; readonly parentSessionId?: string }): void => {
      noteHeader(String(row.sessionId), { origin: row.origin, parentSession: row.parentSessionId })
    }

    // One structured JSON line per record, stamped with the active mode so a
    // grep can split shadow evidence from live sends. v2 machine records ride
    // the same line shape (kind `v2-*`).
    const log = (record: PolicyRecord | V2Record): void => {
      ctx.logger.info(`dsh-session-revive ${JSON.stringify({ mode: resolved.mode, ...record })}`)
    }

    // ── Stall probes (pure-worker-migration-1123 §三 缺项①②, design §7.4) ──
    // The two watchdog death causes absorbed into revive before the boss
    // retires: owner-heartbeat staleness (15 min grace, dual-name checkpoint
    // read) and turnOpen silence (30 min, turnOpen 第二轴). Evidence-first —
    // each crossing logs one `stall-detected` reading (next: E13, the FSM
    // 断链 event this death feeds), each recovery one `stall-cleared`; no
    // send, no kill, no quota/breaker/wave state. One deadline-armed timer
    // below is the only scheduling this adds.
    const stall = new StallTracker(
      { heartbeatGraceMs: resolved.stall.heartbeatGraceMs, turnOpenStallMs: resolved.stall.turnOpenMs },
      makeHeartbeatReader(resolved.stall.heartbeatPath),
      () => Date.now(),
    )
    const logStall = (records: readonly StallRecord[]): void => {
      for (const record of records) log(record)
    }
    /** One timer for the earliest stall deadline; event passes re-arm it. */
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    let stallDeadline = 0
    const armStall = (): void => {
      if (!resolved.stall.watch) return
      const deadline = stall.nextCheckAt()
      // Already armed at or before the needed time: keep the earlier wake
      // (the sweep re-arms); only an EARLIER deadline replaces the timer.
      if (stallTimer !== undefined && stallDeadline <= deadline) return
      if (stallTimer !== undefined) clearTimeout(stallTimer)
      stallDeadline = deadline
      stallTimer = setTimeout(() => {
        stallTimer = undefined
        const at = Date.now()
        const stallRecords = stall.sweep(at)
        // Evidence-first: the readings land regardless of what follows.
        logStall(stallRecords)
        // 件3 案 A (ask `case3-pick` 2026-11-24): turn-open-stall 越线即按四闸发 —
        // same death→gates→send account as an error death; owner-heartbeat-stall
        // keeps its evidence-only half (narrow exemption ask `subprocess-exempt`).
        for (const death of ruledStallDeaths(stallRecords)) {
          const origin = childHeaders.get(death.sessionId)?.origin
          applyV2(machine.onDeath({ sessionId: death.sessionId, at }))
          applyRecords(
            policy.onStall({ sessionId: death.sessionId, at, ...(origin === undefined ? {} : { origin }) }),
          )
          armWake()
        }
        armStall()
      }, Math.max(0, deadline - Date.now()))
    }
    armStall()
    // Mount seeding: a turn already open before this plugin mounted still
    // counts — the boot sweep's tier-1 checkpoint projection names it, and
    // the silence clock starts at seed time (never retroactive).
    if (resolved.stall.watch) {
      void makeListRows(ctx.sessionController as unknown as SweepListApi, noticeRow)(abort.signal)
        .then((rows) => {
          for (const row of rows) {
            const boundary = row.projections?.values.turnBoundary as { openTurnStartSeq?: number | null } | undefined
            if (typeof boundary?.openTurnStartSeq === 'number' && Number.isFinite(boundary.openTurnStartSeq)) {
              stall.seedTurn(String(row.sessionId), Date.now())
            }
          }
          armStall()
          return rows
        })
        .catch((error: unknown) => {
          // Seed failure only costs the pre-mount turn coverage; the heartbeat
          // probe and every event-driven turn still run (fail soft, loud line).
          log({ kind: 'log', at: Date.now(), event: 'stall-seed-failed', detail: { error: String(error).slice(0, 300) } })
          armStall()
        })
    }

    // 拍板⑮: five-fact mechanism health (插件激活 / mode=live / status 端点
    // 可读 / 断路器无连跳 / 无 HALT). The status builder is shared with the
    // route so 「端点可读」tests the exact payload the endpoint serves; the
    // ledger writes only when a fact flips (事件驱动, 正常近零写入).
    const statusPayload = (): Record<string, unknown> => ({ mode: resolved.mode, ...policy.snapshot(Date.now()) })
    const health = new MechanismHealth({
      mode: resolved.mode,
      readStatus: () => {
        statusPayload()
        return 'ok'
      },
      readHalted: readHostReviveHalted,
    })

    // ── Revival v2 (design session-revival-v2-alert-inbox-1116) ─────────────
    // 施工第一步, fail-closed 首核: an archived session's transcript must still
    // decode before ANY revival attempt may exist. The verdict is evaluated
    // once at mount; while it fails, every v2 entry point logs only a halt
    // record and nothing can be sent.
    const firstGate = runTranscriptFirstGate()
    const machine = new ReviveV2Machine({
      gate: firstGate,
      resolveBaseURL: makeResolveBaseURL(ctx),
    })
    const v2Writer = new ReviveV2StateWriter()
    const chainPorts = createLoopbackChainPorts({ apiBase: `http://127.0.0.1:${ctx.webServer.port}` })
    ctx.logger[firstGate.ok ? 'info' : 'warn'](
      `dsh-session-revive-v2 first gate ${firstGate.ok ? 'PASS' : 'FAIL'}: ${firstGate.detail}` +
        (firstGate.ok ? '' : ' - revival attempts stay halted until this proves readable'),
    )

    let v2WakeTimer: ReturnType<typeof setTimeout> | undefined
    let probeTimer: ReturnType<typeof setTimeout> | undefined
    let probeTimerImmediate = false
    let probeRoundInFlight = false

    // The machine's deferred deadlines (cooldown, stagger plan) drive one
    // timer; every state change re-arms it.
    const armV2Wake = (): void => {
      if (v2WakeTimer !== undefined) {
        clearTimeout(v2WakeTimer)
        v2WakeTimer = undefined
      }
      const deadline = machine.nextWakeAt()
      if (deadline === null) return
      // An overdue deadline (release blocked on a red route) retries at 1 Hz
      // instead of re-arming at 0 ms - that 0 ms loop is what pegged the host
      // main thread on 2026-11-17.
      v2WakeTimer = setTimeout(
        () => {
          v2WakeTimer = undefined
          applyV2(machine.releaseDue(Date.now()))
        },
        wakeDelayFor(deadline, Date.now()),
      )
    }

    // Event-driven probe scheduling (design section five): probes run only
    // while a session is parked, immediately when a route has no cached
    // result, otherwise on the randomised 60-120s cadence. Zero parked
    // sessions means zero timers - the loop goes silent by construction.
    const armProbeLoop = (): void => {
      const targets = machine.routesNeedingProbe(Date.now())
      const plan = planProbeTimer(
        probeTimer === undefined ? undefined : { immediate: probeTimerImmediate },
        targets,
      )
      if (plan.action === 'keep') return
      if (probeTimer !== undefined) {
        clearTimeout(probeTimer)
        probeTimer = undefined
        probeTimerImmediate = false
      }
      if (plan.action === 'clear') return
      probeTimerImmediate = plan.delay === 0
      probeTimer = setTimeout(
        () => {
          probeTimer = undefined
          probeTimerImmediate = false
          void runProbeRound()
        },
        plan.delay,
      )
    }

    // One probe round over every route with a parked session, through the
    // GLOBAL fetch slot (same egress as real requests). A connection-layer
    // failure is attributed through L1 - attribution only, never permission.
    const runProbeRound = async (): Promise<void> => {
      if (probeRoundInFlight) return
      probeRoundInFlight = true
      try {
        for (const target of machine.routesNeedingProbe(Date.now())) {
          let result: ProbeResult
          if (target.baseURL === undefined) {
            result = { ok: false, error: 'route base URL unresolved', attribution: 'route-unresolved' }
          } else {
            // Sequential by design: one probe at a time through the global
            // fetch slot (the in-flight guard owns the cadence, not latency).
            // eslint-disable-next-line no-await-in-loop
            result = await probeRoute(target.baseURL)
            if (!result.ok && result.attribution === undefined) {
              // eslint-disable-next-line no-await-in-loop
              result = { ...result, attribution: await attributeProbeFailure() }
            }
          }
          applyV2(machine.onProbeResult(target.provider, result))
        }
      } finally {
        probeRoundInFlight = false
        armProbeLoop()
      }
    }

    // The archive-relay chain (design section four, order never reversed):
    // verify transcript -> resolve spawn target -> archive -> spawn relay ->
    // rewrite the ledger reason. Only live mode runs it; shadow feeds back a
    // withheld result so the evidence line still closes the loop.
    const runChain = (sessionId: string, reason: V2ArchiveReason): void => {
      if (resolved.mode !== 'live') {
        applyV2(machine.onChainResult({ sessionId, ok: false, detail: 'shadow-withheld' }))
        return
      }
      void runArchiveRelayChain({ sessionId, reason, ports: chainPorts })
        .then((outcome) => {
          applyV2(
            machine.onChainResult({
              sessionId,
              ok: outcome.ok,
              ...(outcome.relaySessionId === undefined ? {} : { relaySessionId: outcome.relaySessionId }),
              detail: outcome.detail,
            }),
          )
          return outcome
        })
        .catch((error: unknown) => {
          applyV2(machine.onChainResult({ sessionId, ok: false, detail: String(error).slice(0, 200) }))
        })
    }

    // One pass over a batch of machine records: log every record, execute the
    // two side effects (send, chain) only in live mode, then persist the
    // section-seven export change-only and re-arm the machine's timers.
    const applyV2 = (records: V2Record[]): void => {
      for (const record of records) {
        log(record)
        if (record.kind === 'v2-attempt') {
          if (resolved.mode === 'live') sendNudge(record.sessionId, record.fireAt, record.code)
          else machine.onAttemptWithheld(record.sessionId)
        } else if (record.kind === 'v2-archive-relay') {
          runChain(record.sessionId, record.reason)
        }
      }
      v2Writer.sync(machine.stateSnapshot())
      armV2Wake()
      armProbeLoop()
    }

    const sendNudge = (sessionId: string, plannedAt: number, code?: string): void => {
      // Anti-herd (2026-11-12 ruling): a deferred batch released after its
      // plannedAt collapsed must still space its sends by the ruled stagger.
      const plan = planNudgeDelay(plannedAt, lastNudgeAt, resolved.staggerMs, Date.now())
      lastNudgeAt = plan.lastNudgeAt
      const text = nudgeTextFor(code)
      const timer = setTimeout(() => {
        sendTimers.delete(timer)
        void dispatchNudge(sessionId, text, {
          header: (id) => childHeaders.get(id),
          liveParent: (parentId) => (ctx.get('agents') as { get(id: string): unknown } | undefined)?.get(parentId),
          runtime: () => ctx.get('subagents'),
          prompt: async (targetId, body) => {
            await sessions.prompt(
              {
                requestId: `session-revive-${randomUUID()}`,
                sessionId: targetId,
                mode: 'queue',
                content: [{ type: 'text', text: body }],
              },
              abort.signal,
            )
          },
          deliver: async (parent, childId, body) => {
            const runtime = ctx.get('subagents') as Parameters<typeof queueHostSubagentPrompt>[0] | undefined
            if (runtime === undefined) throw new Error('subagents runtime unavailable')
            await queueHostSubagentPrompt(
              runtime,
              parent as Parameters<typeof queueHostSubagentPrompt>[1],
              childId as Parameters<typeof queueHostSubagentPrompt>[2],
              [{ type: 'text', text: body }] as Parameters<typeof queueHostSubagentPrompt>[3],
              { kind: 'user', rpcId: `session-revive-${randomUUID()}` } as Parameters<typeof queueHostSubagentPrompt>[4],
              abort.signal,
            )
          },
          sent: () => {
            log({ kind: 'log', at: Date.now(), event: 'nudge-sent', sessionId, ...(code === undefined ? {} : { detail: { cause: code } }) })
          },
          failed: (_id, error) => {
            // Attempted and rejected: clear the machine's in-flight marker so
            // the next decision can re-gate (a stuck marker would deny forever).
            machine.onAttemptWithheld(sessionId)
            log({
              kind: 'log',
              at: Date.now(),
              event: 'nudge-failed',
              sessionId,
              detail: { error: String(error).slice(0, 300), ...(code === undefined ? {} : { cause: code }) },
            })
          },
          unsendable: (_id, reason) => {
            // Pre-send intercept (件1 fail-closed): no attempt, no fence probe.
            machine.onAttemptWithheld(sessionId)
            log({
              kind: 'log',
              at: Date.now(),
              event: 'stall-unsendable',
              sessionId,
              detail: { reason, ...(code === undefined ? {} : { cause: code }) },
            })
          },
        })
      }, plan.delay)
      sendTimers.add(timer)
    }

    const applyRecords = (records: PolicyRecord[]): void => {
      for (const record of records) {
        log(record)
        // 拍板⑮: a breaker trip feeds the mechanism-health streak; the sync
        // below re-evaluates the five facts right after this record batch
        // (a write lands only when a fact actually flipped).
        if (record.kind === 'breaker' && record.event === 'trip') health.noteTrip()
      }
      health.sync()
      // v2 探针门 (design section two): EVERY revive decision - live and
      // shadow alike - must clear the three-triage machine first; only a
      // granted attempt is ever sent, and only in live mode. The ruled
      // account above stays the quota source; this gate only withholds.
      for (const record of records) {
        if (record.kind === 'decision' && record.action === 'revive') {
          applyV2(
            machine.onReviveDecision({
              sessionId: record.sessionId,
              at: Date.now(),
              plannedAt: record.plannedAt ?? Date.now(),
              ...(record.code === undefined ? {} : { code: record.code }),
            }),
          )
        }
      }
    }

    // One timer for the earliest wave cooldown; every state change re-arms it.
    const armWake = (): void => {
      if (wakeTimer !== undefined) {
        clearTimeout(wakeTimer)
        wakeTimer = undefined
      }
      const deadline = policy.nextWakeAt()
      if (deadline === null) return
      wakeTimer = setTimeout(
        () => {
          wakeTimer = undefined
          applyRecords(policy.releaseDue(Date.now()))
          armWake()
        },
        Math.max(0, deadline - Date.now()),
      )
    }

    /**
     * Log a parked stop: an excluded cause the ruling says never to continue
     * (design §7.1). Evidence only — no policy state, no quota, no send.
     */
    const park = (at: number, sessionId: string, cause: string, detail?: Record<string, unknown>): void => {
      log({ kind: 'log', at, event: 'stop-parked', sessionId, detail: { cause, ...detail } })
    }

    const offEvent = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const sessionId = String(session.id)
      // Child index (件1): a live child's first event captures its header facts.
      noteHeader(sessionId, session.header)
      // Stall probes ride this same stream: turn boundaries open/close and
      // every event refreshes a silence clock; the armed timer does the rest.
      logStall(stall.onEvent(sessionId, event.type, typeof event.time === 'number' ? event.time : Date.now()))
      armStall()
      if (event.type === 'turn/end') {
        const at = typeof event.time === 'number' ? event.time : Date.now()
        const reason = event.data.reason
        if (reason.kind === 'error') {
          const origin = session.header.origin
          // 拍板⑩: the folded request header is the route the failing request
          // used — the wall route a later `model/selection` is compared against.
          const header = session.requestHeader()
          // v2: the death first triages any in-flight attempt by its ACTUAL
          // form (section three); the revive decision below is then re-gated
          // by the machine in applyRecords.
          applyV2(
            machine.onDeath({
              sessionId,
              at,
              ...(header === undefined
                ? {}
                : { route: { provider: header.config.provider, model: header.config.model } }),
            }),
          )
          applyRecords(
            policy.onError({
              sessionId,
              // 拍板⑬: the harness folds a provider content_filter stop into
              // PI_AI_ERROR with the cause only in the message; refine it back
              // before the ruled lists classify.
              code: refineFailureCode(reason.error.code, reason.error.message),
              ...(reason.error.providerRetryAfterMs === undefined
                ? {}
                : { providerRetryAfterMs: reason.error.providerRetryAfterMs }),
              at,
              ...(typeof origin === 'string' ? { origin } : {}),
              ...(header === undefined
                ? {}
                : { route: { provider: header.config.provider, model: header.config.model } }),
            }),
          )
          armWake()
          return
        }
        if (reason.kind === 'max-tokens') {
          // Stop cause (design §7.2): the provider answered — the turn ran to
          // the output ceiling — so a stale wall loses its subject first; the
          // truncation then enters the same revival account as a death.
          for (const record of policy.onSuccess(sessionId, at)) log(record)
          // v2: the provider answered, so the in-flight attempt (if any)
          // triages by its observed form; with no attempt this only supersedes
          // any deferred decision the new revive decision will re-gate.
          applyV2(machine.onDeath({ sessionId, at }))
          const origin = session.header.origin
          applyRecords(
            policy.onError({
              sessionId,
              code: 'max-tokens',
              at,
              ...(typeof origin === 'string' ? { origin } : {}),
            }),
          )
          armWake()
          return
        }
        // Excluded stop causes (design §7.1): evidence line, never continued.
        // v2: an externally cut turn has no attempt outcome to triage - clear
        // the in-flight marker (state only) so the next decision can re-gate;
        // the counters stay untouched (an abort is neither success nor failure).
        if (reason.kind === 'aborted') {
          park(at, sessionId, 'human-abort', { cancel: reason.reason.kind })
          machine.onAttemptWithheld(sessionId)
          for (const record of policy.onSuccess(sessionId, at)) log(record)
          return
        }
        if (PARKED_TURN_END_REASONS.has(reason.kind)) {
          park(at, sessionId, reason.kind)
          machine.onAttemptWithheld(sessionId)
          for (const record of policy.onSuccess(sessionId, at)) log(record)
          return
        }
        for (const record of policy.onSuccess(sessionId, at)) log(record)
        // v2 section three, last row: a completed turn clears every counter.
        applyV2(machine.onSuccessTurn(sessionId, at))
        // 拍板⑮: a completed turn clears the breaker-streak fact.
        health.noteCompleted()
        health.sync()
        return
      }
      if (event.type === 'assistant/message') {
        const usage = event.data.usage
        if (usage !== undefined) {
          policy.recordUsage(sessionId, usage.inputTokens + (usage.cacheReadTokens ?? 0))
        }
        // v2: fold spend into the in-flight attempt and the episode, and
        // record the output half of the progress boolean (state only - a
        // session outside revival has no entry and stays without one).
        machine.onAssistant(
          sessionId,
          usage === undefined
            ? { refusal: structuralRefusal(event.data.message) }
            : {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens ?? 0,
                refusal: structuralRefusal(event.data.message),
              },
        )
        return
      }
      // v2 progress boolean: a model-requested tool is the L1 half, a tool
      // result that landed WITHOUT an internal error is the L2 half.
      if (event.type === 'tool/call') {
        machine.onActivity(sessionId, 'tool-call')
        return
      }
      if (event.type === 'tool/result') {
        if (event.data.error === undefined) machine.onActivity(sessionId, 'tool-ok')
        return
      }
      // 拍板⑩ 墙随路由走: a durable route switch releases a wall suspension
      // and rejoins the flow as a revive-class death (auto-route's `switch`
      // lands as this event; the revive plugin stays the single nudge hand,
      // so the quota account has exactly one writer).
      if (event.type === 'model/selection') {
        const at = typeof event.time === 'number' ? event.time : Date.now()
        const { provider, model } = event.data
        // v2: the durable route names the fallback the probe loop targets.
        machine.setRoute({ provider, model })
        applyRecords(policy.onModelSelection({ sessionId, provider, model, at }))
        armWake()
        return
      }
      // Durable goal lifecycle: block/complete are parked stops (design §7.1).
      // Structural narrowing: `goal/change` is declared by the harness goal
      // package's module augmentation, which this package does not link — the
      // event still arrives on the session stream, so match by literal and
      // view the payload shape structurally.
      if ((event.type as string) === 'goal/change') {
        const at = typeof event.time === 'number' ? event.time : Date.now()
        const change = event.data as unknown as {
          operation?: string
          goal?: { blockedReason?: { code?: string; message?: string } }
        }
        if (change.operation === 'block') {
          park(at, sessionId, 'goal-blocked', {
            code: change.goal?.blockedReason?.code,
            message: change.goal?.blockedReason?.message,
          })
          // v2: a goal stop is excluded from the account - clear any in-flight
          // attempt marker so a later decision can re-gate.
          machine.onAttemptWithheld(sessionId)
          return
        }
        if (change.operation === 'complete') {
          park(at, sessionId, 'goal-complete')
          machine.onAttemptWithheld(sessionId)
          return
        }
      }
    })
    const offDisposed = ctx.on('session/disposed', (session: Session) => {
      logStall(stall.onDisposed(String(session.id)))
      armStall()
      policy.forget(String(session.id))
      // v2: the session is gone - drop its in-flight attempt and deferred
      // decision; the account (counters, export row) survives disposal.
      machine.onDisposed(String(session.id))
    })
    /**
     * Durability stop-cause tap (design §7.1): when goal-round-driver's
     * checkpoint flush fails it warns and disarms — a silent goal death no
     * `turn/end` reports. The driver logs through the shared logger, so a
     * logger exporter observes the exact warn line and feeds it into the same
     * revival account. `levels.default = 2` (LoggerLevel.WARN) passes
     * error+info+warn and drops debug; the regex does the rest.
     */
    const offTap = ctx.logger.exporter({
      levels: { default: 2 },
      export: (message) => {
        if (message.type !== 'warn') return
        try {
          const text = Array.isArray(message.args) ? message.args.map(String).join(' ') : ''
          const hit = DURABILITY_WARN_RE.exec(text)
          if (hit === null) return
          const at = typeof message.ts === 'number' ? message.ts : Date.now()
          applyRecords(policy.onError({ sessionId: hit[1], code: 'durability-flush', at }))
          armWake()
        } catch {
          // A broken tap must never take down the logger pipeline.
        }
      },
    })
    const disposeRoute = ctx.webServer.register(makeStatusRoute(statusPayload))
    armWake()
    // 拍板⑮: initial publish — the state change from absent to present.
    health.sync()

    // 拍板⑪ boot sweep: at activation the plugin actively scans for orphan
    // turns instead of waiting for events — the `interrupted` closer only
    // lands at the next resume, so an idle killed session never emits one
    // (design §4.2 条3). Confirmed orphans are attributed to the restart
    // (only process death leaves a turn open) and wake through this same
    // applyRecords/sendNudge path: staggered, breaker-armed, watermark-
    // checked, and quota-exempt (status counters/quota 零增).
    void runBootSweep({
      listRows: makeListRows(ctx.sessionController as unknown as SweepListApi, noticeRow),
      readEvents: async (sessionId, signal) => {
        // Resolved per read, not at activation: sessionPersistence is not in
        // this plugin's inject graph, so an eager capture could bind before
        // the backend constructs and stay undefined for the whole boot.
        const persistence = ctx.get('sessionPersistence') as SweepPersistence | undefined
        if (persistence === undefined) throw new Error('sessionPersistence unavailable')
        const handle = await persistence.open(sessionId, 'read')
        try {
          const { events } = await handle.read(undefined, undefined, { signal })
          return events
        } finally {
          await handle.close()
        }
      },
      isAttached: (sessionId) => (ctx.get('agents') as { get(id: string): unknown } | undefined)?.get(sessionId) !== undefined,
      seedRoute: (sessionId, route) => machine.seedRoute(sessionId, route),
      decide: (sessionId, at, contextTokens) => {
        // Fold the orphan's last observed usage first so the 1M watermark
        // gate actually bounds this revival (an unknown watermark adds no
        // boundary, per the design).
        if (contextTokens !== undefined) policy.recordUsage(sessionId, contextTokens)
        return policy.onBootSweep({ sessionId, at })
      },
      apply: applyRecords,
      log,
      now: () => Date.now(),
      signal: abort.signal,
    }).catch((error: unknown) => {
      // runBootSweep contains its own failure lines; this only catches a
      // failing evidence logger during shutdown.
      try {
        log({
          kind: 'log',
          at: Date.now(),
          event: 'boot-sweep-failed',
          detail: { stage: 'shell', error: String(error).slice(0, 300) },
        })
      } catch {
        // Never let the sweep's own reporting break plugin teardown.
      }
    })

    return () => {
      try {
        offEvent()
      } catch {
        // Listener already gone during shutdown.
      }
      try {
        offDisposed()
      } catch {
        // Listener already gone during shutdown.
      }
      try {
        offTap()
      } catch {
        // Exporter already gone during shutdown.
      }
      if (wakeTimer !== undefined) clearTimeout(wakeTimer)
      if (v2WakeTimer !== undefined) clearTimeout(v2WakeTimer)
      if (probeTimer !== undefined) clearTimeout(probeTimer)
      if (stallTimer !== undefined) clearTimeout(stallTimer)
      for (const timer of sendTimers) clearTimeout(timer)
      sendTimers.clear()
      abort.abort()
      // 拍板⑮: unload removes the ledger — 停用 = 面消失, not 面变坏.
      health.dispose()
      try {
        disposeRoute()
      } catch {
        // Route fiber already gone during shutdown.
      }
    }
  }, 'dsh-session-revive: revival policy')
})
