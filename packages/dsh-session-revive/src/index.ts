/**
 * dsh-session-revive — shadow-first automatic session revival. A `turn/end`
 * error with a revive-class code (TRANSPORT/TIMEOUT) enters the ruled revival
 * account: rolling 4h x 4 quota per session chain, wall-class codes suspend
 * at zero cost until resetsAt, a 10-minute breaker stops a session that dies
 * again right after a revival, same-cause waves hold sessions until a 5-minute
 * quiet period then release them staggered, and the 150k context watermark
 * parks oversized sessions. Two stop causes join the same account per the
 * 2026-11-07 triage ruling (design §7): a `max-tokens` turn end (the provider
 * answered, the output was truncated) and the goal-round-driver's durability
 * flush failure warn (observed through a logger exporter tap) — both nudge
 * with a cause-tagged text telling the model to `update_goal action=resume`
 * first. Excluded causes (human abort, session resume/fork markers, goal
 * block/complete) are never continued — they only write a `stop-parked`
 * evidence line. Every detection and decision is one structured JSON log
 * line. `mode: 'shadow'` (the default) suppresses only the send — the full
 * decision account still runs so the ruled parameters can be tuned against a
 * real night of logs; `mode: 'live'` queues the nudge through the host session
 * controller. Host-only package: no `dsh.client` face.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from 'schemastery'
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
import { mountOnce } from './mount-once.ts'
import { RevivalPolicy, type PolicyRecord } from './policy.ts'
import { makeListRows, runBootSweep, type SweepListApi } from './sweep.ts'
import { makeStatusRoute } from './host/routes.ts'

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

/**
 * Mount the plugin: subscribe to session events, run the policy, log every
 * decision, and serve the loopback status endpoint. Routes and listeners ride
 * one cordis effect so fiber disposal tears everything down.
 */
export const apply = mountOnce('dsh-session-revive', (ctx: Context, config?: Config): void => {
  const validated = Config(config)
  if (validated.enabled === false) return
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
    let wakeTimer: ReturnType<typeof setTimeout> | undefined

    // One structured JSON line per record, stamped with the active mode so a
    // grep can split shadow evidence from live sends.
    const log = (record: PolicyRecord): void => {
      ctx.logger.info(`dsh-session-revive ${JSON.stringify({ mode: resolved.mode, ...record })}`)
    }

    const sendNudge = (sessionId: string, plannedAt: number, code?: string): void => {
      const delay = Math.max(0, plannedAt - Date.now())
      const text = nudgeTextFor(code)
      const timer = setTimeout(() => {
        sendTimers.delete(timer)
        void sessions
          .prompt(
            {
              requestId: `session-revive-${randomUUID()}`,
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text }],
            },
            abort.signal,
          )
          .then(() => {
            log({ kind: 'log', at: Date.now(), event: 'nudge-sent', sessionId, ...(code === undefined ? {} : { detail: { cause: code } }) })
          })
          .catch((error: unknown) => {
            log({
              kind: 'log',
              at: Date.now(),
              event: 'nudge-failed',
              sessionId,
              detail: { error: String(error).slice(0, 300), ...(code === undefined ? {} : { cause: code }) },
            })
          })
      }, delay)
      sendTimers.add(timer)
    }

    const applyRecords = (records: PolicyRecord[]): void => {
      for (const record of records) log(record)
      // Shadow gate: the account above is complete; only the send is withheld.
      if (resolved.mode !== 'live') return
      for (const record of records) {
        if (record.kind === 'decision' && record.action === 'revive') {
          sendNudge(record.sessionId, record.plannedAt ?? Date.now(), record.code)
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
      if (event.type === 'turn/end') {
        const at = typeof event.time === 'number' ? event.time : Date.now()
        const reason = event.data.reason
        if (reason.kind === 'error') {
          const origin = session.header.origin
          // 拍板⑩: the folded request header is the route the failing request
          // used — the wall route a later `model/selection` is compared against.
          const header = session.requestHeader()
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
        if (reason.kind === 'aborted') {
          park(at, sessionId, 'human-abort', { cancel: reason.reason.kind })
          for (const record of policy.onSuccess(sessionId, at)) log(record)
          return
        }
        if (PARKED_TURN_END_REASONS.has(reason.kind)) {
          park(at, sessionId, reason.kind)
          for (const record of policy.onSuccess(sessionId, at)) log(record)
          return
        }
        for (const record of policy.onSuccess(sessionId, at)) log(record)
        return
      }
      if (event.type === 'assistant/message') {
        const usage = event.data.usage
        if (usage !== undefined) {
          policy.recordUsage(sessionId, usage.inputTokens + (usage.cacheReadTokens ?? 0))
        }
        return
      }
      // 拍板⑩ 墙随路由走: a durable route switch releases a wall suspension
      // and rejoins the flow as a revive-class death (auto-route's `switch`
      // lands as this event; the revive plugin stays the single nudge hand,
      // so the quota account has exactly one writer).
      if (event.type === 'model/selection') {
        const at = typeof event.time === 'number' ? event.time : Date.now()
        const { provider, model } = event.data
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
          return
        }
        if (change.operation === 'complete') {
          park(at, sessionId, 'goal-complete')
          return
        }
      }
    })
    const offDisposed = ctx.on('session/disposed', (session: Session) => {
      policy.forget(String(session.id))
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
    const disposeRoute = ctx.webServer.register(
      makeStatusRoute(() => ({ mode: resolved.mode, ...policy.snapshot(Date.now()) })),
    )
    armWake()

    // 拍板⑪ boot sweep: at activation the plugin actively scans for orphan
    // turns instead of waiting for events — the `interrupted` closer only
    // lands at the next resume, so an idle killed session never emits one
    // (design §4.2 条3). Confirmed orphans are attributed to the restart
    // (only process death leaves a turn open) and wake through this same
    // applyRecords/sendNudge path: staggered, breaker-armed, watermark-
    // checked, and quota-exempt (status counters/quota 零增).
    void runBootSweep({
      listRows: makeListRows(ctx.sessionController as unknown as SweepListApi),
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
      decide: (sessionId, at, contextTokens) => {
        // Fold the orphan's last observed usage first so the 150k watermark
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
      for (const timer of sendTimers) clearTimeout(timer)
      sendTimers.clear()
      abort.abort()
      try {
        disposeRoute()
      } catch {
        // Route fiber already gone during shutdown.
      }
    }
  }, 'dsh-session-revive: revival policy')
})
