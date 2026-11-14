/**
 * Non-throwing reads of the optional cordis services this package probes.
 *
 * A fiber may read only a service it injected: any other property read throws
 * `cannot get property "<name>" without inject` from the cordis resolve trap,
 * which turns an optional probe into a fatal mount error. `ctx.get` looks the
 * service up without that requirement and answers undefined when this
 * deployment does not serve it.
 *
 * @module @linxin666/dsh-agents/host/services
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Read one optional service through the context accessor.
 *
 * `requireActive` defaults to false on purpose: a plain property read never
 * consulted the providing fiber's state, so gating on it here would make an
 * optional face depend on plugin load order. Pass true only where the caller
 * wants a service whose provider has already finished loading.
 * @param ctx - the mounting context.
 * @param name - the cordis service name.
 * @param requireActive - keep only implementations whose providing fiber is active.
 * @returns the service value, or undefined when this deployment does not serve it.
 */
export function readService<T>(ctx: Context, name: string, requireActive = true): T | undefined {
  try {
    const get = (ctx as { get?: (service: string, strict?: boolean) => unknown }).get
    return typeof get === 'function' ? get.call(ctx, name, requireActive) as T | undefined : undefined
  } catch {
    return undefined
  }
}
