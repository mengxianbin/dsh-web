/**
 * dsh-session-revive — shadow-first automatic session revival. A `turn/end`
 * error with a revive-class code (TRANSPORT/TIMEOUT) enters the ruled revival
 * account: rolling 4h x 4 quota per session chain, wall-class codes suspend
 * at zero cost until resetsAt, a 10-minute breaker stops a session that dies
 * again right after a revival, same-cause waves hold sessions until a 5-minute
 * quiet period then release them staggered, and the 150k context watermark
 * parks oversized sessions. Every detection and decision is one structured
 * JSON log line. `mode: 'shadow'` (the default) suppresses only the send —
 * the full decision account still runs so the ruled parameters can be tuned
 * against a real night of logs; `mode: 'live'` queues the nudge through the
 * host session controller. Host-only package: no `dsh.client` face.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from 'schemastery'
import { NUDGE_TEXT, STAGGER_MIN_MS, Config, resolveConfig } from './config.ts'
import { mountOnce } from './mount-once.ts'
import { RevivalPolicy, type PolicyRecord } from './policy.ts'
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
  ctx.effect(() => {
    const policy = new RevivalPolicy({ staggerMs: resolved.staggerMs })
    const sessions = ctx.sessionController as unknown as ReviveSessionApi
    const abort = new AbortController()
    const sendTimers = new Set<ReturnType<typeof setTimeout>>()
    let wakeTimer: ReturnType<typeof setTimeout> | undefined

    // One structured JSON line per record, stamped with the active mode so a
    // grep can split shadow evidence from live sends.
    const log = (record: PolicyRecord): void => {
      ctx.logger.info(`dsh-session-revive ${JSON.stringify({ mode: resolved.mode, ...record })}`)
    }

    const sendNudge = (sessionId: string, plannedAt: number): void => {
      const delay = Math.max(0, plannedAt - Date.now())
      const timer = setTimeout(() => {
        sendTimers.delete(timer)
        void sessions
          .prompt(
            {
              requestId: `session-revive-${randomUUID()}`,
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: NUDGE_TEXT }],
            },
            abort.signal,
          )
          .then(() => {
            log({ kind: 'log', at: Date.now(), event: 'nudge-sent', sessionId })
          })
          .catch((error: unknown) => {
            log({
              kind: 'log',
              at: Date.now(),
              event: 'nudge-failed',
              sessionId,
              detail: { error: String(error).slice(0, 300) },
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
          sendNudge(record.sessionId, record.plannedAt ?? Date.now())
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

    const offEvent = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const sessionId = String(session.id)
      if (event.type === 'turn/end') {
        const at = typeof event.time === 'number' ? event.time : Date.now()
        const reason = event.data.reason
        if (reason.kind === 'error') {
          const origin = session.header.origin
          applyRecords(
            policy.onError({
              sessionId,
              code: reason.error.code,
              ...(reason.error.providerRetryAfterMs === undefined
                ? {}
                : { providerRetryAfterMs: reason.error.providerRetryAfterMs }),
              at,
              ...(typeof origin === 'string' ? { origin } : {}),
            }),
          )
          armWake()
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
      }
    })
    const offDisposed = ctx.on('session/disposed', (session: Session) => {
      policy.forget(String(session.id))
    })
    const disposeRoute = ctx.webServer.register(
      makeStatusRoute(() => ({ mode: resolved.mode, ...policy.snapshot(Date.now()) })),
    )
    armWake()

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
