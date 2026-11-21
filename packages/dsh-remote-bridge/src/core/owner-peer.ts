/**
 * The in-process owner peer every gateway call of this bridge speaks for.
 *
 * The 0.2.1 gateway made `peer` mandatory on every request, and the
 * authorization layer reads only `peer.principal`: `{ kind: 'owner' }` is how
 * host-local code states that the call IS the local user driving their own
 * Host, so the gateway answers it directly instead of running a remote-access
 * decision (only non-owner principals are judged).
 * @module dsh-remote-bridge/core/owner-peer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GatewayPeer } from './wire.ts'

/**
 * Mint the in-process owner peer this bridge's Host calls speak for.
 *
 * The bridge's security model states that pairing is a full-control
 * credential: a paired device reaches the harness in-process — sessions,
 * prompts, approvals. Protocol v1 is therefore deliberately paired with the
 * one principal that preserves the pre-0.2.1 capability of the bridge's own
 * in-process calls: the owner. That claim is safe only because of WHERE this
 * peer is attached:
 *
 * - Every gateway call a connection can trigger sits behind the bridge's own
 *   pairing gate: dispatch answers `unpaired` before any session, approval or
 *   roster work, and the three unpaired methods (`hello`, `pair.begin`,
 *   `pair.finish`) never invoke the gateway at all. The owner peer crosses to
 *   the harness only after a connection proved a device token (or just
 *   enrolled one), never for an unpaired one.
 * - No wire field can set a principal: the connection never reads a `peer`
 *   or `principal` (or any identity) out of a client frame. The peer is minted
 *   here, in-process, fixed at `{ kind: 'owner' }`, and a client that names
 *   one in its payload is ignored — the call still speaks for this peer.
 *
 * `interactions` stays `'none'`: the bridge only invokes unary methods and
 * opens the `session/follow` business stream. The gateway's interactions
 * check gates exactly the forwarded-event endpoints (opening an event stream,
 * answering a waterfall), which this caller never touches; an `'answer'`
 * peer would additionally receive forwarded Host events, a capability the
 * bridge neither needs nor wants — approvals reach devices through this
 * plugin's own `approval/request` listener and the protocol's own events, not
 * through a Typert forwarded-event subscription.
 *
 * The peer's signal aborts once `ctx` disposes, so calls and streams opened
 * for it end with the plugin fiber, and `dispose()` is idempotent with racing
 * calls sharing one completion. The id carries no credential — the protocol
 * fixes `principal` as the only identity persisted in a session log — so a
 * fresh unique id per mount is sufficient.
 */
export function createOwnerPeer(ctx: Context): GatewayPeer {
  const controller = new AbortController()
  let completion: Promise<void> | undefined
  const peer: GatewayPeer = {
    id: `remote-bridge-owner:${crypto.randomUUID()}` as GatewayPeer['id'],
    ctx,
    principal: { kind: 'owner' },
    signal: controller.signal,
    interactions: 'none',
    dispose() {
      if (completion === undefined) {
        controller.abort()
        completion = Promise.resolve()
      }
      return completion
    },
  }
  ctx.effect(() => () => { void peer.dispose() }, 'remote-bridge owner peer')
  return peer
}
