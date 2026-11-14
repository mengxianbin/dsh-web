/**
 * Host loader entry for the browser-view plugin — runs in the DSH host process.
 *
 * Mounts three surfaces and nothing else:
 *
 * - the status route and the panel WebSocket under /api/dsh-browser-view,
 * - the ten `browser_*` agent tools,
 * - one lazily started Chromium that both share (src/host/service.ts).
 *
 * No system-prompt announcement: the repository requires an `announceToAgent`
 * switch (default off) before a plugin injects anything into every agent's
 * prompt, and this version ships no announcement at all, so there is no switch
 * to add yet. The tools describe themselves.
 *
 * Shutdown order matters: the service stops broadcasting and closes the panel
 * sockets first, then stops the screencast, then kills Chrome. A panel that
 * received a frame from an already-dying browser would show a frozen image and
 * no reason for it.
 *
 * @module @linxin666/dsh-client-ui-browser-view
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { BrowserViewService } from './host/service.ts'
import { makeRoutes } from './host/routes.ts'
import { createBrowserTools, type DurableImageRef } from './host/tools.ts'

/** Stable cordis plugin name. */
export const name = 'browser-view'

/** Services required before the routes and the tools can mount. */
export const inject = ['webServer', 'tools']

/**
 * The attachment service as this package uses it. Typed structurally: the
 * attachment SDK package is not a dependency of this one, and the shape needed
 * here is one method.
 */
interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<DurableImageRef>
}

/**
 * The connection service as this package uses it. Typed structurally for the
 * same reason as the attachment store: the connection SDK package is not a
 * dependency of this one, and the shape needed here is one method — the
 * process launch-token URL a navigation to DSH's own auth page is retried
 * with.
 */
interface ConnectionLike {
  authenticatedUrl(baseUrl: string): string
}

/**
 * Mount the routes, the tools, and the browser lifetime.
 * @param ctx - host plugin context carrying webServer and tools.
 */
export function apply(ctx: Context): void {
  const service = new BrowserViewService({
    // Resolved per navigation, not at mount: the connection service owns the
    // process launch token, may mount after this plugin, and answers with a
    // URL that is only good for this process. A host that mounts none simply
    // keeps showing the authentication page.
    authenticatedUrl: (url: string) => {
      const connection = ctx.get('connection') as ConnectionLike | undefined
      if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return undefined
      try {
        return connection.authenticatedUrl(url)
      } catch {
        return undefined
      }
    },
  })

  // Resolved per call, not at mount: the screenshot tool must see the
  // attachment service whenever the host happens to mount it.
  const saveImage = async (input: { data: Uint8Array; mediaType: 'image/jpeg'; name?: string }): Promise<DurableImageRef> => {
    const attachments = ctx.get('attachments') as AttachmentStoreLike | undefined
    if (attachments === undefined || typeof attachments.saveImage !== 'function') {
      throw new Error('browser_screenshot needs the host attachment service to store the image; this host mounts none')
    }
    return await attachments.saveImage(input)
  }

  const { routes, upgrade } = makeRoutes({ backend: service })
  const tools = createBrowserTools({ service, saveImage })

  ctx.effect(() => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade)
    return () => {
      for (const dispose of disposers) dispose()
      upgradeDisposer()
    }
  }, 'browser-view: routes')

  ctx.effect(() => {
    const disposers = tools.map(tool => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'browser-view: tools')

  // One disposer for the whole browser: it stops the broadcast, the stream, the
  // protocol socket, and the process, in that order.
  ctx.effect(() => () => { void service.dispose() }, 'browser-view: browser')
}
