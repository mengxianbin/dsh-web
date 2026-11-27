import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import { join } from 'node:path'
import z from 'schemastery'
import { mountOnce } from './mount-once.ts'
import { resolveDshHome } from './dsh-home.ts'
import { defaultStorePaths, FileBindingStore, canonicalSessionId } from './host/bindings.ts'
import { AttentionLedger, defaultAttentionPath, type AttentionRegistry } from './host/attention.ts'
import { createClassProjection } from './host/class-projection.ts'
import { makeDispatchRoutes, makeSessionSendRoute, makeSessionStopRoute, type DispatchSessionApi } from './host/routes.ts'
import { makeLoopbackFsmSeam } from './host/fsm-seam.ts'
import { createTurnEndFsmSync } from './host/turn-end-fsm.ts'
import { TaskbotBossGate } from './host/boss-gate.ts'
import { SteerAckTracker } from './host/steer-ack.ts'

export const name = 'dsh-session-dispatch'
export const inject = ['webServer', 'sessionController', 'workspaceRegistry']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the dispatch routes (default true). */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
})

/**
 * Pure-REST session dispatch: `POST /api/session-dispatch` creates a Session
 * pinned to a named Workspace through the Host's own session service and
 * queues its first prompt, answering `{ ok: true, sessionId }`. A dispatch
 * that carries an opaque `taskRef` additionally records a task-to-session
 * binding in the quick ledger (`$DSH_HOME/dispatch-bindings.json`) and is
 * refused with 409 while that taskRef still has a live session;
 * `GET /api/session-dispatch/bindings` serves the ledger with live aliveness.
 * `POST /api/session-send` delivers one prompt onto an existing Session:
 * `queue` (the default, the pre-field wire semantic) waits for the current
 * turn, `steer` injects at the current turn's next step boundary (idle or
 * stopped Sessions keep the wake-turn path). Every delivered `steer` is
 * ACK-tracked from delivery to the model's first response as one structured
 * `[steer-ack]` line. `POST /api/session-stop` cancels an existing
 * Session's active turn — the pending inbox survives, so the Session can be
 * woken again through session-send — and logs one structured audit line for
 * the optional caller-supplied `actor` (audit-only, never steering). Every dispatch also declares its `sessionClass`
 * (`human` default; `bot-boss` for bot duty sessions; `bot-worker` for
 * bot-dispatched task work; the legacy `bot` spelling normalizes to
 * `bot-worker`) into the attention ledger (`$DSH_HOME/session-attention.json`),
 * and the ledger applies each Session's default pin state exactly once —
 * startup pass over workspace members, dispatch declaration at creation,
 * first real user message as the fallback; after that a manual pin/unpin is
 * never overridden. Every persisted class is additionally folded into the
 * `sessionClass` Session projection (live appends through the ledger seam, a
 * boot backfill for Sessions that predate the record), so the value rides
 * `SessionSummary.projectionValues` — the list channel the hover card reads. Routes are loopback-fenced; the browser roster is
 * untouched (host-only package).
 */
export const apply = mountOnce('dsh-session-dispatch', (ctx: Context, config?: Config): void => {
  if (Config(config).enabled === false) return
  ctx.effect(() => {
    const dshHome = resolveDshHome()
    const store = new FileBindingStore(defaultStorePaths(dshHome))
    // The `sessionClass` fold (sessionclass-summary-channel-1127): every
    // ledger write pushes the class onto the live Session's log, and the
    // boot backfill mirrors the recorded classes onto cold Sessions so the
    // hover line reads the list snapshot on the same channel as the id.
    const classProjection = createClassProjection(ctx)
    // Mount first: the backfill below must see the unit registered, or a
    // cold refold would write a checkpoint without the `sessionClass` row.
    const projectionMounted = classProjection.mount()
    const attention = new AttentionLedger({
      // Structural view of the Host registry: the real registry brands its
      // SessionId, which the ledger accepts as plain strings (same cast
      // convention as the session controller below).
      registry: ctx.workspaceRegistry as unknown as AttentionRegistry,
      attentionPath: defaultAttentionPath(dshHome),
      onClassSettled: (sessionId, sessionClass) => classProjection.syncById(sessionId, sessionClass),
    })
    // Startup pass enqueues first, so every later trigger serializes behind
    // it: current workspace members without a record get the human default
    // once, pending defaults are retried. Fail-open — the per-session
    // triggers below still cover anything this pass could not settle.
    // The backfill rides the same chain: after the pass settles the ledger
    // and the fold is mounted, mirror every recorded class into its Session
    // log (fast-path skip per Session; per-Session fail-open; quiet when the
    // profile serves no persistence/cache services).
    void (async () => {
      await attention.startupPass().catch(() => {})
      await projectionMounted
      const classes = await attention.classes().catch(() => undefined)
      if (classes !== undefined) await classProjection.backfill(classes).catch(() => {})
    })()
    // Structural view of the Host session service: the real controller
    // brands requestId/sessionId, which the routes mint as plain strings.
    const sessions = ctx.sessionController as unknown as DispatchSessionApi
    // ACK bookkeeping for delivered steers: the route records delivery, the
    // session/event stream below supplies injection + first response.
    const steerAck = new SteerAckTracker()
    const routes = [
      ...makeDispatchRoutes({
        sessions,
        workspaces: ctx.workspaceRegistry,
        // The permission pin is optional: composed only when the profile mounts
        // the agent registry and the slash-command registry.
        agents: ctx.get('agents'),
        commands: ctx.get('commands'),
        // The quick ledger: taskRef bindings + the 409 dedupe gate.
        bindings: store,
        // The attention ledger: sessionClass records + default-pin application.
        attention,
        // Boss gate + halt wake (dispatch-gate-halt-wake-1121): reads the
        // taskbot checkpoint ($DSH_HOME/taskbot-state.json — same file the
        // SKILL in-position reading and the watchdog use), refuses bot-worker
        // dispatches while a stale halt wedge is provable, and clears a
        // leftover halt so the self-heal chain re-arms.
        bossGate: new TaskbotBossGate({ statePath: join(dshHome, 'taskbot-state.json') }),
        // E1 task-fsm seam (fsm-seam-archive-build-1125 S1 方案 A): every
        // taskRef-with-anchor dispatch registers + passes E1 through loopback
        // self-calls before a session exists (G1/G2/G3 同 dispatch-send.mjs);
        // synthetic anchors (no '#') and bot-boss dispatches are exempt.
        fsm: makeLoopbackFsmSeam(),
      }),
      // Delivery onto an existing Session: queue by default, steer on request.
      makeSessionSendRoute({ sessions }, { steerAck }),
      // Turn cancellation on an existing Session: inbox-preserving abort.
      makeSessionStopRoute({ sessions }),
    ]
    const disposers = routes.map((route) => ctx.webServer.register(route))
    // C leg — host-side full-coverage FSM entry (fsm-turnend-wire-1126 §3.3):
    // every session's `turn/end` reconciles its ledger-bound taskRef into the
    // FSM (absent → create+E1 入机 / backlog → E1 推进 / past backlog → no-op),
    // covering the trees where the Stop hook cannot run. Same entry judgment
    // as the A leg (exemptions → scope → create/E1), loopback through the very
    // seam dispatch uses. ⛔ No new config key: this rides the existing plugin,
    // so it lands on the next dsh web restart — 生效重启归人，本单不自行重启。
    const turnEndFsm = createTurnEndFsmSync(ctx, {
      // Quick ledger, read-only through the store's own list() — ⛔ no binding
      // semantics are touched (that surface belongs to #bindings-retire-1126).
      // Latest row wins: a re-dispatched session points at its newest taskRef.
      resolveTaskRef: async (sessionId) => {
        const id = canonicalSessionId(sessionId)
        const rows = await store.list().catch(() => [])
        let hit: string | undefined
        for (const row of rows) {
          if (canonicalSessionId(row.sessionId) === id) hit = row.taskRef
        }
        return hit
      },
      // bot-boss exemption parity with the dispatch seam (防分裂).
      resolveClass: async (sessionId) =>
        (await attention.classes().catch(() => undefined))?.[sessionId],
      fsm: makeLoopbackFsmSeam(),
      origin: () => ctx.webServer.getOrigin(),
    })
    turnEndFsm.start()
    // First real user message is the classification fallback: a Session the
    // startup pass and its dispatch never covered (created in the UI mid-run)
    // gets the human default here. The membership gate lives in the ledger,
    // so subagent children, side threads, and forks are never pinned.
    const disposeEvents = ctx.on('session/event', (session, event) => {
      // ACK pairing runs first and is fail-open inside the tracker; it must
      // not be skipped by the attention gate below.
      steerAck.observe(String(session.id), event)
      if (event.type !== 'user/message') return
      if (event.data.source.kind !== 'user') return
      void attention.ensureFirstMessage(String(session.id)).catch(() => {})
    })
    return () => {
      turnEndFsm.stop() // idempotent teardown (spec ③)
      classProjection.dispose()
      disposeEvents()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Route fiber already gone during shutdown.
        }
      }
    }
  }, 'dsh-session-dispatch: routes')
})
