/**
 * The bridge's extension seam: the one place another plugin adds methods and
 * events to protocol v1 without the bridge learning what they mean.
 *
 * The bridge publishes this seam as the cordis service
 * {@link REMOTE_BRIDGE_SERVICE}. A plugin registers a table of methods plus the
 * capability a client must declare before those methods exist for it, and
 * publishes events to the clients that declared the capability it names.
 * Nothing here carries protocol vocabulary of its own: method names, payloads,
 * topics and refusal codes belong to the registering plugin, which is why this
 * module never appears in `KNOWN_METHODS` and never reads a payload.
 *
 * A connection dispatches an extension method only after the protocol's own
 * gates: an unregistered name, a plugin that is not mounted, and a client that
 * never declared the capability all answer `unknown-method` — the method is
 * absent from that client's protocol, not refused by it.
 * @module dsh-remote-bridge/core/extension
 */

import type { RemoteBridgeDeltas } from './delta.ts'
import { KNOWN_METHODS } from './protocol.ts'

/** Cordis service this seam is published under. */
export const REMOTE_BRIDGE_SERVICE = 'remoteBridge'

/**
 * Who is calling one extension method.
 *
 * The bridge exposes no device or session identity here on purpose: what an
 * extension keys by connection is its own decision.
 */
export interface RemoteBridgeCall {
  /**
   * Stable identity of the calling connection, unique within this bridge
   * process. Two calls from one socket carry the same id; a reconnected socket
   * carries a new one, because nothing proves it is the same peer.
   */
  readonly connectionId: string
  /**
   * @param capability - one capability name of this protocol or of the calling
   * extension.
   * @returns whether this connection announced it in `hello`.
   *
   * The seam hands handlers the same predicate the bridge itself gates on, so
   * an extension can gate behind a bridge capability (§15's `delta.v1`) without
   * holding a copy of the client's declaration.
   */
  declares(capability: string): boolean
  /**
   * This connection's delta windows, released with the connection.
   *
   * The mechanism of §15 lives once, in this bridge, and an extension borrows it
   * per connection: the difference is always computed where the last answer is
   * already held, and a dropped connection takes its base with it instead of
   * leaving one to be expired by a second registry.
   */
  readonly deltas: RemoteBridgeDeltas
}

/**
 * What one extension method answers: the response body, or a refusal stated in
 * the extension's own code vocabulary. The bridge forwards either verbatim —
 * it holds no table of extension codes and invents none.
 */
export type RemoteBridgeMethodResult =
  | { readonly ok: true; readonly r?: unknown }
  | { readonly ok: false; readonly code: string; readonly msg: string }

/** One client-callable method an extension owns. */
export type RemoteBridgeMethodHandler = (
  payload: Readonly<Record<string, unknown>>,
  call: RemoteBridgeCall,
) => RemoteBridgeMethodResult | Promise<RemoteBridgeMethodResult>

/** A table of methods and the capability that admits a client to them. */
export interface RemoteBridgeMethods {
  /**
   * Capability a client declares in `hello`'s `cap` array before these methods
   * are part of its protocol. Absent means every paired connection may call
   * them; an unpaired connection never may, whatever it declared.
   */
  readonly capability?: string
  /** Method name to handler; the name is the extension's, not the bridge's. */
  readonly methods: Readonly<Record<string, RemoteBridgeMethodHandler>>
}

/** The seam, exactly as published on {@link REMOTE_BRIDGE_SERVICE}. */
export interface RemoteBridgeFace {
  /**
   * Add methods to the protocol surface.
   * @returns the disposer withdrawing them; afterwards they answer `unknown-method` again.
   */
  registerMethods(table: RemoteBridgeMethods): () => void
  /**
   * Publish one event to the connections that are paired — and, when a
   * capability is named, have declared it.
   * @returns how many connections took the frame.
   */
  broadcast(topic: string, payload: unknown, capability?: string): number
}

/** The fan-out the seam publishes through; `BridgeHub` satisfies it. */
export interface RemoteBridgeFanout {
  broadcast(topic: string, payload: unknown): number
  broadcastTo(capability: string, topic: string, payload: unknown): number
}

/** One registered method. */
interface RegisteredMethod {
  readonly capability: string | undefined
  readonly handler: RemoteBridgeMethodHandler
}

/**
 * The methods extensions registered, and the capability each one needs.
 *
 * Every connection consults this registry; nothing else holds extension state,
 * so unmounting one plugin withdraws exactly its own methods.
 */
export class RemoteBridgeRegistry {
  readonly #methods = new Map<string, RegisteredMethod>()

  /**
   * Register one table of methods, all or nothing: a table naming a protocol
   * method, an empty name or a name already taken is refused before any of its
   * methods becomes callable.
   * @param table - the methods and the capability they require.
   * @returns the disposer withdrawing this table; idempotent.
   */
  registerMethods(table: RemoteBridgeMethods): () => void {
    const entries: [string, RegisteredMethod][] = []
    for (const [name, handler] of Object.entries(table.methods)) {
      if (name.trim() === '') throw new Error('a remote bridge method needs a non-empty name')
      if (typeof handler !== 'function') throw new Error(`remote bridge method ${name} has no handler`)
      // A protocol method is decided by the bridge's own dispatch. Shadowing one
      // here would change protocol v1 without changing its version, so it is
      // refused at registration rather than resolved by dispatch order.
      if (KNOWN_METHODS.has(name)) throw new Error(`remote bridge method ${name} is a protocol method`)
      if (this.#methods.has(name)) throw new Error(`remote bridge method ${name} is already registered`)
      entries.push([name, { capability: table.capability, handler }])
    }
    for (const [name, entry] of entries) this.#methods.set(name, entry)
    return () => {
      for (const [name, entry] of entries) {
        // Identity, not just the name: a table registered after this disposer
        // ran keeps its own method.
        if (this.#methods.get(name) === entry) this.#methods.delete(name)
      }
    }
  }

  /**
   * @param method - the method name a client asked for.
   * @returns whether any plugin registered it, whatever capability it requires.
   */
  has(method: string): boolean {
    return this.#methods.has(method)
  }

  /**
   * The capabilities the registered tables require a client to declare.
   *
   * A table registered without a capability contributes none: nothing gates its
   * methods, so there is nothing for a client to announce. A name stays listed
   * while any registered method still requires it, so withdrawing one table
   * withdraws its capability only when it was the last one holding it. Sorted,
   * because this answer travels on the wire: one set must read the same way
   * whatever order the plugins happened to mount in.
   * @returns the distinct non-blank capabilities, ascending; empty when no
   * extension is registered.
   */
  capabilities(): readonly string[] {
    const names = new Set<string>()
    for (const entry of this.#methods.values()) {
      if (entry.capability !== undefined && entry.capability.trim() !== '') names.add(entry.capability)
    }
    return [...names].sort()
  }

  /**
   * @param method - the method name a client asked for.
   * @param declares - whether the calling connection declared a capability.
   * @returns the handler when the caller may use the method, else undefined.
   */
  handlerFor(method: string, declares: (capability: string) => boolean): RemoteBridgeMethodHandler | undefined {
    const entry = this.#methods.get(method)
    if (entry === undefined) return undefined
    if (entry.capability !== undefined && !declares(entry.capability)) return undefined
    return entry.handler
  }
}

/**
 * Compose the published seam over a registry and a fan-out.
 * @param methods - the registry this bridge owns.
 * @param fanout - the hub's broadcast pair.
 * @returns the face a plugin resolves from {@link REMOTE_BRIDGE_SERVICE}.
 */
export function createRemoteBridgeFace(methods: RemoteBridgeRegistry, fanout: RemoteBridgeFanout): RemoteBridgeFace {
  return {
    registerMethods: table => methods.registerMethods(table),
    broadcast: (topic, payload, capability) => capability === undefined
      ? fanout.broadcast(topic, payload)
      : fanout.broadcastTo(capability, topic, payload),
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The bridge's extension seam, while this package serves protocol v1. A
     * plugin resolves it structurally at use time: requiring it would let the
     * bridge's absence take the registering plugin's start down with it.
     */
    remoteBridge: RemoteBridgeFace
  }
}
