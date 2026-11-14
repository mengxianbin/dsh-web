import { describe, expect, it } from 'vitest'
import { createRemoteBridgeFace, RemoteBridgeRegistry } from '../src/core/extension.ts'
import { CAP_AGENTS, SERVED_CAPABILITIES } from '../src/core/protocol.ts'
import { answerOf, makeBareHub, makeConnection, makeHub, RecordingTransport, requestFrame } from './support/harness.ts'

/** Capability the demo tables in this suite require. */
const DEMO_CAP = 'demo.v1'

/** Capability the board plugin requires, the surface this seam was built for. */
const BOARD_CAP = 'board.v1'

/** Greet the bridge so the connection records the capabilities it declares. */
async function greet(connection: { handleText(text: string): Promise<void> }, id: number, cap: readonly string[]): Promise<void> {
  await connection.handleText(requestFrame(id, 'hello', { proto: 1, cap: [...cap] }))
}

/** The capability list one greeting was answered with. */
function capabilitiesOfAnswer(harness: Parameters<typeof answerOf>[0], id: number): string[] {
  return (answerOf(harness, id).r as { capabilities: string[] }).capabilities
}

describe('the extension seam registry', () => {
  it('operator registers a method table and a declaring client reaches it', () => {
    // Given a registry and a table that requires a capability
    const registry = new RemoteBridgeRegistry()
    const handler = (): { ok: true; r: unknown } => ({ ok: true, r: { echoed: true } })
    registry.registerMethods({ capability: DEMO_CAP, methods: { 'demo.echo': handler } })
    // When a client that declared the capability asks for the method
    const resolved = registry.handlerFor('demo.echo', capability => capability === DEMO_CAP)
    // Then the plugin's own handler answers, and the name is known to the registry
    expect(resolved).toBe(handler)
    expect(registry.has('demo.echo')).toBe(true)
  })

  it('operator withdraws a plugin table and the methods stop existing', () => {
    // Given a registered table
    const registry = new RemoteBridgeRegistry()
    const dispose = registry.registerMethods({ methods: { 'demo.echo': () => ({ ok: true }) } })
    // When the plugin is unmounted
    dispose()
    // Then neither the dispatch gate nor the handler lookup sees the name any more
    expect(registry.has('demo.echo')).toBe(false)
    expect(registry.handlerFor('demo.echo', () => true)).toBeUndefined()
  })

  it('operator withdraws the same table twice and the method registered later survives', () => {
    // Given one plugin table that was withdrawn, and a second one registered after it
    const registry = new RemoteBridgeRegistry()
    const first = registry.registerMethods({ methods: { 'demo.echo': () => ({ ok: true }) } })
    first()
    const second = () => ({ ok: true as const, r: 'second' })
    registry.registerMethods({ methods: { 'demo.echo': second } })
    // When the stale disposer runs again
    first()
    // Then the later plugin's method is untouched
    expect(registry.handlerFor('demo.echo', () => true)).toBe(second)
  })

  it('operator registers a table naming a protocol method and the registration is refused', () => {
    // Given a registry and a table that tries to shadow the handshake
    const registry = new RemoteBridgeRegistry()
    // When it registers
    const register = (): (() => void) => registry.registerMethods({ methods: { 'session.list': () => ({ ok: true }) } })
    // Then the name is refused instead of changing protocol v1 silently
    expect(register).toThrow(/is a protocol method/)
    expect(registry.has('session.list')).toBe(false)
  })

  it('operator registers a name another plugin already owns and the registration is refused', () => {
    // Given a method a first plugin already registered
    const registry = new RemoteBridgeRegistry()
    registry.registerMethods({ methods: { 'demo.echo': () => ({ ok: true, r: 1 }) } })
    // When a second plugin claims the same name
    const register = (): (() => void) => registry.registerMethods({ methods: { 'demo.echo': () => ({ ok: true, r: 2 }) } })
    // Then it is refused, and the first plugin's handler still answers
    expect(register).toThrow(/already registered/)
    expect((registry.handlerFor('demo.echo', () => true) as () => unknown)()).toEqual({ ok: true, r: 1 })
  })

  it('operator registers a table with one unusable name and none of its methods are registered', () => {
    // Given a table whose second entry shadows a protocol method
    const registry = new RemoteBridgeRegistry()
    // When it registers
    const register = (): (() => void) => registry.registerMethods({
      methods: { 'demo.echo': () => ({ ok: true }), hello: () => ({ ok: true }) },
    })
    // Then the whole table is refused, so a partial registration cannot survive
    expect(register).toThrow(/is a protocol method/)
    expect(registry.has('demo.echo')).toBe(false)
  })

  it('operator registers a table without a capability and a paired client needs none to reach it', () => {
    // Given a table registered without a capability
    const registry = new RemoteBridgeRegistry()
    const open = (): { ok: true } => ({ ok: true })
    registry.registerMethods({ methods: { 'demo.open': open } })
    // When a client that declared nothing asks for it
    // Then the method is still reachable
    expect(registry.handlerFor('demo.open', () => false)).toBe(open)
  })
})

describe('extension methods over a connection', () => {
  it('user declares the capability and reads the answer the plugin gave', async () => {
    // Given a plugin method that answers a payload echo
    const harness = makeConnection({ paired: true })
    harness.extensions.registerMethods({
      capability: DEMO_CAP,
      methods: { 'demo.echo': payload => ({ ok: true, r: { seen: payload.value } }) },
    })
    await greet(harness.connection, 1, [DEMO_CAP])
    // When the client calls it
    await harness.connection.handleText(requestFrame(2, 'demo.echo', { value: 'x' }))
    // Then the plugin's answer is the response body, and the bridge called no host endpoint
    expect(answerOf(harness, 2)).toEqual({ ok: true, r: { seen: 'x' } })
    expect(harness.gateway.invocations).toEqual([])
  })

  it('user never declares the capability and the method does not exist for it', async () => {
    // Given a registered method and a greeting that declares nothing
    const harness = makeConnection({ paired: true })
    harness.extensions.registerMethods({ capability: DEMO_CAP, methods: { 'demo.echo': () => ({ ok: true }) } })
    await greet(harness.connection, 1, [])
    // When the client calls the method
    await harness.connection.handleText(requestFrame(2, 'demo.echo'))
    // Then the answer is the same refusal an invented method gets
    expect(answerOf(harness, 2).e?.code).toBe('unknown-method')
  })

  it('user calls a plugin method on an unpaired connection and is refused as unpaired', async () => {
    // Given a registered method and a connection carrying no device token
    const harness = makeConnection()
    harness.extensions.registerMethods({ capability: DEMO_CAP, methods: { 'demo.echo': () => ({ ok: true }) } })
    await greet(harness.connection, 1, [DEMO_CAP])
    // When it calls the method
    await harness.connection.handleText(requestFrame(2, 'demo.echo'))
    // Then pairing is required first: declaring the capability grants nothing
    expect(answerOf(harness, 2).e?.code).toBe('unpaired')
  })

  it('user calls a method after the plugin withdrew it and is refused as unknown', async () => {
    // Given a method that was registered and then withdrawn
    const harness = makeConnection({ paired: true })
    const dispose = harness.extensions.registerMethods({ capability: DEMO_CAP, methods: { 'demo.echo': () => ({ ok: true }) } })
    await greet(harness.connection, 1, [DEMO_CAP])
    dispose()
    // When the client calls it
    await harness.connection.handleText(requestFrame(2, 'demo.echo'))
    // Then the method is gone from the protocol again
    expect(answerOf(harness, 2).e?.code).toBe('unknown-method')
  })

  it('user reads the refusal code and message the plugin itself stated', async () => {
    // Given a method that refuses with a code this bridge has never heard of
    const harness = makeConnection({ paired: true })
    harness.extensions.registerMethods({
      capability: DEMO_CAP,
      methods: { 'demo.refuse': () => ({ ok: false, code: 'demo-refused', msg: 'the demo said no' }) },
    })
    await greet(harness.connection, 1, [DEMO_CAP])
    // When the client calls it
    await harness.connection.handleText(requestFrame(2, 'demo.refuse'))
    // Then the plugin's own vocabulary crosses untouched
    expect(answerOf(harness, 2)).toEqual({ ok: false, e: { code: 'demo-refused', msg: 'the demo said no' } })
  })

  it('user reads an internal failure when the plugin throws instead of a lost frame', async () => {
    // Given a method whose handler throws
    const harness = makeConnection({ paired: true })
    harness.extensions.registerMethods({
      capability: DEMO_CAP,
      methods: { 'demo.boom': () => { throw new Error('plugin exploded') } },
    })
    await greet(harness.connection, 1, [DEMO_CAP])
    // When the client calls it
    await harness.connection.handleText(requestFrame(2, 'demo.boom'))
    // Then the call still has an answer, and the failure is the bridge's own code
    const answer = answerOf(harness, 2)
    expect(answer.ok).toBe(false)
    expect(answer.e?.code).toBe('internal')
    expect(answer.e?.msg).toBe('plugin exploded')
    expect(harness.logs.some(line => line.includes('demo.boom failed'))).toBe(true)
  })

  it('user reads an internal failure when the plugin answers no result at all', async () => {
    // Given a handler that returns something the seam does not define
    const harness = makeConnection({ paired: true })
    harness.extensions.registerMethods({
      capability: DEMO_CAP,
      methods: { 'demo.nothing': () => undefined as never },
    })
    await greet(harness.connection, 1, [DEMO_CAP])
    // When the client calls it
    await harness.connection.handleText(requestFrame(2, 'demo.nothing'))
    // Then the answer names the missing result rather than dropping the frame
    expect(answerOf(harness, 2).e).toEqual({ code: 'internal', msg: 'demo.nothing answered no result' })
  })

  it('user calls twice on one socket and once on another and the plugin sees a stable per-connection id', async () => {
    // Given a method that reports which connection called it
    const harvester = makeConnection({ paired: true })
    const seen: string[] = []
    harvester.extensions.registerMethods({
      capability: DEMO_CAP,
      methods: { 'demo.who': (_payload, call) => { seen.push(call.connectionId); return { ok: true, r: call.connectionId } } },
    })
    await greet(harvester.connection, 1, [DEMO_CAP])
    // When one socket calls twice and a second socket calls once
    await harvester.connection.handleText(requestFrame(2, 'demo.who'))
    await harvester.connection.handleText(requestFrame(3, 'demo.who'))
    const other = makeConnection({ paired: true, extensions: harvester.extensions })
    await greet(other.connection, 4, [DEMO_CAP])
    await other.connection.handleText(requestFrame(5, 'demo.who'))
    // Then the id is the per-connection scope a plugin keys its own state by
    expect(seen[0]).toBe(seen[1])
    expect(seen[2]).not.toBe(seen[0])
  })
})

describe('the seam event fan-out', () => {
  /** Attach one connection to the hub and greet it. */
  async function attach(hub: ReturnType<typeof makeBareHub>, paired: boolean, cap: readonly string[]): Promise<RecordingTransport> {
    const transport = new RecordingTransport()
    const connection = hub.hub.attach(transport, paired ? { deviceId: 'dev_fanout' } : undefined)
    await greet(connection, 1, cap)
    return transport
  }

  it('operator publishes an event and only the paired connections that declared the capability take it', async () => {
    // Given one declared, one undeclared and one unpaired connection
    const hub = makeBareHub()
    const declared = await attach(hub, true, [DEMO_CAP])
    const undeclared = await attach(hub, true, [])
    const unpaired = await attach(hub, false, [DEMO_CAP])
    const face = createRemoteBridgeFace(hub.extensions, hub.hub)
    // When the plugin publishes under its own topic and its own capability
    const delivered = face.broadcast('demo.changed', { revision: 7 }, DEMO_CAP)
    // Then exactly the declaring paired connection received it
    expect(delivered).toBe(1)
    expect(declared.ofType('ev')).toEqual([{ t: 'ev', seq: 1, m: 'demo.changed', p: { revision: 7 } }])
    expect(undeclared.ofType('ev')).toEqual([])
    expect(unpaired.ofType('ev')).toEqual([])
  })

  it('operator publishes without a capability and every paired connection takes it while no unpaired one does', async () => {
    // Given a paired and an unpaired connection that declared nothing
    const hub = makeBareHub()
    const paired = await attach(hub, true, [])
    const unpaired = await attach(hub, false, [])
    const face = createRemoteBridgeFace(hub.extensions, hub.hub)
    // When the plugin publishes without naming a capability
    const delivered = face.broadcast('demo.open', { revision: 1 })
    // Then pairing alone decides who receives it
    expect(delivered).toBe(1)
    expect(paired.ofType('ev')).toHaveLength(1)
    expect(unpaired.ofType('ev')).toEqual([])
  })

  it('user receives the plugin payload verbatim under the plugin topic name', async () => {
    // Given a paired declaring connection
    const hub = makeBareHub()
    const transport = await attach(hub, true, [DEMO_CAP])
    const face = createRemoteBridgeFace(hub.extensions, hub.hub)
    const payload = { revision: 3, note: { nested: ['a', 1, null] } }
    // When the plugin publishes that payload
    face.broadcast('demo.board.changed', payload, DEMO_CAP)
    // Then the bridge neither renames nor reshapes it
    expect(transport.ofType('ev')).toEqual([{ t: 'ev', seq: 1, m: 'demo.board.changed', p: payload }])
  })
})

describe('the capability registry the bridge reads', () => {
  it('operator reads the capabilities of an empty registry and gets none', () => {
    // Given a bridge no plugin has registered on
    const registry = new RemoteBridgeRegistry()
    // When the registry is asked what a client would have to declare
    // Then there is nothing to announce
    expect(registry.capabilities()).toEqual([])
  })

  it('operator reads the capabilities of two tables in the order the wire expects', () => {
    // Given two plugins whose capabilities arrive in the reverse of their names
    const registry = new RemoteBridgeRegistry()
    registry.registerMethods({ capability: 'zulu.v1', methods: { 'zulu.list': () => ({ ok: true }) } })
    registry.registerMethods({ capability: 'alpha.v1', methods: { 'alpha.list': () => ({ ok: true }) } })
    // When the registry is read
    // Then the names are deduplicated and ascending, so mounting order cannot
    // reach the wire
    expect(registry.capabilities()).toEqual(['alpha.v1', 'zulu.v1'])
  })

  it('operator withdraws the last table holding a capability and the name is gone', () => {
    // Given two tables gated by the same capability
    const registry = new RemoteBridgeRegistry()
    const first = registry.registerMethods({ capability: BOARD_CAP, methods: { 'board.snapshot': () => ({ ok: true }) } })
    const second = registry.registerMethods({ capability: BOARD_CAP, methods: { 'board.apply': () => ({ ok: true }) } })
    // When the first one is withdrawn
    // Then the capability is still there, because a registered method requires it
    first()
    expect(registry.capabilities()).toEqual([BOARD_CAP])
    // When the last one is withdrawn too
    second()
    // Then the name is gone with it
    expect(registry.capabilities()).toEqual([])
  })

  it('operator registers a table without a capability and the registry announces none', () => {
    // Given a table whose methods are open to every paired client
    const registry = new RemoteBridgeRegistry()
    registry.registerMethods({ methods: { 'demo.open': () => ({ ok: true }) } })
    // When the registry is read
    // Then a client has nothing to declare, so nothing is advertised
    expect(registry.capabilities()).toEqual([])
  })
})

describe('the capabilities a hello advertises', () => {
  it('user greets a bridge with no extension mounted and reads exactly the served capabilities', async () => {
    // Given a bridge nothing registered on
    const harness = makeConnection({ paired: true })
    // When a client greets it
    await greet(harness.connection, 1, [])
    // Then the answer is the protocol's own list, unchanged: an empty registry
    // adds nothing and reorders nothing
    expect(capabilitiesOfAnswer(harness, 1)).toEqual([...SERVED_CAPABILITIES])
  })

  it('user greets a bridge whose plugin registered board.v1 and finds board.v1 advertised', async () => {
    // Given a plugin that gated its methods behind the board capability
    const harness = makeConnection({ paired: true })
    harness.extensions.registerMethods({ capability: BOARD_CAP, methods: { 'board.snapshot': () => ({ ok: true }) } })
    // When a client greets the bridge
    await greet(harness.connection, 1, [])
    // Then the capability the plugin requires is announced, so a client can tell
    // this host serves the board from one that does not
    const capabilities = capabilitiesOfAnswer(harness, 1)
    expect(capabilities).toContain(BOARD_CAP)
    // And the protocol's own names are still there, in their own order, in front
    expect(capabilities.slice(0, SERVED_CAPABILITIES.length)).toEqual([...SERVED_CAPABILITIES])
  })

  it('user greets again after the plugin withdrew its table and board.v1 is no longer advertised', async () => {
    // Given a greeting that announced the plugin's capability
    const harness = makeConnection({ paired: true })
    const dispose = harness.extensions.registerMethods({ capability: BOARD_CAP, methods: { 'board.snapshot': () => ({ ok: true }) } })
    await greet(harness.connection, 1, [])
    expect(capabilitiesOfAnswer(harness, 1)).toContain(BOARD_CAP)
    // When the plugin is unmounted and the same socket greets again
    dispose()
    await greet(harness.connection, 2, [])
    // Then the name is withdrawn with it, because the list is computed on every
    // greeting rather than frozen when the bridge was built
    expect(capabilitiesOfAnswer(harness, 2)).toEqual([...SERVED_CAPABILITIES])
  })

  it('user greets a bridge where two tables require the same capability and reads it once', async () => {
    // Given two plugins that gate on the same capability
    const harness = makeConnection({ paired: true })
    harness.extensions.registerMethods({ capability: BOARD_CAP, methods: { 'board.snapshot': () => ({ ok: true }) } })
    harness.extensions.registerMethods({ capability: BOARD_CAP, methods: { 'board.apply': () => ({ ok: true }) } })
    // When a client greets the bridge
    await greet(harness.connection, 1, [])
    // Then the name appears exactly once
    const capabilities = capabilitiesOfAnswer(harness, 1)
    expect(capabilities.filter(name => name === BOARD_CAP)).toHaveLength(1)
  })

  it('user greets a connection the hub attached and reads the capability the plugin registered first', async () => {
    // Given a hub whose registry already holds a plugin table, and a connection
    // the hub itself built
    const hub = makeHub()
    hub.extensions.registerMethods({ capability: BOARD_CAP, methods: { 'board.snapshot': () => ({ ok: true }) } })
    // When that connection greets the bridge
    await greet(hub.connection, 1, [])
    // Then the registry reached the greeting through the hub's own injection,
    // which is the only path a real bridge takes
    expect(capabilitiesOfAnswer(hub, 1)).toContain(BOARD_CAP)
  })

  it('user greets a bridge whose plugin gates on a capability the protocol already serves and reads that name once', async () => {
    // Given a plugin that requires a capability this bridge serves itself
    const harness = makeConnection({ paired: true })
    harness.extensions.registerMethods({ capability: CAP_AGENTS, methods: { 'demo.presets': () => ({ ok: true }) } })
    // When a client greets the bridge
    await greet(harness.connection, 1, [])
    // Then the union lists it once, in the position the protocol gave it
    expect(capabilitiesOfAnswer(harness, 1)).toEqual([...SERVED_CAPABILITIES])
  })
})
