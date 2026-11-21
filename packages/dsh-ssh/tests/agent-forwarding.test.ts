/**
 * Agent forwarding end to end, against the embedded ssh2 server: the engine
 * must request forwarding exactly once per session channel when a host opts in,
 * never when it does not, and must surface a server refusal instead of
 * silently running an unforwarded session (issue #1851, AllowAgentForwarding no).
 *
 * The local endpoint here is a fake absolute path that is never dialed: the
 * test server accepts the request but never opens the agent channel backward,
 * so no real ssh-agent is required on the machine running the tests.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SshEngine } from '../src/engine.ts'
import { HostStore } from '../src/store.ts'
import type { HostPayload } from '../src/protocol.ts'
import { TEST_PASSWORD, TEST_USER, TestSshServer } from './helpers/ssh-server.ts'

let server: TestSshServer
let store: HostStore
let engine: SshEngine
let agentDir: string
/** Distinctive fake endpoint: nothing ever listens here. */
let fakeAgentPath: string
let previousAuthSock: string | undefined

function addHost(alias: string, overrides: Partial<HostPayload> = {}): void {
  store.create({
    alias,
    host: '127.0.0.1',
    port: server.port,
    user: TEST_USER,
    auth: { kind: 'password', password: TEST_PASSWORD },
    ...overrides,
  } as HostPayload)
}

beforeAll(async () => {
  server = await TestSshServer.start()
  store = new HostStore(join(mkdtempSync(join(tmpdir(), 'dsh-ssh-agent-store-')), 'hosts.json'))
  engine = new SshEngine(store, { idleTimeoutMs: 60_000, connectTimeoutMs: 5_000, defaultExecTimeoutMs: 5_000 })
  agentDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-agent-endpoint-'))
  fakeAgentPath = join(agentDir, 'forward-agent.sock')
})

beforeEach(() => {
  // Pin the local endpoint for every case so a developer machine's real agent
  // can neither satisfy nor mask the resolution.
  previousAuthSock = process.env.SSH_AUTH_SOCK
  process.env.SSH_AUTH_SOCK = fakeAgentPath
  server.acceptAgentForwarding = true
})

afterEach(() => {
  if (previousAuthSock === undefined) delete process.env.SSH_AUTH_SOCK
  else process.env.SSH_AUTH_SOCK = previousAuthSock
  server.acceptAgentForwarding = true
})

afterAll(async () => {
  engine.dispose()
  await server.stop()
  rmSync(agentDir, { recursive: true, force: true })
})

describe('agent forwarding over a live connection', () => {
  it('member running a command on a forwarding host sends one session-scoped agent request', async () => {
    // Given a host that opts into agent forwarding
    addHost('forward-exec', { forwardAgent: true })
    const before = server.agentRequests

    // When one command runs on it
    const result = await engine.exec('forward-exec', 'echo hello')

    // Then the command succeeds and the session asked to forward once
    expect(result.success).toBe(true)
    expect(result.stdout).toContain('hello')
    expect(server.agentRequests - before).toBe(1)
  })

  it('member opening a shell on a forwarding host sends one session-scoped agent request', async () => {
    // Given a host that opts into agent forwarding
    addHost('forward-shell', { forwardAgent: true })
    const before = server.agentRequests

    // When a PTY shell session opens on it
    const session = await engine.openShell('forward-shell', { cols: 80, rows: 24 })
    try {
      // Then the shell channel carried the forwarding request exactly once
      expect(server.agentRequests - before).toBe(1)
    } finally {
      session.close()
    }
  })

  it('member running commands on a host without the opt-in sends no agent request', async () => {
    // Given a host created without the forwarding flag
    addHost('no-forward-exec')
    const before = server.agentRequests

    // When a command runs on it
    const result = await engine.exec('no-forward-exec', 'echo hello')

    // Then nothing was forwarded for the session
    expect(result.success).toBe(true)
    expect(server.agentRequests - before).toBe(0)
  })

  it('member opening a shell on a host without the opt-in sends no agent request', async () => {
    // Given a host created without the forwarding flag
    addHost('no-forward-shell')
    const before = server.agentRequests

    // When a PTY shell session opens on it
    const session = await engine.openShell('no-forward-shell', { cols: 80, rows: 24 })
    try {
      // Then the shell channel requested no forwarding
      expect(server.agentRequests - before).toBe(0)
    } finally {
      session.close()
    }
  })

  it('operator whose server refuses agent forwarding sees the server error instead of a silent success', async () => {
    // Given a forwarding host and a server that refuses the request
    // (AllowAgentForwarding no on a real sshd)
    addHost('forward-refused', { forwardAgent: true })
    server.acceptAgentForwarding = false
    const before = server.agentRequests

    // When a command runs on it
    const run = engine.exec('forward-refused', 'echo hello')

    // Then the refusal surfaces as an error, not as an unforwarded success
    await expect(run).rejects.toThrow(/agent forwarding/i)
    expect(server.agentRequests - before).toBe(1)

    // And once the server allows forwarding again the host recovers
    server.acceptAgentForwarding = true
    const recovered = await engine.exec('forward-refused', 'echo hello')
    expect(recovered.success).toBe(true)
  })
})
