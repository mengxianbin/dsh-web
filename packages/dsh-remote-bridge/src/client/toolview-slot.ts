/**
 * The one seam through which this package registers its keyed Tool view.
 *
 * `tool.call.toolview` is declared by `@deepseek-ai/dsh-client-ui-tool`
 * (`lib/types/client/contract/slots.d.ts`). That package is not installed in this
 * workspace, so its types cannot be imported — a type-only import would itself be
 * a new dependency, and a local `declare module` extension of the SDK's `SlotMap`
 * would duplicate a contract another package owns and collide with the real
 * declaration wherever both are loaded. This module therefore narrows
 * `ctx.slots` to the two members the registration needs and states the slot's own
 * shape locally:
 *
 * - the slot is keyed and session-scoped, and its key is the wire Tool name
 *   (`ui_present`), which is what makes one registration draw the card's body
 *   without shadowing the official `tool-call` renderer;
 * - the owner publishes the call identity plus a stage union, mirrored here from
 *   the upstream `ToolCallPhaseProps`: `preparing`, `start` and `result`. The
 *   row reads the arguments at every stage but `result`, which is the only arm
 *   that carries the result node.
 *
 * Upstream changing that shape is a change to this file: the phase names, the
 * keyed dispatch and the `locale` seat are the three facts the mirror carries.
 *
 * Technical debt, recorded rather than hidden: when this package next takes a
 * dependency pass, adding `@deepseek-ai/dsh-client-ui-tool` as a devDependency
 * lets this seam be replaced by `PropsRuntime<'tool.call.toolview'>` and by the
 * typed `ctx.slots.register` overload directly.
 * @module dsh-remote-bridge/client/toolview-slot
 */

import type { ComponentType } from 'react'
import { UiPresentRow, type UiPresentRowProps } from './UiPresentRow.tsx'

/** The keyed Tool view slot the official row dispatches into. */
export const TOOLVIEW_SLOT = 'tool.call.toolview'

/** The wire Tool name this package renders: the keyed cell it claims. */
export const PRESENT_TOOL = 'ui_present'

/** The registration options this seam needs. */
export interface ToolviewRegistration {
  /** Exact SlotMap key. */
  readonly name: 'tool.call.toolview'
  /** Keyed cell: the wire Tool name the owner dispatches by. */
  readonly key: string
  /** Dictionary namespace the render machinery synthesizes `t` from. */
  readonly locale: string
}

/** The narrowed face of `ctx.slots` this package uses. */
export interface ToolviewSlotPort {
  /** Run `seats` once the slot is declared; drop them if the declarer leaves. */
  inject(name: string, seats: () => (() => void) | Iterable<() => void>): void
  /** Contribute one view to one keyed cell; the answer is its disposer. */
  register(options: ToolviewRegistration, view: ComponentType<UiPresentRowProps>): () => void
}

/** The host this seam needs: the client Context, structurally. */
export interface ToolviewSlotHost {
  readonly slots: unknown
}

/**
 * Contribute the `ui_present` card into the Tool row.
 *
 * The contribution is declaration-aware: `inject` waits for the official slot
 * declaration, so a GUI composed without a Tool layer has no keyed cell and thus
 * no card — that is the capability being absent, not an error to report. A
 * registration refused by the registry (an occupied cell at the same priority)
 * is swallowed the same way it is for this package's other seat, so one occupied
 * slot never takes the sidebar entry down with it.
 * @param host - the client Context.
 * @param locale - the dictionary namespace this package registered.
 */
export function registerPresentToolview(host: ToolviewSlotHost, locale: string): void {
  const slots = host.slots as unknown as ToolviewSlotPort
  slots.inject(TOOLVIEW_SLOT, () => {
    try {
      return slots.register({ name: TOOLVIEW_SLOT, key: PRESENT_TOOL, locale }, UiPresentRow)
    } catch {
      return () => {}
    }
  })
}
