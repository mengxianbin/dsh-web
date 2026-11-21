/**
 * The 0.2.1-rc.2 webServer type leaves `ctx.webServer.port` undefined until
 * the listener binds (a recompose pass can run this apply ahead of the bind).
 * The host half must degrade honestly in that window: the loopback proxies
 * refuse with 503 (remote-api.spec.ts / remote-upgrade.spec.ts), the posture
 * probe skips the round, and the quick tunnel defers to a re-plan instead of
 * minting an http://127.0.0.1:undefined target (tunnel-plan.spec.ts). This
 * file pins those guards inside applyImpl, the same source-body idiom as
 * lan-bind-hmr-nesting.spec.ts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

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

describe('webServer port unsettled (0.2.1-rc.2)', () => {
  it('operator skips the posture round while the port is unbound', () => {
    // Given the posture probe, whose LAN targets and requests need the bound port
    // When the port has not settled yet
    // Then the round is skipped before any target or probe is built — the
    // previous snapshot stays and the next trigger retries
    const probe = bodyOf('runPostureProbe')
    const guard = probe.indexOf('if (port === undefined) return')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(probe.indexOf('postureTargets('))
    expect(guard).toBeLessThan(probe.indexOf('probePosture({'))
  })

  it('operator defers the quick tunnel instead of planning an undefined target', () => {
    // Given the settings sync that applies the tunnel plan
    // When autoTunnel is on while the port is unbound
    // Then the plan branch is deferred behind the port-settle guard (with a
    // retry timer), so sync never plans against an unsettled port
    const syncBody = bodyOf('sync')
    expect(syncBody).toContain('livePort === undefined && value.autoTunnel === true')
    expect(syncBody).toContain('schedulePortSettleRetry()')
    expect(syncBody).not.toContain('tunnelPlanOf(')
    // The retry itself (and its one timer) lives in the helper the tunnel
    // deferral and the lease claim share, so neither can schedule a second one.
    const retry = bodyOf('schedulePortSettleRetry')
    expect(retry).toContain('PORT_SETTLE_RETRY_MS')
    expect(retry).toContain('if (portSettleTimer !== undefined) return')
    // The planner only runs inside the apply helper, behind the guard.
    const apply = bodyOf('applyTunnelPlan')
    expect(apply).toContain('tunnelPlanOf(value, port)')
  })

  it('operator clears the port-settle retry with the tunnel lifecycle', () => {
    // Given the deferral retry timer
    // When the plugin disposes
    // Then the pending timer goes with the tunnel teardown
    const clearAt = source.indexOf('clearTimeout(portSettleTimer)')
    expect(clearAt).toBeGreaterThan(-1)
    // The clear sits inside the auto-tunnel dispose effect, ahead of its label.
    expect(clearAt).toBeLessThan(source.indexOf("'remote-web-ui: auto tunnel'"))
  })
})

/**
 * Issues #1893 and #1917: the managed block pinned a literal the webserver
 * schema rejects, and before that it swallowed the row's own bind expression and
 * the CLI flags altogether. Both failure classes came from writing that row, so
 * the invariant is now structural: nothing in this plugin writes a bind, and the
 * one file operation left - removing the legacy block - runs before every other
 * bind step.
 */
describe('the LAN edge never writes a bind (issues #1893 and #1917)', () => {
  it('operator: no code path writes the web server row any more', () => {
    // Given the host half, source and bind planners alike
    // When the bind writers that used to exist are looked for
    // Then none of them is reachable: the flags reach the official row itself
    // and there is nothing left that could replace it
    expect(source).not.toContain('writeLanBind(')
    expect(source).not.toContain('desiredBindHost(')
    expect(source).not.toContain('managedBlock(')
  })

  it('operator: the legacy cleanup runs before the LAN edge and the firewall', () => {
    // Given the deferred bind worker
    // When its steps are read in order
    // Then the block removal comes first: a surviving block keeps replacing the
    // row's config, so the forwarder must not be planned against a profile that
    // still carries one
    const work = bodyOf('applyLanBindWork')
    const cleanup = work.indexOf('cleanupLegacyBlock(')
    const edge = work.indexOf('applyForwardEdge(')
    const firewall = work.indexOf('ensureFirewallRule(')
    expect(cleanup).toBeGreaterThan(-1)
    expect(edge).toBeGreaterThan(cleanup)
    expect(firewall).toBeGreaterThan(edge)
  })

  it('operator: a bind that cannot be taken is reported, never thrown', () => {
    // Given the LAN edge reconcile
    // When the forwarder start rejects with a bind error (address gone, port
    // taken)
    // Then the failure is logged with its reason and the reconcile continues:
    // the loopback listener is untouched, so the host cannot brick
    const edge = bodyOf('applyForwardEdge')
    expect(edge).toContain('forwarder.start(')
    expect(edge).toContain('could not listen on')
    expect(edge).toContain('loopback access is unaffected')
    expect(edge).not.toContain('throw ')
  })

  it('operator: the CLI --host is honoured by yielding, not by rewriting', () => {
    // Given the LAN edge reconcile
    // When a non-loopback --host already binds the network
    // Then the plan comes back with the yield reason and the forwarder stays
    // off, so the plugin adds no second listener on that address:port
    const edge = bodyOf('applyForwardEdge')
    expect(edge).toContain('forwardPlanOf(value.lanBind, startup?.host, liveCapability)')
    expect(edge).toContain("plan.reason === 'host-bind'")
    expect(edge).toContain('yields that port')
  })

  it('operator: a machine with no LAN address is told instead of silently skipped', () => {
    // Given the same reconcile
    // When the plan reports no address
    // Then one error line names the situation and points at the tunnel
    const edge = bodyOf('applyForwardEdge')
    expect(edge).toContain('no LAN IPv4 address to listen on')
    expect(edge).toContain('use a tunnel instead')
  })
})
