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
 * caller input can steer). Routes are loopback-fenced; the browser roster is
 * untouched (host-only package).
 */
export const apply = mountOnce('dsh-session-dispatch', (ctx: Context, config?: Config): void => {
  if (Config(config).enabled === false) return
  ctx.effect(() => {
    const store = new FileBindingStore(defaultStorePaths(resolveDshHome()))
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
      }),
      // Delivery onto an existing Session: queue-only by construction.
      makeSessionSendRoute({ sessions }),
    ]
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
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
