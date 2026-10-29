import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import z from 'schemastery'
import { mountOnce } from './mount-once.ts'
import { resolveDshHome } from './dsh-home.ts'
import { defaultStorePaths, FileBindingStore } from './host/bindings.ts'
import { AttentionLedger, defaultAttentionPath, type AttentionRegistry } from './host/attention.ts'
import { makeDispatchRoutes, makeSessionSendRoute, type DispatchSessionApi } from './host/routes.ts'

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
 * `POST /api/session-send` queues one prompt onto an existing Session with
 * the fixed queue semantic (the wire shape has no delivery-mode field, so no
 * caller input can steer). Every dispatch also declares its `sessionClass`
 * (`human` default, `bot` for bot-dispatched task work) into the attention
 * ledger (`$DSH_HOME/session-attention.json`), and the ledger applies each
 * Session's default pin state exactly once — startup pass over workspace
 * members, dispatch declaration at creation, first real user message as the
 * fallback; after that a manual pin/unpin is never overridden. Routes are
 * loopback-fenced; the browser roster is untouched (host-only package).
 */
export const apply = mountOnce('dsh-session-dispatch', (ctx: Context, config?: Config): void => {
  if (Config(config).enabled === false) return
  ctx.effect(() => {
    const dshHome = resolveDshHome()
    const store = new FileBindingStore(defaultStorePaths(dshHome))
    const attention = new AttentionLedger({
      // Structural view of the Host registry: the real registry brands its
      // SessionId, which the ledger accepts as plain strings (same cast
      // convention as the session controller below).
      registry: ctx.workspaceRegistry as unknown as AttentionRegistry,
      attentionPath: defaultAttentionPath(dshHome),
    })
    // Startup pass enqueues first, so every later trigger serializes behind
    // it: current workspace members without a record get the human default
    // once, pending defaults are retried. Fail-open — the per-session
    // triggers below still cover anything this pass could not settle.
    void attention.startupPass().catch(() => {})
    // Structural view of the Host session service: the real controller
    // brands requestId/sessionId, which the routes mint as plain strings.
    const sessions = ctx.sessionController as unknown as DispatchSessionApi
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
      }),
      // Delivery onto an existing Session: queue-only by construction.
      makeSessionSendRoute({ sessions }),
    ]
    const disposers = routes.map((route) => ctx.webServer.register(route))
    // First real user message is the classification fallback: a Session the
    // startup pass and its dispatch never covered (created in the UI mid-run)
    // gets the human default here. The membership gate lives in the ledger,
    // so subagent children, side threads, and forks are never pinned.
    const disposeEvents = ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      if (event.data.source.kind !== 'user') return
      void attention.ensureFirstMessage(String(session.id)).catch(() => {})
    })
    return () => {
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
