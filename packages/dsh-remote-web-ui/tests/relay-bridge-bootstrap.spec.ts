/**
 * Where the lease claim is planned. The bridge rides the lease, not the tunnel:
 * a bridge-mode instance must reach its Durable Object even when no quick
 * tunnel runs, and the plan that runs none used to be the one that disposed the
 * whole relay half (a desktop profile whose same-id row was dropped resolves
 * `autoTunnel: false`, so the host never claimed, the object never got a
 * socket, and the edge answered `x-relay-fallback: no-connector` for as long
 * as the host lived).
 *
 * The wiring facts are pinned in the source body, the same idiom as
 * port-unbound.spec.ts: applying `apply` needs a live Host, and this file is
 * about which branch owns the claim.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
const bridgeSource = readFileSync(join(here, '..', 'src', 'relay-bridge-connector.ts'), 'utf8')

/**
 * The body of one top-level const declaration inside applyImpl, found by brace
 * balance from its opening brace.
 * @param name - the local const's name.
 * @returns the function body source, without the closing brace.
 */
function bodyOf(name: string): string {
  const head = new RegExp('const ' + name + ' = \\([^)]*\\): void => \\{')
  const match = head.exec(source)
  if (match === null) throw new Error('no ' + name + ' declaration in src/index.ts')
  const start = match.index + match[0].length - 1
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start + 1, i)
    }
  }
  throw new Error('unbalanced braces after ' + name)
}

describe('the lease is claimed for the transport, not for the tunnel', () => {
  it('operator: the settings sync claims the lease whatever the tunnel plan did', () => {
    // Given the sync that applies the tunnel plan
    // When the plan runs no quick tunnel (autoTunnel off, a manual tunnel, or
    // a named target)
    // Then the claim still runs: it sits after the plan, guarded by the relay
    // toggle and the master switch, not by `plan.mode === 'quick'`
    const sync = bodyOf('sync')
    const plan = sync.indexOf('applyTunnelPlan(value, livePort)')
    const claim = sync.indexOf('claimRelayLeaseFor(livePort, publicBase.quickUrl())')
    expect(plan).toBeGreaterThan(-1)
    expect(claim).toBeGreaterThan(plan)
    expect(sync).toContain('value.enabled && value.relay !== false')
    expect(sync).toContain('schedulePortSettleRetry()')
  })

  it('operator: the claim has one home, so a settings sync cannot double it', () => {
    // Given the two places that used to (or could) claim
    // When the plan is read
    // Then the plan branch no longer claims: the sync owns the trigger, and
    // the quick tunnel's phase event re-claims a newly minted URL through the
    // same deduped helper
    expect(bodyOf('applyTunnelPlan')).not.toContain('claimRelayLeaseFor(')
    expect(bodyOf('claimRelayLeaseFor')).toContain('relayClaimedFor === key')
  })

  it('operator: a plan without a quick tunnel stops announcing but keeps the lease', () => {
    // Given the plan branch that runs no quick tunnel
    // When the bridge is the transport that serves the phone
    // Then only the announce half goes; the lease half survives, and the whole
    // half is dropped only when the relay toggle itself is off
    const plan = bodyOf('applyTunnelPlan')
    const announcerOnly = plan.indexOf('disposeRelayAnnouncer()')
    const wholeHalf = plan.indexOf('if (value.relay === false) disposeRelayHalf(true)')
    expect(announcerOnly).toBeGreaterThan(-1)
    expect(wholeHalf).toBeGreaterThan(announcerOnly)
    expect(plan).not.toContain('disposeRelayRegistrar')
  })

  it('operator: the lease named connector stays the quick tunnel sibling', () => {
    // Given a claim made with no quick tunnel to serve
    // When the pair reports the accepted lease
    // Then it does not spawn the named cloudflared child: claiming for the
    // bridge grant must not start a second tunnel behind the operator's back
    expect(source).toContain('if (namedConnectorWanted) namedRelayConnector.start(token, hostname)')
    expect(bodyOf('applyTunnelPlan')).toContain("namedConnectorWanted = plan.mode === 'quick'")
  })

  it('operator: the connector records its state by default', () => {
    // Given the runner the host builds
    // When the Desktop host gives the plugin no readable stdout
    // Then the state lands in $DSH_HOME/remote-web-ui-relay-bridge.json unless
    // a caller asks for memory only
    expect(bridgeSource).toContain('options.stateFile === undefined ? relayBridgeStateFile()')
    expect(bridgeSource).toContain("join(home, 'remote-web-ui-relay-bridge.json')")
  })
})
